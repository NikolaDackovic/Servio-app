import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Injectable, Module, Post, Req } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createDefaultUsers, DEFAULT_LOGINS } from '../../db/default-users';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { and, asc, eq, sql } from 'drizzle-orm';
import { hashKey } from '../prep/prep';
import { DB, Db } from '../../db/db.module';
import * as s from '../../db/schema';
import { Public } from '../../common/auth-context';
import { DEFAULT_ROLES } from '../../common/permissions';
import { hashSecret, pinLookup } from '../../common/security';
import { Conflict } from '../../common/errors';
import { AppConfig, CONFIG } from '../../config';
import { seed } from '../../db/seed';

class LocalBridgeDto { @IsString() @Length(1, 60) name: string; }

class SetupDto {
  /** NEW = nova radnja (podaci firme i administrator); DEMO = demo podaci za probu. */
  @IsIn(['NEW', 'DEMO']) mode: 'NEW' | 'DEMO';
  @ValidateIf((d) => d.mode === 'NEW') @IsString() @Length(2, 120) companyName?: string;
  @ValidateIf((d) => d.mode === 'NEW') @Matches(/^\d{9}$/, { message: 'PIB ima 9 cifara' }) pib?: string;
  @ValidateIf((d) => d.mode === 'NEW') @IsString() @Length(2, 120) storeName?: string;
  @IsOptional() @IsString() @Length(0, 160) address?: string;
}

/**
 * Prvo pokretanje instalirane kase: dok u bazi nema nijedne firme, kasa prikazuje ekran za podatke firme
 * i administratora (ili demo podatke). Posle toga ovi pozivi više ne rade (409) - nema ponovne inicijalizacije.
 */
@Injectable()
export class SetupService {
  constructor(@Inject(DB) readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}
  get pepper() { return this.cfg.pinPepper; }

  async status() {
    const r = await this.db.execute(sql`SELECT count(*)::int AS n FROM organizations`);
    return { needsSetup: (r.rows[0] as { n: number }).n === 0 };
  }

