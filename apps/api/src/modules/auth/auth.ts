import {
  Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { and, asc, eq, ne } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { devices, locations, roles, users } from '../../db/schema';
import { AuthUser, CurrentUser, JwtPayload, Public } from '../../common/auth-context';
import { verifySecret, pinLookup } from '../../common/security';
import { AppConfig, CONFIG } from '../../config';

class PasswordLoginDto {
  @IsEmail() email: string;
  @IsString() @Length(1, 200) password: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsUUID() deviceId?: string;
}

class PinLoginDto {
  @IsUUID() deviceId: string;
  @Matches(/^\d{4,8}$/, { message: 'PIN mora imati 4–8 cifara' }) pin: string;
}

@Injectable()
export class AuthService {
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
    const candidates = await this.db.select().from(users).where(eq(users.email, dto.email.toLowerCase()));
    // Ista poruka za nepostojeći nalog i pogrešnu lozinku (bez otkrivanja postojanja naloga).
    const fail = () => new UnauthorizedException('Pogrešan email ili lozinka');
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

  async pinLogin(dto: PinLoginDto) {
    const [dev] = await this.db
      .select({ id: devices.id, locationId: devices.locationId, org: locations.organizationId, active: devices.active, kind: devices.kind })
      .from(devices).innerJoin(locations, eq(locations.id, devices.locationId)).where(eq(devices.id, dto.deviceId));
    // Print Bridge nije uređaj za prijavu zaposlenih (ima sopstveni API ključ).
    if (!dev || !dev.active || dev.kind === 'BRIDGE') throw new UnauthorizedException('Uređaj nije registrovan ili nije aktivan');

    const lookup = pinLookup(dto.pin, this.cfg.pinPepper);
    const [user] = await this.db.select().from(users)
      .where(and(eq(users.organizationId, dev.org), eq(users.pinLookup, lookup), eq(users.active, true)));
    if (!user || !(await verifySecret(dto.pin, user.pinHash))) throw new UnauthorizedException('Pogrešan PIN');
    return this.issue(user.id, dev.org, dev.locationId, dev.id);
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

  @Public() @Post('pin') @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  pin(@Body() dto: PinLoginDto) {
    return this.svc.pinLogin(dto);
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
