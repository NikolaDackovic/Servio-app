import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { categories, devices, priceLists } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';

/** Funkcije (dugmad) kase koje se mogu sakriti na pojedinom računaru. Prava se i dalje proveravaju na serveru. */
export const FEATURES = ['quickSale', 'receipts', 'endOfDay', 'shift', 'priceList', 'transfer', 'storno', 'cash', 'card'] as const;
type Feature = (typeof FEATURES)[number];

/**
 * Fiskalizacija ove kase: svaka kasa može imati svoj LPFR (lokalni procesor, npr. program na localhost:5555)
 * ili VPFR (virtuelni procesor Poreske uprave sa sertifikatom). PIN i JID su podaci bezbednosnog elementa.
 * Slanje pravih računa uključuje se u podešavanjima lokala (Fiskalizacija: LPFR/VPFR); do tada je TEST.
 */
export interface FiscalSettings { useVpfr: boolean; lpfrUrl: string; vpfrCertPath: string; certPassword: string; pac: string; pin: string; jid: string }
export interface DeviceSettings {
  /** Grupe koje se NE prikazuju na ovoj kasi (npr. šank kasa bez hrane). */
  hiddenGroups: string[];
  /** Isključene funkcije (dugmad) na ovoj kasi. */
  hiddenFeatures: Feature[];
  fiscal: FiscalSettings;
  /** Štampa na ovom računaru: logo na fiskalnom računu, tekst i slika na kraju računa. */
  print: PrintSettings;
  /** Podrazumevani korisnik (npr. fast food): kasa se prijavljuje bez šifre kao on; prazno = kucaju se šifre. */
  defaultUserId: string | null;
}
export interface PrintSettings { logoOnReceipt: boolean; footerOnReceipt: boolean; autoReceipt: boolean }
const PRINT: PrintSettings = { logoOnReceipt: true, footerOnReceipt: true, autoReceipt: true };
const FISCAL: FiscalSettings = { useVpfr: false, lpfrUrl: '', vpfrCertPath: '', certPassword: '', pac: '', pin: '', jid: '' };
const DEFAULTS: DeviceSettings = { hiddenGroups: [], hiddenFeatures: [], fiscal: FISCAL, print: PRINT, defaultUserId: null };
export const deviceSettings = (s: unknown): DeviceSettings => {
  const x = (s as Partial<DeviceSettings>) ?? {};
  return { ...DEFAULTS, ...x, fiscal: { ...FISCAL, ...(x.fiscal ?? {}) }, print: { ...PRINT, ...(x.print ?? {}) } };
};

class FiscalDto {
  @IsOptional() @IsBoolean() useVpfr?: boolean;
  @IsOptional() @Matches(/^(https?:\/\/\S+|[A-Za-z0-9.-]+:\d{1,5})?$/, { message: 'LPFR: npr. localhost:5555 ili http://192.168.1.20:5555' }) lpfrUrl?: string;
  @IsOptional() @IsString() @Length(0, 300) vpfrCertPath?: string;
  @IsOptional() @IsString() @Length(0, 100) certPassword?: string;
  @IsOptional() @Matches(/^([A-Za-z0-9]{6})?$/, { message: 'PAC je 6 slova/cifara (iz koverte Poreske uprave)' }) pac?: string;
  @IsOptional() @Matches(/^(\d{4,8})?$/, { message: 'PIN bezbednosnog elementa je 4-8 cifara' }) pin?: string;
  @IsOptional() @IsString() @Length(0, 40) jid?: string;
}
class PrintDto {
  @IsOptional() @IsBoolean() logoOnReceipt?: boolean;
  @IsOptional() @IsBoolean() footerOnReceipt?: boolean;
  /** Kasa štampa račun odmah posle naplate (isključiti ako fiskalni uređaj sam štampa). */
  @IsOptional() @IsBoolean() autoReceipt?: boolean;
}
class SettingsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) hiddenGroups?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(FEATURES.length) @IsIn(FEATURES, { each: true }) hiddenFeatures?: Feature[];
  @IsOptional() @ValidateNested() @Type(() => FiscalDto) fiscal?: FiscalDto;
  @IsOptional() @ValidateNested() @Type(() => PrintDto) print?: PrintDto;
  @IsOptional() @IsUUID() defaultUserId?: string | null;
}
class CreateDeviceDto {
  @IsString() @Length(1, 60) name: string;
  @IsIn(['POS', 'KDS']) kind: 'POS' | 'KDS';
}
class UpdateDeviceDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsUUID() priceListId?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SettingsDto) settings?: SettingsDto;
}