  async run(dto: SetupDto) {
    if (dto.mode === 'DEMO') {
      if (!(await this.status()).needsSetup) throw Conflict('ALREADY_SET_UP', 'Kasa je već podešena');
      await seed(this.cfg.databaseUrl, this.cfg.pinPepper);
      return { ok: true, mode: 'DEMO' };
    }
    return this.db.transaction(async (tx) => {
      // jedan proces podešavanja u isto vreme (dva klika, dva prozora)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(424242)`);
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM organizations`);
      if ((r.rows[0] as { n: number }).n > 0) throw Conflict('ALREADY_SET_UP', 'Kasa je već podešena');

      const [org] = await tx.insert(s.organizations).values({ name: dto.companyName!.trim(), taxId: dto.pib! }).returning();
      const [loc] = await tx.insert(s.locations).values({
        organizationId: org.id, name: dto.storeName!.trim(), address: dto.address?.trim() || null,
        settings: { companyName: dto.companyName!.trim(), pib: dto.pib!, storeName: dto.storeName!.trim() },
      }).returning();
      const roleIds: Record<string, string> = {};
      for (const role of DEFAULT_ROLES) roleIds[role.code] = (await tx.insert(s.roles).values({ organizationId: org.id, ...role }).returning())[0].id;
      // podrazumevani nalozi: ADMIN/0000, KON01/11, KON02/22, tv/tv (menjaju se u ADMIN → Korisnici)
      await createDefaultUsers(tx, org.id, roleIds, this.cfg.pinPepper);
      // Oznake i stope proveriti prema važećem tehničkom vodiču PU.
      await tx.insert(s.taxRates).values([
        { organizationId: org.id, label: 'Đ', name: 'Opšta stopa PDV', rate: '20.00' },
        { organizationId: org.id, label: 'E', name: 'Posebna stopa PDV', rate: '10.00' },
        { organizationId: org.id, label: 'A', name: 'Bez PDV-a', rate: '0.00' },
      ]);
      await tx.insert(s.devices).values([
        { locationId: loc.id, name: 'Kasa 1', kind: 'POS' },
        { locationId: loc.id, name: 'KDS - Kuhinja', kind: 'KDS' },
      ]);
      await tx.insert(s.prepStations).values([
        { locationId: loc.id, name: 'Šank', kind: 'BAR' },
        { locationId: loc.id, name: 'Kuhinja', kind: 'KITCHEN' },
      ]);
      await tx.insert(s.warehouses).values({ locationId: loc.id, name: 'Glavni magacin', isDefault: true });
      return { ok: true, mode: 'NEW' };
    });
  }
}

/**
 * Povratak podrazumevanih naloga (ADMIN/0000, KON01/11, KON02/22, tv/tv) - kad se zaboravi šifra ili je baza
 * iz starije verzije. Samo sa glavne kase (Ctrl+Shift+R u programu), kao i lokalna registracija štampe.
 * Postojećim nalozima sa tim korisničkim imenom vraća šifru i uključuje ih; ako je PIN zauzet, oslobađa ga.
 */
async function resetDefaultLogins(db: Db, pepper: string) {
  const [org] = await db.select({ id: s.organizations.id }).from(s.organizations).orderBy(asc(s.organizations.createdAt)).limit(1);
  if (!org) throw Conflict('NOT_SET_UP', 'Kasa još nije podešena (prvo pokretanje)');
  const roleRows = await db.select({ id: s.roles.id, code: s.roles.code }).from(s.roles).where(eq(s.roles.organizationId, org.id));
  const roleIds = Object.fromEntries(roleRows.map((x) => [x.code, x.id]));
  const done: string[] = [];
  await db.transaction(async (tx) => {
    for (const d of DEFAULT_LOGINS) {
      const pin = 'pin' in d ? d.pin : null;
      const password = 'password' in d ? d.password : null;
      const lookup = pin ? pinLookup(pin, pepper) : null;
      const [cur] = await tx.select({ id: s.users.id }).from(s.users).where(and(eq(s.users.organizationId, org.id), eq(s.users.username, d.username)));
      if (lookup) {
        // isti PIN kod drugog korisnika: oslobađa se (taj korisnik dobija novi PIN u ADMIN-u)
        const taken = await tx.update(s.users).set({ pinHash: null, pinLookup: null })
          .where(and(eq(s.users.organizationId, org.id), eq(s.users.pinLookup, lookup), sql`${s.users.username} IS DISTINCT FROM ${d.username}`)).returning({ name: s.users.fullName });
        for (const t of taken) done.push(`PIN ${pin} je oduzet korisniku ${t.name}`);
      }
      const secrets = {
        ...(password ? { passwordHash: await hashSecret(password) } : {}),
        ...(pin ? { pinHash: await hashSecret(pin), pinLookup: lookup } : {}),
      };
      if (cur) await tx.update(s.users).set({ ...secrets, active: true, updatedAt: new Date() }).where(eq(s.users.id, cur.id));
      else await tx.insert(s.users).values({ organizationId: org.id, roleId: roleIds[d.role] ?? roleIds.ADMIN, fullName: d.fullName, firstName: d.fullName, lastName: '', username: d.username, ...secrets });
      done.push(`${d.fullName}: ${cur ? 'šifra vraćena' : 'nalog napravljen'}`);
    }
  });
  return { ok: true, done };
}

/**
 * Instalirana glavna kasa: desktop program na ISTOM računaru registruje svoj Print Bridge bez ručnog unosa ključa.
 * Dozvoljeno samo sa 127.0.0.1 i uz tajni token koji desktop program daje serveru pri pokretanju (LOCAL_TOKEN).
 * Ponovni poziv za isti naziv izdaje novi ključ (npr. ako je config.json izgubljen).
 */
async function localBridge(db: Db, name: string) {
  const [loc] = await db.select({ id: s.locations.id }).from(s.locations).orderBy(asc(s.locations.createdAt)).limit(1);
  if (!loc) throw Conflict('NOT_SET_UP', 'Kasa još nije podešena (prvo pokretanje)');
  const key = `pb_${randomBytes(32).toString('base64url')}`;
  const [cur] = await db.select({ id: s.devices.id }).from(s.devices)
    .where(and(eq(s.devices.locationId, loc.id), eq(s.devices.kind, 'BRIDGE'), eq(s.devices.name, name)));
  if (cur) {
    await db.update(s.devices).set({ apiKeyHash: hashKey(key), apiKeyPrefix: key.slice(0, 10), active: true }).where(eq(s.devices.id, cur.id));
    return { deviceId: cur.id, key };
  }
  const [d] = await db.insert(s.devices).values({ locationId: loc.id, name, kind: 'BRIDGE', apiKeyHash: hashKey(key), apiKeyPrefix: key.slice(0, 10) }).returning();
  return { deviceId: d.id, key };
}

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly svc: SetupService) {}
  @Public() @Get('status')
  status() { return this.svc.status(); }
  @Public() @Post()
  run(@Body() dto: SetupDto) { return this.svc.run(dto); }
  @Public() @Post('local-bridge')
  localBridge(@Req() req: any, @Headers('x-local-token') token: string | undefined, @Body() dto: LocalBridgeDto) {
    const expected = process.env.LOCAL_TOKEN ?? '';
    const ip = String(req.socket?.remoteAddress ?? '');
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const ok = expected.length >= 32 && !!token && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!loopback || !ok) throw new ForbiddenException('Samo za program kase na ovom računaru');
    return localBridge(this.svc.db, dto.name.trim());
  }
  @Public() @Post('reset-logins') @HttpCode(200)
  resetLogins(@Req() req: any, @Headers('x-local-token') token: string | undefined) {
    const expected = process.env.LOCAL_TOKEN ?? '';
    const ip = String(req.socket?.remoteAddress ?? '');
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const ok = expected.length >= 32 && !!token && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!loopback || !ok) throw new ForbiddenException('Samo za program kase na ovom računaru');
    return resetDefaultLogins(this.svc.db, this.svc.pepper);
  }
}

@Module({ controllers: [SetupController], providers: [SetupService] })
export class SetupModule {}
