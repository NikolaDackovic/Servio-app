import { Body, Controller, Get, Inject, Injectable, Module, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { eq, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { locations } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Invalid } from '../../common/errors';

export interface RasterLogo { width: number; height: number; data: string }

/** Podešavanja kase i štampe po lokalu (ADMIN → Podešavanja / Štampanje / Mape stolova). */
export interface KasaSettings {
  /** Kasa traži PIN konobara za svaki sto (i brzi račun). */
  pinPerTable: boolean;
  /** Izgled isečka: tekst ispod naziva lokala, tekst na kraju računa, logo (crno-beli raster za termalni štampač). */
  /** Podaci sa fiskalnog računa (prazno = iz podataka firme i lokala). */
  companyName: string; pib: string; storeName: string; address: string; city: string; esirNumber: string;
  /** Dodatni podaci na računu (prazno = ne štampa se): žiro račun, telefon, email, sajt, matični broj */
  bankAccount: string; phone: string; email: string; website: string; registrationNo: string;
  receiptHeader: string;
  receiptFooter: string;
  receiptLogo: RasterLogo | null;
  receiptLogoPreview: string | null;
  /** Slika na kraju računa (posle teksta na kraju), crno-beli raster kao logo. */
  receiptFooterImage: RasterLogo | null;
  receiptFooterImagePreview: string | null;
  /** Period (datum od-do, prazno = uvek) u kome se štampaju tekst i slika na kraju računa - npr. akcija za praznike. */
  receiptExtraFrom: string;
  receiptExtraTo: string;
  /** Reprezentacija (na kuću): FISCAL = fiskalni račun sa natpisom "reprezentacija", SLIP = kratak isečak kao porudžbina. */
  representationPrint: 'FISCAL' | 'SLIP';
  /** Porudžbine (šank/kuhinja): velika slova (podrazumevano) ili normalna. */
  ticketLarge: boolean;
  /** Fiskalizacija: LPFR (lokalni procesor) ili VPFR (virtuelni, poreska). Stvarno povezivanje tek posle izbora puta sertifikacije. */
  fiscalMode: 'NONE' | 'LPFR' | 'VPFR';
  lpfrUrl: string;
  vpfrUrl: string;
  /** Čuvar ekrana dok smena nije otvorena. */
  screensaverText: string;
  screensaverImage: string | null;
  /** Slika pozadine mape po prostoriji (naziv prostorije → slika). */
  floorBackgrounds: Record<string, string>;
  /** Gosti naručuju skeniranjem QR koda na stolu (naplata ostaje konobaru). */
  qrOrdering: boolean;
  /** Adresa koju telefoni gostiju otvaraju (npr. http://192.168.1.10:3000); prazno = adresa ADMIN-a. */
  qrBaseUrl: string;
}
const DEFAULTS: KasaSettings = {
  pinPerTable: true, companyName: '', pib: '', storeName: '', address: '', city: '', esirNumber: '', bankAccount: '', phone: '', email: '', website: '', registrationNo: '', receiptHeader: '', receiptFooter: 'Hvala na poseti!', receiptLogo: null, receiptLogoPreview: null,
  receiptFooterImage: null, receiptFooterImagePreview: null, receiptExtraFrom: '', receiptExtraTo: '', representationPrint: 'FISCAL',
  ticketLarge: true, fiscalMode: 'NONE', lpfrUrl: '', vpfrUrl: '', screensaverText: '', screensaverImage: null, floorBackgrounds: {}, qrOrdering: true, qrBaseUrl: '',
};
const IMG_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const URL_RE = /^(https?:\/\/\S+)?$/;
const kb = (s: string) => Math.round((s.length * 3) / 4 / 1024);

class KasaSettingsDto {
  @IsOptional() @IsBoolean() pinPerTable?: boolean;
  @IsOptional() @IsString() @Length(0, 120) companyName?: string;
  @IsOptional() @Matches(/^(\d{9})?$/, { message: 'PIB ima 9 cifara' }) pib?: string;
  @IsOptional() @IsString() @Length(0, 120) storeName?: string;
  @IsOptional() @IsString() @Length(0, 120) address?: string;
  @IsOptional() @IsString() @Length(0, 60) city?: string;
  @IsOptional() @IsString() @Length(0, 30) esirNumber?: string;
  @IsOptional() @IsString() @Length(0, 60) bankAccount?: string;
  @IsOptional() @IsString() @Length(0, 40) phone?: string;
  @IsOptional() @IsString() @Length(0, 80) email?: string;
  @IsOptional() @IsString() @Length(0, 80) website?: string;
  @IsOptional() @IsString() @Length(0, 20) registrationNo?: string;
  @IsOptional() @IsString() @Length(0, 300) receiptHeader?: string;
  @IsOptional() @IsString() @Length(0, 500) receiptFooter?: string;
  @IsOptional() @IsObject() receiptLogo?: RasterLogo | null;
  @IsOptional() @IsString() @MaxLength(300_000) receiptLogoPreview?: string | null;
  @IsOptional() @IsObject() receiptFooterImage?: RasterLogo | null;
  @IsOptional() @IsString() @MaxLength(300_000) receiptFooterImagePreview?: string | null;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/, { message: 'Datum: GGGG-MM-DD' }) receiptExtraFrom?: string;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/, { message: 'Datum: GGGG-MM-DD' }) receiptExtraTo?: string;
  @IsOptional() @IsIn(['FISCAL', 'SLIP']) representationPrint?: 'FISCAL' | 'SLIP';
  @IsOptional() @IsBoolean() ticketLarge?: boolean;
  @IsOptional() @IsIn(['NONE', 'LPFR', 'VPFR']) fiscalMode?: 'NONE' | 'LPFR' | 'VPFR';
  @IsOptional() @IsString() @Length(0, 200) @Matches(URL_RE, { message: 'Adresa mora početi sa http:// ili https://' }) lpfrUrl?: string;
  @IsOptional() @IsString() @Length(0, 200) @Matches(URL_RE, { message: 'Adresa mora početi sa http:// ili https://' }) vpfrUrl?: string;
  @IsOptional() @IsString() @Length(0, 120) screensaverText?: string;
  @IsOptional() @IsString() @MaxLength(1_200_000) screensaverImage?: string | null;
  @IsOptional() @IsObject() floorBackgrounds?: Record<string, string>;
  @IsOptional() @IsBoolean() qrOrdering?: boolean;
  @IsOptional() @IsString() @Length(0, 200) @Matches(URL_RE, { message: 'Adresa mora početi sa http:// ili https://' }) qrBaseUrl?: string;
}