/** Računari (kase i KDS ekrani) lokala i njihova podešavanja. Print Bridge ima svoj ekran (Štampanje). */
@Injectable()
export class DevicesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(u: AuthUser) {
    const rows = await this.db.select({
      id: devices.id, name: devices.name, kind: devices.kind, active: devices.active, lastSeenAt: devices.lastSeenAt,
      priceListId: devices.priceListId, receiptPrinterId: devices.receiptPrinterId, settings: devices.settings,
    }).from(devices).where(and(eq(devices.locationId, u.locationId), ne(devices.kind, 'BRIDGE'))).orderBy(asc(devices.kind), asc(devices.name));
    return rows.map((d) => ({ ...d, settings: deviceSettings(d.settings) }));
  }

  /** Podešavanja računara na kome je korisnik prijavljen (kasa ih primenjuje). */
  async mine(u: AuthUser) {
    if (!u.deviceId) return { device: null, settings: { hiddenGroups: [], hiddenFeatures: [] } };
    const [d] = await this.db.select({ id: devices.id, name: devices.name, settings: devices.settings }).from(devices).where(eq(devices.id, u.deviceId));
    // kasi samo prikaz (grupe, dugmad) - fiskalni PIN i podaci ostaju u ADMIN-u
    const { fiscal: _f, ...visible } = deviceSettings(d?.settings);
    return { device: d ? { id: d.id, name: d.name } : null, settings: visible };
  }

  async create(u: AuthUser, dto: CreateDeviceDto) {
    return this.db.transaction(async (tx) => {
      const name = dto.name.trim();
      const [same] = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.locationId, u.locationId), eq(devices.name, name)));
      if (same) throw Conflict('DEVICE_NAME_TAKEN', `Računar "${name}" već postoji`);
      const [d] = await tx.insert(devices).values({ locationId: u.locationId, name, kind: dto.kind }).returning();
      await audit(tx, u, 'device.create', 'device', d.id, { name, kind: dto.kind });
      return { id: d.id, name: d.name, kind: d.kind, active: d.active, priceListId: null, settings: DEFAULTS };
    });
  }

  async update(u: AuthUser, id: string, dto: UpdateDeviceDto) {
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(devices)
        .where(and(eq(devices.id, id), eq(devices.locationId, u.locationId), ne(devices.kind, 'BRIDGE'))).for('update');
      if (!cur) throw NotFound('Računar');
      if (dto.active === false && id === u.deviceId) throw Conflict('SELF_DEVICE', 'Ne možete isključiti računar na kome ste prijavljeni');
      const patch: Record<string, unknown> = {};
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.active !== undefined) patch.active = dto.active;
      if (dto.priceListId !== undefined) {
        if (dto.priceListId) {
          const [l] = await tx.select({ id: priceLists.id }).from(priceLists)
            .where(and(eq(priceLists.id, dto.priceListId), eq(priceLists.organizationId, u.organizationId), eq(priceLists.active, true)));
          if (!l) throw Invalid('INVALID_PRICE_LIST', 'Cenovnik ne postoji ili nije aktivan');
        }
        patch.priceListId = dto.priceListId ?? null;
      }
      if (dto.settings) {
        const prev = deviceSettings(cur.settings);
        // samo zaista poslata polja (polja DTO klase postoje i kao undefined)
        const sent = <T extends object>(o: T | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
        const next = { ...prev, ...sent(dto.settings), fiscal: { ...prev.fiscal, ...sent(dto.settings.fiscal) }, print: { ...prev.print, ...sent(dto.settings.print) } } as DeviceSettings;
        if (next.hiddenGroups.length) {
          const own = await tx.select({ id: categories.id }).from(categories)
            .where(and(inArray(categories.id, next.hiddenGroups), eq(categories.organizationId, u.organizationId)));
          if (own.length !== new Set(next.hiddenGroups).size) throw Invalid('INVALID_GROUP', 'Neke grupe ne postoje');
        }
        patch.settings = { hiddenGroups: [...new Set(next.hiddenGroups)], hiddenFeatures: [...new Set(next.hiddenFeatures)], fiscal: next.fiscal, print: next.print,
          defaultUserId: dto.settings.defaultUserId === undefined ? prev.defaultUserId : dto.settings.defaultUserId };
      }
      if (Object.keys(patch).length) await tx.update(devices).set(patch).where(eq(devices.id, id));
      await audit(tx, u, 'device.update', 'device', id, dto as any);
      return (await this.list(u)).find((d) => d.id === id);
    });
  }
}

@ApiTags('devices') @ApiBearerAuth()
@Controller()
export class DevicesController {
  constructor(private readonly svc: DevicesService) {}
  @Get('computers') @RequirePermissions(P.SETTINGS_MANAGE)
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Get('computers/me') @RequirePermissions(P.ORDER_READ)
  mine(@CurrentUser() u: AuthUser) { return this.svc.mine(u); }
  @Post('computers') @RequirePermissions(P.SETTINGS_MANAGE)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateDeviceDto) { return this.svc.create(u, dto); }
  @Patch('computers/:id') @RequirePermissions(P.SETTINGS_MANAGE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeviceDto) { return this.svc.update(u, id, dto); }
}

@Module({ controllers: [DevicesController], providers: [DevicesService] })
export class DevicesModule {}
