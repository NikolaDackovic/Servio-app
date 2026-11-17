import {
  Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Module, Post, Query, Req, UnauthorizedException, ForbiddenException, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { and, asc, eq, ne, or } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { devices, locations, roles, users } from '../../db/schema';
import { AuthUser, CurrentUser, JwtPayload, Public } from '../../common/auth-context';
import { cardLookup, verifySecret, pinLookup } from '../../common/security';
import { AppConfig, CONFIG } from '../../config';

class PasswordLoginDto {
  /** Email ili korisničko ime (ADMIN prijava). */
  @IsString() @Length(1, 200) email: string;
  @IsString() @Length(1, 200) password: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsUUID() deviceId?: string;
}

class PinLoginDto {
  @IsUUID() deviceId: string;
  /** PIN (1-10 cifara) ili broj kartice sa čitača (6-32 slova/cifre) */
  @Matches(/^(\d{1,10}|[0-9A-Za-z]{6,32})$/, { message: 'PIN ima 1-10 cifara' }) pin: string;
}

class DefaultLoginDto { @IsUUID() deviceId: string; }
class AdminPinDto {
  @Matches(/^(\d{1,10}|[0-9A-Za-z]{6,32})$/, { message: 'Šifra: 1-10 cifara' }) pin: string;
}

/** Zaključavanje kase posle uzastopnih pogrešnih PIN-ova (uspešne prijave nisu ograničene - PIN se kuca za svaki sto). */
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 60_000;

@Injectable()
export class AuthService {
  private readonly pinFails = new Map<string, { fails: number; until: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private async issue(userId: string, org: string, loc: string, dev: string | null) {
    const payload: JwtPayload = { sub: userId, org, loc, dev };
    const [u] = await this.db
      .select({ fullName: users.fullName, roleCode: roles.code, permissions: roles.permissions })
      .from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.id, userId));
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: userId, fullName: u.fullName, role: u.roleCode, permissions: u.permissions },
      organizationId: org, locationId: loc, deviceId: dev,
    };
  }

  async passwordLogin(dto: PasswordLoginDto) {
    const login = dto.email.trim().toLowerCase();
    const candidates = await this.db.select().from(users).where(or(eq(users.email, login), eq(users.username, login)));
    // Ista poruka za nepostojeći nalog i pogrešnu lozinku (bez otkrivanja postojanja naloga).
    const fail = () => new UnauthorizedException('Pogrešno korisničko ime ili lozinka');
    let user: typeof candidates[number] | undefined;
    for (const c of candidates) {
      if (c.active && (await verifySecret(dto.password, c.passwordHash))) { user = c; break; }
    }
    if (!user) throw fail();

    let locationId = dto.locationId;
    if (locationId) {
      const [loc] = await this.db.select({ id: locations.id }).from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.organizationId, user.organizationId)));
      if (!loc) throw new UnauthorizedException('Lokal ne pripada vašoj organizaciji');
    } else {
      const [first] = await this.db.select({ id: locations.id }).from(locations)
        .where(eq(locations.organizationId, user.organizationId)).orderBy(asc(locations.createdAt)).limit(1);
      if (!first) throw new UnauthorizedException('Organizacija nema nijedan lokal');
      locationId = first.id;
    }

    let deviceId: string | null = null;
    if (dto.deviceId) {
      const [dev] = await this.db.select({ id: devices.id }).from(devices)
        .where(and(eq(devices.id, dto.deviceId), eq(devices.locationId, locationId), eq(devices.active, true), ne(devices.kind, 'BRIDGE')));
      if (!dev) throw new UnauthorizedException('Uređaj ne pripada izabranom lokalu');
      deviceId = dev.id;
    }
    return this.issue(user.id, user.organizationId, locationId, deviceId);
  }

  /**
   * Kasa jednog lokala: kada u sistemu postoji tačno jedan lokal, kasa ne traži registraciju uređaja
   * (email, lozinka, izbor kase) - odmah nudi PIN prijavu na prvoj aktivnoj kasi tog lokala.
   * Mapa i artikli su isti za sve zaposlene; ko radi, određuje PIN. Sa više lokala vraća null
   * i ostaje postojeći postupak registracije uređaja.
   */
  async defaultKasa(kind: 'POS' | 'KDS' = 'POS') {
    const locs = await this.db.select({ id: locations.id, name: locations.name }).from(locations).limit(2);
    if (locs.length !== 1) return { device: null };
    const list = await this.db.select({ id: devices.id, name: devices.name }).from(devices)
      .where(and(eq(devices.locationId, locs[0].id), eq(devices.active, true), eq(devices.kind, kind)))
      .orderBy(asc(devices.name));
    const dev = list[0];
    // više kasa u lokalu: kasa (pregledač ili dodatni računar) jednom bira koja je
    return { device: dev ? { id: dev.id, name: dev.name, location: locs[0].name } : null, devices: list.map((d) => ({ ...d, location: locs[0].name })) };
  }

  async pinLogin(dto: PinLoginDto) {
    const [dev] = await this.db
      .select({ id: devices.id, locationId: devices.locationId, org: locations.organizationId, active: devices.active, kind: devices.kind })
      .from(devices).innerJoin(locations, eq(locations.id, devices.locationId)).where(eq(devices.id, dto.deviceId));
    // Print Bridge nije uređaj za prijavu zaposlenih (ima sopstveni API ključ).
    if (!dev || !dev.active || dev.kind === 'BRIDGE') throw new UnauthorizedException('Uređaj nije registrovan ili nije aktivan');

    const f = this.pinFails.get(dev.id);
    if (f && f.until > Date.now()) {
      throw new HttpException(`Previše pogrešnih šifri. Pokušajte ponovo za ${Math.ceil((f.until - Date.now()) / 1000)} s`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const lookup = pinLookup(dto.pin, this.cfg.pinPepper);
    let [user] = await this.db.select().from(users)
      .where(and(eq(users.organizationId, dev.org), eq(users.pinLookup, lookup), eq(users.active, true)));
    let ok = !!user && (await verifySecret(dto.pin, user.pinHash));
    if (!ok && dto.pin.length >= 6) {
      // kartica prislonjena na čitač (čitač "kuca" broj kartice kao tastatura)
      [user] = await this.db.select().from(users)
        .where(and(eq(users.organizationId, dev.org), eq(users.cardLookup, cardLookup(dto.pin, this.cfg.pinPepper)), eq(users.active, true)));
      ok = !!user;
    }
    if (!user || !ok) {
      const fails = (f && f.until === 0 ? f.fails : 0) + 1;
      this.pinFails.set(dev.id, fails >= PIN_MAX_FAILS ? { fails: 0, until: Date.now() + PIN_LOCK_MS } : { fails, until: 0 });
      throw new UnauthorizedException('Pogrešan PIN');
    }
    this.pinFails.delete(dev.id);
    return this.issue(user.id, dev.org, dev.locationId, dev.id);
  }

  /**
   * ADMIN prijava samo šifrom (PIN ili kartica), bez korisničkog imena - kao na kasi.
   * Pušta samo naloge koji imaju neko pravo ADMIN-a (konobar sa PIN-om ne ulazi u ADMIN).
   */
  /** Kasa sa podrazumevanim korisnikom (ADMIN → Podešavanje računara): prijava bez šifre. */
  async defaultLogin(deviceId: string) {
    const [dev] = await this.db
      .select({ id: devices.id, locationId: devices.locationId, org: locations.organizationId, active: devices.active, kind: devices.kind, settings: devices.settings })
      .from(devices).innerJoin(locations, eq(locations.id, devices.locationId)).where(eq(devices.id, deviceId));
    const uid = (dev?.settings as { defaultUserId?: string | null } | null)?.defaultUserId;
    if (!dev || !dev.active || dev.kind !== 'POS' || !uid) throw new UnauthorizedException('Ova kasa nema podrazumevanog korisnika');
    const [user] = await this.db.select().from(users).where(and(eq(users.id, uid), eq(users.organizationId, dev.org), eq(users.active, true)));
    if (!user) throw new UnauthorizedException('Podrazumevani korisnik ne postoji ili nije aktivan');
    return this.issue(user.id, dev.org, dev.locationId, dev.id);
  }

  async adminPinLogin(dto: { pin: string }, ip = '') {
    const key = `admin:${ip}`;
    const f = this.pinFails.get(key);
    if (f && f.until > Date.now()) {
      throw new HttpException(`Previše pogrešnih šifri. Pokušajte ponovo za ${Math.ceil((f.until - Date.now()) / 1000)} s`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const lookup = pinLookup(dto.pin, this.cfg.pinPepper);
    let cands = await this.db.select().from(users).where(and(eq(users.pinLookup, lookup), eq(users.active, true)));
    cands = (await Promise.all(cands.map(async (c) => ((await verifySecret(dto.pin, c.pinHash)) ? c : null)))).filter((c): c is NonNullable<typeof c> => !!c);
    if (!cands.length && dto.pin.length >= 6) {
      cands = await this.db.select().from(users).where(and(eq(users.cardLookup, cardLookup(dto.pin, this.cfg.pinPepper)), eq(users.active, true)));
    }
    const user = cands[0];
    if (!user) {
      const fails = (f && f.until === 0 ? f.fails : 0) + 1;
      this.pinFails.set(key, fails >= PIN_MAX_FAILS ? { fails: 0, until: Date.now() + PIN_LOCK_MS } : { fails, until: 0 });
      throw new UnauthorizedException('Pogrešna šifra');
    }
    this.pinFails.delete(key);
    // u ADMIN ulazi svako šifrom; šta vidi i otvara određuju prava uloge (ostale stavke menija su posivljene)
    const [first] = await this.db.select({ id: locations.id }).from(locations)
      .where(eq(locations.organizationId, user.organizationId)).orderBy(asc(locations.createdAt)).limit(1);
    if (!first) throw new UnauthorizedException('Organizacija nema nijedan lokal');
    return this.issue(user.id, user.organizationId, first.id, null);
  }

  async context(u: AuthUser) {
    const locs = await this.db.select({ id: locations.id, name: locations.name, timezone: locations.timezone })
      .from(locations).where(eq(locations.organizationId, u.organizationId)).orderBy(asc(locations.name));
    const devs = await this.db.select({ id: devices.id, name: devices.name, kind: devices.kind })
      .from(devices).where(and(eq(devices.locationId, u.locationId), eq(devices.active, true), ne(devices.kind, 'BRIDGE'))).orderBy(asc(devices.name));
    return { user: u, locations: locs, devices: devs };
  }
}

@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Public() @Post('login') @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: PasswordLoginDto) {
    return this.svc.passwordLogin(dto);
  }

  @Public() @Post('default-login') @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  defaultLogin(@Body() dto: DefaultLoginDto) {
    return this.svc.defaultLogin(dto.deviceId);
  }

  @Public() @Post('pin') @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  pin(@Body() dto: PinLoginDto) {
    return this.svc.pinLogin(dto);
  }

  @Public() @Post('admin-pin') @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  adminPin(@Body() dto: AdminPinDto, @Req() req: { ip?: string }) {
    return this.svc.adminPinLogin(dto, req.ip ?? '');
  }

  /** Kasa ili KDS ekran lokala (?kind=KDS za adresu /kds). */
  @Public() @Get('kasa')
  kasa(@Query('kind') kind?: string) {
    return this.svc.defaultKasa(kind === 'KDS' ? 'KDS' : 'POS');
  }

  @ApiBearerAuth() @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.svc.context(u);
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
