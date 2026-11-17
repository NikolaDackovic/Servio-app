import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DB, Db } from '../../db/db.module';
import { roles, users } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { ALL_PERMISSIONS, P, PERMISSION_INFO } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { cardLookup, hashSecret, pinLookup } from '../../common/security';
import { AppConfig, CONFIG } from '../../config';
import { ColumnDef, mapColumns, parseBool, readTable, toCsv, toXlsx } from '../stock/tabular';

const PIN_RE = /^\d{1,10}$/;
const CARD_RE = /^[0-9A-Za-z]{6,32}$/;
const USERNAME_RE = /^[a-z0-9._-]{2,40}$/;

class RoleDto {
  @IsString() @Length(2, 40) name: string;
  @IsArray() @ArrayMaxSize(100) @IsIn(ALL_PERMISSIONS, { each: true }) permissions: string[];
}
class UpdateRoleDto {
  @IsOptional() @IsString() @Length(2, 40) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsIn(ALL_PERMISSIONS, { each: true }) permissions?: string[];
}
class UserDto {
  @IsString() @Length(1, 60) firstName: string;
  @IsOptional() @IsString() @Length(0, 60) lastName?: string;
  @Matches(USERNAME_RE, { message: 'Korisničko ime: 2-40 znakova (slova, brojevi, . _ -)' }) username: string;
  @IsOptional() @IsEmail() email?: string;
  @IsUUID() roleId: string;
  @IsOptional() @Matches(PIN_RE, { message: 'Šifra (PIN) je 1-10 cifara' }) pin?: string;
  @IsOptional() @IsString() @Length(2, 200) password?: string;
  /** broj kartice sa čitača; null = ukloni karticu */
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(CARD_RE, { message: 'Broj kartice: 6-32 slova/cifre (prislonite karticu na čitač)' }) card?: string | null;
}
class UpdateUserDto {
  @IsOptional() @IsString() @Length(1, 60) firstName?: string;
  @IsOptional() @IsString() @Length(0, 60) lastName?: string;
  @IsOptional() @Matches(USERNAME_RE, { message: 'Korisničko ime: 2-40 znakova (slova, brojevi, . _ -)' }) username?: string;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @Matches(PIN_RE, { message: 'Šifra (PIN) je 1-10 cifara' }) pin?: string;
  @IsOptional() @IsString() @Length(2, 200) password?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(CARD_RE, { message: 'Broj kartice: 6-32 slova/cifre (prislonite karticu na čitač)' }) card?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ImportDto {
  @IsString() @Length(1, 200) fileName: string;
  @IsString() @Length(1, 8_000_000) contentBase64: string;
}
class FormatQuery { @IsOptional() @IsIn(['csv', 'xlsx']) format?: 'csv' | 'xlsx'; }

const roleCode = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'dj')
  .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || 'ULOGA';

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  permissions() { return PERMISSION_INFO; }

  async listRoles(u: AuthUser) {
    const rows = await this.db.select({ id: roles.id, code: roles.code, name: roles.name, permissions: roles.permissions,
      users: sql<number>`(select count(*)::int from users x where x.role_id = "roles"."id")` })
      .from(roles).where(eq(roles.organizationId, u.organizationId)).orderBy(asc(roles.name));
    return rows;
  }

  async createRole(u: AuthUser, dto: RoleDto) {
    return this.db.transaction(async (tx) => {
      const name = dto.name.trim();
      let code = roleCode(name);
      const [same] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.organizationId, u.organizationId), eq(roles.code, code)));
      if (same) code = `${code.slice(0, 26)}_${Date.now().toString(36).slice(-5).toUpperCase()}`;
      const [r] = await tx.insert(roles).values({ organizationId: u.organizationId, code, name, permissions: [...new Set(dto.permissions)] }).returning();
      await audit(tx, u, 'role.create', 'role', r.id, { name, permissions: r.permissions });
      return r;
    });
  }

  async updateRole(u: AuthUser, id: string, dto: UpdateRoleDto) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(roles).where(and(eq(roles.id, id), eq(roles.organizationId, u.organizationId))).for('update');
      if (!r) throw NotFound('Uloga');
      if (r.code === 'ADMIN' && dto.permissions) throw Conflict('ROLE_LOCKED', 'Uloga Administrator uvek ima sva prava');
      // Bar jedna uloga sa aktivnim korisnikom mora zadržati pravo upravljanja korisnicima (da se niko ne zaključa).
      if (dto.permissions && r.permissions.includes(P.USER_MANAGE) && !dto.permissions.includes(P.USER_MANAGE)) {
        const [{ n }] = await tx.select({ n: count() }).from(users).innerJoin(roles, eq(roles.id, users.roleId))
          .where(and(eq(users.organizationId, u.organizationId), eq(users.active, true), ne(roles.id, id), sql`${P.USER_MANAGE} = ANY(${roles.permissions})`));
        if (n === 0) throw Conflict('LAST_ADMIN_ROLE', 'Mora ostati bar jedna uloga sa pravom „Korisnici, uloge i prava“');
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (dto.name) patch.name = dto.name.trim();
      if (dto.permissions) patch.permissions = [...new Set(dto.permissions)];
      const [n] = await tx.update(roles).set(patch).where(eq(roles.id, id)).returning();
      await audit(tx, u, 'role.update', 'role', id, dto as any);
      return n;
    });
  }

  async deleteRole(u: AuthUser, id: string) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(roles).where(and(eq(roles.id, id), eq(roles.organizationId, u.organizationId)));
      if (!r) throw NotFound('Uloga');
      if (r.code === 'ADMIN') throw Conflict('ROLE_LOCKED', 'Uloga Administrator se ne briše');
      const [{ n }] = await tx.select({ n: count() }).from(users).where(eq(users.roleId, id));
      if (n > 0) throw Conflict('ROLE_IN_USE', `Ulogu koristi ${n} korisnika - prvo im dodelite drugu ulogu`);
      await tx.delete(roles).where(eq(roles.id, id));
      await audit(tx, u, 'role.delete', 'role', id, { name: r.name });
      return { id, deleted: true };
    });
  }

  async listUsers(u: AuthUser) {
    return this.db.select({
      id: users.id, firstName: users.firstName, lastName: users.lastName, fullName: users.fullName, username: users.username,
      email: users.email, roleId: users.roleId, roleName: roles.name, active: users.active,
      hasPin: sql<boolean>`${users.pinHash} is not null`, hasPassword: sql<boolean>`${users.passwordHash} is not null`, hasCard: sql<boolean>`${users.cardLookup} is not null`,
      createdAt: users.createdAt,
    }).from(users).innerJoin(roles, eq(roles.id, users.roleId))
      // sistemski korisnik QR porudžbina se ne prikazuje
      .where(and(eq(users.organizationId, u.organizationId), sql`coalesce(${users.username}, '') <> 'qr-gost'`)).orderBy(asc(users.firstName), asc(users.lastName));
  }

  /** Provere jedinstvenosti (korisničko ime, email, PIN) i ispravnosti uloge. */
  private async check(tx: any, u: AuthUser, f: { username?: string; email?: string | null; pin?: string; roleId?: string; card?: string | null }, exceptId?: string) {
    if (f.roleId) {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.id, f.roleId), eq(roles.organizationId, u.organizationId)));
      if (!r) throw Invalid('INVALID_ROLE', 'Uloga ne postoji');
    }
    const clash = async (cond: any, code: string, msg: string) => {
      const [x] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, u.organizationId), cond));
      if (x && x.id !== exceptId) throw Conflict(code, msg);
    };
    if (f.username) await clash(eq(users.username, f.username), 'USERNAME_TAKEN', `Korisničko ime "${f.username}" je zauzeto`);
    if (f.email) await clash(eq(users.email, f.email), 'EMAIL_TAKEN', `Email "${f.email}" je zauzet`);
    if (f.pin) await clash(eq(users.pinLookup, pinLookup(f.pin, this.cfg.pinPepper)), 'PIN_TAKEN', 'Ova šifra (PIN) je već dodeljena drugom korisniku');
    if (f.card) await clash(eq(users.cardLookup, cardLookup(f.card, this.cfg.pinPepper)), 'CARD_TAKEN', 'Ova kartica je već dodeljena drugom korisniku');
  }

  private async secrets(dto: { pin?: string; password?: string; card?: string | null }) {
    const s: Record<string, unknown> = {};
    if (dto.card === null) s.cardLookup = null;
    else if (dto.card) s.cardLookup = cardLookup(dto.card, this.cfg.pinPepper);
    if (dto.pin) { s.pinHash = await hashSecret(dto.pin); s.pinLookup = pinLookup(dto.pin, this.cfg.pinPepper); }
    if (dto.password) s.passwordHash = await hashSecret(dto.password);
    return s;
  }

  async createUser(u: AuthUser, dto: UserDto, tx0?: any) {
    const run = async (tx: any) => {
      const f = { ...dto, username: dto.username.toLowerCase(), email: dto.email?.toLowerCase() ?? null };
      await this.check(tx, u, f);
      if (!dto.pin && !dto.password && !dto.card) throw Invalid('NO_SECRET', 'Unesite šifru za kasu (PIN), karticu ili lozinku za ADMIN');
      const firstName = dto.firstName.trim(); const lastName = (dto.lastName ?? '').trim();
      const [n] = await tx.insert(users).values({
        organizationId: u.organizationId, roleId: dto.roleId, firstName, lastName, fullName: `${firstName} ${lastName}`.trim(),
        username: f.username, email: f.email, ...(await this.secrets(dto)),
      }).returning({ id: users.id });
      await audit(tx, u, 'user.create', 'user', n.id, { username: f.username, roleId: dto.roleId, pin: !!dto.pin, password: !!dto.password });
      return n;
    };
    return tx0 ? run(tx0) : this.db.transaction(run);
  }

  async updateUser(u: AuthUser, id: string, dto: UpdateUserDto, tx0?: any) {
    const run = async (tx: any) => {
      const [cur] = await tx.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, u.organizationId))).for('update');
      if (!cur) throw NotFound('Korisnik');
      if (id === u.userId && dto.active === false) throw Conflict('SELF_DEACTIVATE', 'Ne možete deaktivirati sopstveni nalog');
      if (id === u.userId && dto.roleId && dto.roleId !== cur.roleId) {
        const [r] = await tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, dto.roleId));
        if (r && !r.permissions.includes(P.USER_MANAGE)) throw Conflict('SELF_LOCKOUT', 'Ne možete sebi dodeliti ulogu bez prava upravljanja korisnicima');
      }
      const f = { ...dto, username: dto.username?.toLowerCase(), email: dto.email === null ? null : dto.email?.toLowerCase() };
      await this.check(tx, u, { username: f.username, email: f.email ?? undefined, pin: dto.pin, roleId: dto.roleId, card: dto.card }, id);
      const firstName = (dto.firstName ?? cur.firstName).trim(); const lastName = (dto.lastName ?? cur.lastName).trim();
      const patch: Record<string, unknown> = {
        firstName, lastName, fullName: `${firstName} ${lastName}`.trim(), updatedAt: new Date(), ...(await this.secrets(dto)),
      };
      if (f.username !== undefined) patch.username = f.username;
      if (dto.email !== undefined) patch.email = f.email;
      if (dto.roleId) patch.roleId = dto.roleId;
      if (dto.active !== undefined) patch.active = dto.active;
      await tx.update(users).set(patch).where(eq(users.id, id));
      const { pin, password, card, ...safe } = dto;
      await audit(tx, u, 'user.update', 'user', id, { ...safe, pinChanged: !!pin, passwordChanged: !!password, ...(card !== undefined ? { card: card ? 'dodeljena' : 'uklonjena' } : {}) });
      return { id };
    };
    return tx0 ? run(tx0) : this.db.transaction(run);
  }

  // ---------- Excel / CSV ----------

  private readonly cols: ColumnDef[] = [
    { key: 'firstName', label: 'Ime', aliases: ['ime'], required: true },
    { key: 'lastName', label: 'Prezime', aliases: ['prezime'], required: false },
    { key: 'username', label: 'Korisničko ime', aliases: ['korisnicko ime', 'username'], required: true },
    { key: 'email', label: 'Email', aliases: ['e-mail', 'mail'], required: false },
    { key: 'role', label: 'Uloga', aliases: ['uloga', 'role'], required: true },
    { key: 'pin', label: 'Šifra (PIN)', aliases: ['pin', 'sifra', 'šifra'], required: false },
    { key: 'password', label: 'Lozinka', aliases: ['lozinka', 'password'], required: false },
    { key: 'active', label: 'Aktivan', aliases: ['aktivan', 'active'], required: false },
  ];

  async exportUsers(u: AuthUser, format: 'csv' | 'xlsx') {
    const list = await this.listUsers(u);
    const headers = this.cols.map((c) => c.label);
    const rows = list.map((x) => [x.firstName, x.lastName, x.username ?? '', x.email ?? '', x.roleName, '', '', x.active ? 'da' : 'ne']);
    const body = format === 'csv' ? toCsv(headers, rows) : await toXlsx('Korisnici', headers, rows);
    return { body, fileName: `korisnici.${format}`, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }

  /**
   * Uvoz korisnika: novi po korisničkom imenu se dodaju, postojeći se menjaju (prazna šifra/lozinka = bez promene).
   * Sve ili ništa: ako i jedan red ima grešku, ništa se ne upisuje i vraća se spisak grešaka po redovima.
   */
  async importUsers(u: AuthUser, dto: ImportDto) {
    const { table } = await readTable(dto.fileName, dto.contentBase64);
    const { idx, missing } = mapColumns(table.headers, this.cols);
    if (missing.length) throw Invalid('MISSING_COLUMNS', `Nedostaju kolone: ${missing.join(', ')}`);
    const allRoles = await this.listRoles(u);
    const cell = (cells: string[], k: string) => (idx[k] === undefined ? '' : (cells[idx[k]] ?? '').trim());
    const errors: { row: number; message: string }[] = [];
    let created = 0; let updated = 0;
    try {
      await this.db.transaction(async (tx) => {
        for (const r of table.rows) {
          const c = (k: string) => cell(r.cells, k);
          try {
            const roleName = c('role').toLowerCase();
            const role = allRoles.find((x) => x.name.toLowerCase() === roleName || x.code.toLowerCase() === roleName);
            if (!role) throw Invalid('INVALID_ROLE', `Uloga "${c('role')}" ne postoji`);
            const username = c('username').toLowerCase();
            if (!USERNAME_RE.test(username)) throw Invalid('INVALID_USERNAME', 'Korisničko ime: 2-40 znakova (slova, brojevi, . _ -)');
            const pin = c('pin') || undefined;
            if (pin && !PIN_RE.test(pin)) throw Invalid('INVALID_PIN', 'Šifra (PIN) je 1-10 cifara');
            const password = c('password') || undefined;
            if (password && password.length < 6) throw Invalid('INVALID_PASSWORD', 'Lozinka ima najmanje 6 znakova');
            const activeRaw = c('active');
            const active = activeRaw ? parseBool(activeRaw) : null;
            const [existing] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, u.organizationId), eq(users.username, username)));
            const base = { firstName: c('firstName'), lastName: c('lastName'), username, email: c('email') || undefined, roleId: role.id, pin, password };
            if (existing) { await this.updateUser(u, existing.id, { ...base, ...(active === null ? {} : { active }) }, tx); updated++; }
            else { await this.createUser(u, base, tx); created++; }
          } catch (e: any) { errors.push({ row: r.rowNumber, message: e.message }); }
        }
        if (errors.length) throw new Error('ROLLBACK');
      });
    } catch (e: any) {
      if (e.message !== 'ROLLBACK') throw e;
      throw Invalid('IMPORT_ERRORS', `Uvoz nije izvršen: ${errors.length} redova sa greškom`, { errors });
    }
    return { created, updated };
  }
}