@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(u: AuthUser): Promise<KasaSettings> {
    const [l] = await this.db.select({ settings: locations.settings }).from(locations).where(eq(locations.id, u.locationId));
    return { ...DEFAULTS, ...(l?.settings as Partial<KasaSettings> ?? {}) };
  }

  private validate(dto: KasaSettingsDto) {
    for (const [raster, what] of [[dto.receiptLogo, 'Logo'], [dto.receiptFooterImage, 'Slika na kraju računa']] as const) {
      if (!raster) continue;
      const { width, height, data } = raster as RasterLogo;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || width > 576 || width % 8 || height < 1 || height > 400 || typeof data !== 'string') {
        throw Invalid('INVALID_LOGO', `${what}: širina do 576 tačaka (deljiva sa 8), visina do 400`);
      }
      if (Buffer.from(data, 'base64').length !== (width / 8) * height) throw Invalid('INVALID_LOGO', `${what}: neispravni podaci slike`);
    }
    for (const img of [dto.receiptLogoPreview, dto.receiptFooterImagePreview, dto.screensaverImage]) if (img && !IMG_RE.test(img)) throw Invalid('INVALID_IMAGE', 'Slika mora biti PNG, JPEG ili WEBP');
    if (dto.floorBackgrounds) {
      const entries = Object.entries(dto.floorBackgrounds);
      if (entries.length > 30) throw Invalid('TOO_MANY', 'Najviše 30 prostorija');
      for (const [k, v] of entries) {
        if (typeof v !== 'string' || !IMG_RE.test(v)) throw Invalid('INVALID_IMAGE', `Pozadina "${k}": slika mora biti PNG, JPEG ili WEBP`);
        if (kb(v) > 900) throw Invalid('IMAGE_TOO_LARGE', `Pozadina "${k}" je veća od 900 KB`);
      }
    }
  }

  async update(u: AuthUser, dto: KasaSettingsDto) {
    this.validate(dto);
    return this.db.transaction(async (tx) => {
      const [l] = await tx.select({ settings: locations.settings }).from(locations).where(eq(locations.id, u.locationId)).for('update');
      // samo zaista poslata polja: polja DTO klase postoje i kao undefined i inače bi vratila ostala podešavanja na podrazumevana
      const sent = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
      const next = { ...DEFAULTS, ...(l?.settings as object ?? {}), ...sent };
      await tx.update(locations).set({ settings: next, updatedAt: new Date() }).where(eq(locations.id, u.locationId));
      // u reviziji bez slika (velike su)
      const { receiptLogo, receiptLogoPreview, receiptFooterImage, receiptFooterImagePreview, screensaverImage, floorBackgrounds, ...rest } = dto;
      await audit(tx, u, 'settings.kasa', 'location', u.locationId, { ...rest, images: !!(receiptLogo || receiptLogoPreview || receiptFooterImage || receiptFooterImagePreview || screensaverImage || floorBackgrounds) });
      return next as KasaSettings;
    });
  }
}

/** Podešavanja lokala za druge module (štampa računa i porudžbina). */
export async function locationSettings(db: Db | any, locationId: string): Promise<KasaSettings> {
  // bez velikih slika (pozadine mape, čuvar ekrana, pregled logoa): štampa ih ne koristi, a ovo se čita pri svakom slanju porudžbine
  const [l] = await db.select({ settings: sql<Partial<KasaSettings>>`${locations.settings} - 'floorBackgrounds' - 'screensaverImage' - 'receiptLogoPreview' - 'receiptFooterImagePreview'` })
    .from(locations).where(eq(locations.id, locationId));
  return { ...DEFAULTS, ...(l?.settings ?? {}) };
}

@ApiTags('settings') @ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}
  @Get('kasa') @RequirePermissions(P.ORDER_READ)
  get(@CurrentUser() u: AuthUser) { return this.svc.get(u); }
  @Put('kasa') @RequirePermissions(P.SETTINGS_MANAGE)
  update(@CurrentUser() u: AuthUser, @Body() dto: KasaSettingsDto) { return this.svc.update(u, dto); }
}

@Module({ controllers: [SettingsController], providers: [SettingsService] })
export class SettingsModule {}
