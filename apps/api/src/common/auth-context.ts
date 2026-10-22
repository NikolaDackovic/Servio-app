import {
  CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { roles, users, devices, locations } from '../db/schema';
import { Permission } from './permissions';

/** Kontekst prijavljenog korisnika — sve poslovne operacije ga dobijaju eksplicitno. */
export interface AuthUser {
  userId: string;
  fullName: string;
  organizationId: string;
  locationId: string;
  deviceId: string | null;
  roleCode: string;
  permissions: string[];
}

export interface JwtPayload {
  sub: string;
  org: string;
  loc: string;
  dev: string | null;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMS = 'permissions';
/** Zahtevana prava za rutu (sva navedena moraju postojati). */
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMS, p);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/**
 * Globalni guard: validira JWT i pri SVAKOM zahtevu učitava korisnika i ulogu iz baze,
 * tako da deaktivacija naloga ili promena prava deluje odmah (bez čekanja isteka tokena).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Nedostaje token za prijavu');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Token je neispravan ili je istekao');
    }

    const [row] = await this.db
      .select({
        id: users.id, fullName: users.fullName, active: users.active, org: users.organizationId,
        roleCode: roles.code, permissions: roles.permissions,
      })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.id, payload.sub), eq(users.organizationId, payload.org)));
    if (!row || !row.active) throw new UnauthorizedException('Nalog nije aktivan');

    // Lokal i uređaj iz tokena moraju i dalje pripadati organizaciji.
    const [loc] = await this.db.select({ id: locations.id }).from(locations)
      .where(and(eq(locations.id, payload.loc), eq(locations.organizationId, payload.org)));
    if (!loc) throw new UnauthorizedException('Lokal nije dostupan');
    if (payload.dev) {
      const [dev] = await this.db.select({ id: devices.id, active: devices.active }).from(devices)
        .where(and(eq(devices.id, payload.dev), eq(devices.locationId, payload.loc)));
      if (!dev || !dev.active) throw new UnauthorizedException('Uređaj nije aktivan');
    }

    const user: AuthUser = {
      userId: row.id, fullName: row.fullName, organizationId: row.org, locationId: payload.loc,
      deviceId: payload.dev, roleCode: row.roleCode, permissions: row.permissions,
    };
    req.user = user;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMS, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const missing = required.filter((p) => !user.permissions.includes(p));
    if (missing.length) throw new ForbiddenException(`Nemate pravo za ovu akciju (${missing.join(', ')})`);
    return true;
  }
}