const send = (res: Response, f: { body: Buffer; fileName: string; contentType: string }) => {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
  res.send(f.body);
};

@ApiTags('users') @ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  @Get('permissions') @RequirePermissions(P.USER_MANAGE)
  permissions() { return this.svc.permissions(); }

  @Get('roles') @RequirePermissions(P.USER_MANAGE)
  roles(@CurrentUser() u: AuthUser) { return this.svc.listRoles(u); }
  @Post('roles') @RequirePermissions(P.USER_MANAGE)
  createRole(@CurrentUser() u: AuthUser, @Body() dto: RoleDto) { return this.svc.createRole(u, dto); }
  @Patch('roles/:id') @RequirePermissions(P.USER_MANAGE)
  updateRole(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) { return this.svc.updateRole(u, id, dto); }
  @Delete('roles/:id') @HttpCode(200) @RequirePermissions(P.USER_MANAGE)
  deleteRole(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.deleteRole(u, id); }

  @Get('users') @RequirePermissions(P.USER_MANAGE)
  users(@CurrentUser() u: AuthUser) { return this.svc.listUsers(u); }
  @Get('users/export') @RequirePermissions(P.USER_MANAGE)
  async exportUsers(@CurrentUser() u: AuthUser, @Query() q: FormatQuery, @Res() res: Response) { send(res, await this.svc.exportUsers(u, q.format ?? 'xlsx')); }
  @Post('users/import') @HttpCode(200) @RequirePermissions(P.USER_MANAGE)
  importUsers(@CurrentUser() u: AuthUser, @Body() dto: ImportDto) { return this.svc.importUsers(u, dto); }
  @Post('users') @RequirePermissions(P.USER_MANAGE)
  createUser(@CurrentUser() u: AuthUser, @Body() dto: UserDto) { return this.svc.createUser(u, dto); }
  @Patch('users/:id') @RequirePermissions(P.USER_MANAGE)
  updateUser(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) { return this.svc.updateUser(u, id, dto); }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
