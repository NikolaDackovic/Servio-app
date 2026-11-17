/** Katalog prava. Proverava ih backend (PermissionsGuard) - UI ih koristi samo za prikaz. */
export const P = {
  CATALOG_READ: 'catalog.read',
  CATALOG_WRITE: 'catalog.write',
  TABLE_READ: 'table.read',
  TABLE_WRITE: 'table.write',
  ORDER_READ: 'order.read',
  ORDER_READ_ALL: 'order.read_all', // pregled tuđih računa
  ORDER_WRITE: 'order.write',
  ORDER_VOID: 'order.void', // storniranje poslatih stavki
  ORDER_REFUND: 'order.refund', // povraćaj novca: refundacija naplaćenog računa (fiskalno REFUND, roba nazad na lager)
  ORDER_TRANSFER: 'order.transfer', // promena konobara/stola
  ORDER_SPLIT: 'order.split', // rastavljanje: prebacivanje dela stavki ili celog računa na drugi sto
  PAYMENT_CREATE: 'payment.create',
  ORDER_DISCOUNT: 'order.discount', // primena popusta na računu
  DISCOUNT_MANAGE: 'discount.manage', // definisanje popusta (ADMIN)
  SHIFT_MANAGE: 'shift.manage',
  DAY_MANAGE: 'day.manage', // otvaranje i zaključak poslovnog dana
  REPORT_READ: 'report.read',
  USER_MANAGE: 'user.manage',
  AUDIT_READ: 'audit.read',
  KDS_USE: 'kds.use', // rad na KDS ekranu (statusi tiketa i stavki)
  SETTINGS_MANAGE: 'settings.manage', // pripremne pozicije, štampači, Print Bridge, fiskalni pregled
  STOCK_READ: 'stock.read', // stanje lagera, kartica artikla, dokumenta (pregled)
  STOCK_WRITE: 'stock.write', // partneri, skladišta, nacrti dokumenata, normativi, uvoz
  STOCK_POST: 'stock.post', // knjiženje i storniranje robnih dokumenata
} as const;

export type Permission = (typeof P)[keyof typeof P];
export const ALL_PERMISSIONS: Permission[] = Object.values(P);

/** Podrazumevane uloge koje seed kreira za novu organizaciju. */
export const DEFAULT_ROLES: { code: string; name: string; permissions: Permission[] }[] = [
  { code: 'ADMIN', name: 'Administrator', permissions: ALL_PERMISSIONS },
  { code: 'OWNER', name: 'Vlasnik', permissions: ALL_PERMISSIONS },
  {
    code: 'MANAGER', name: 'Menadžer',
    permissions: [P.CATALOG_READ, P.CATALOG_WRITE, P.TABLE_READ, P.TABLE_WRITE, P.ORDER_READ, P.ORDER_READ_ALL,
      P.ORDER_WRITE, P.ORDER_VOID, P.ORDER_REFUND, P.ORDER_TRANSFER, P.ORDER_SPLIT, P.PAYMENT_CREATE, P.ORDER_DISCOUNT, P.DISCOUNT_MANAGE, P.SHIFT_MANAGE, P.DAY_MANAGE, P.REPORT_READ, P.AUDIT_READ, P.KDS_USE, P.SETTINGS_MANAGE,
      P.STOCK_READ, P.STOCK_WRITE, P.STOCK_POST],
  },
  {
    code: 'CASHIER', name: 'Kasir',
    permissions: [P.CATALOG_READ, P.TABLE_READ, P.ORDER_READ, P.ORDER_READ_ALL, P.ORDER_WRITE, P.ORDER_SPLIT, P.PAYMENT_CREATE, P.ORDER_DISCOUNT, P.SHIFT_MANAGE, P.DAY_MANAGE, P.KDS_USE],
  },
  {
    code: 'WAITER', name: 'Konobar',
    // u ADMIN-u: smene (spajanje, podela), specifikacija pazara; na kasi i otvaranje/zatvaranje smene
    permissions: [P.CATALOG_READ, P.TABLE_READ, P.ORDER_READ, P.ORDER_WRITE, P.ORDER_SPLIT, P.PAYMENT_CREATE, P.ORDER_DISCOUNT, P.SHIFT_MANAGE, P.DAY_MANAGE, P.REPORT_READ],
  },
  { code: 'KITCHEN', name: 'Kuhinja', permissions: [P.CATALOG_READ, P.ORDER_READ, P.ORDER_READ_ALL, P.KDS_USE] },
  /** Šanker: kao konobar, plus ekran šanka (KDS). */
  { code: 'BARTENDER', name: 'Šanker', permissions: [P.CATALOG_READ, P.TABLE_READ, P.ORDER_READ, P.ORDER_WRITE, P.ORDER_SPLIT, P.PAYMENT_CREATE, P.ORDER_DISCOUNT, P.KDS_USE, P.SHIFT_MANAGE, P.DAY_MANAGE, P.REPORT_READ] },
  /** Knjigovođa: robna dokumenta, stanje, izveštaji i dnevnik - bez rada na kasi. */
  { code: 'ACCOUNTANT', name: 'Knjigovođa', permissions: [P.CATALOG_READ, P.REPORT_READ, P.AUDIT_READ, P.STOCK_READ, P.STOCK_WRITE, P.STOCK_POST] },
];

/** Opis prava za ADMIN (Korisnici → Uloge i prava): grupa i naziv na srpskom. */
export const PERMISSION_INFO: { code: Permission; group: string; label: string }[] = [
  { code: P.ORDER_READ, group: 'Kasa', label: 'Rad na kasi (pregled svojih računa)' },
  { code: P.ORDER_WRITE, group: 'Kasa', label: 'Kucanje (otvaranje stola, artikli, slanje)' },
  { code: P.PAYMENT_CREATE, group: 'Kasa', label: 'Naplata' },
  { code: P.ORDER_DISCOUNT, group: 'Kasa', label: 'Popust na računu' },
  { code: P.ORDER_READ_ALL, group: 'Kasa', label: 'Pregled tuđih računa i stolova' },
  { code: P.ORDER_VOID, group: 'Kasa', label: 'Storniranje' },
  { code: P.ORDER_REFUND, group: 'Kasa', label: 'Povraćaj novca (refundacija naplaćenog računa)' },
  { code: P.ORDER_TRANSFER, group: 'Kasa', label: 'Prebacivanje tuđih računa drugom konobaru' },
  { code: P.ORDER_SPLIT, group: 'Kasa', label: 'Rastavljanje i prebacivanje stola (stavke, ceo sto)' },
  { code: P.SHIFT_MANAGE, group: 'Smena', label: 'Otvaranje i zatvaranje smene' },
  { code: P.DAY_MANAGE, group: 'Smena', label: 'Kraj dana (razduživanje, prodaja)' },
  { code: P.REPORT_READ, group: 'Smena', label: 'Izveštaji i specifikacija pazara' },
  { code: P.KDS_USE, group: 'Kuhinja', label: 'Rad na ekranu kuhinje (KDS)' },
  { code: P.CATALOG_READ, group: 'ADMIN', label: 'Pregled proizvoda' },
  { code: P.CATALOG_WRITE, group: 'ADMIN', label: 'Proizvodi, grupe i cene' },
  { code: P.TABLE_READ, group: 'ADMIN', label: 'Pregled stolova' },
  { code: P.TABLE_WRITE, group: 'ADMIN', label: 'Mapa stolova' },
  { code: P.DISCOUNT_MANAGE, group: 'ADMIN', label: 'Popusti i cenovnici' },
  { code: P.STOCK_READ, group: 'ADMIN', label: 'Pregled robe (stanje, kartica)' },
  { code: P.STOCK_WRITE, group: 'ADMIN', label: 'Dokumenta, partneri, normativi, uvoz' },
  { code: P.STOCK_POST, group: 'ADMIN', label: 'Knjiženje i storno dokumenata' },
  { code: P.SETTINGS_MANAGE, group: 'ADMIN', label: 'Štampanje i podešavanja' },
  { code: P.USER_MANAGE, group: 'ADMIN', label: 'Korisnici, uloge i prava' },
  { code: P.AUDIT_READ, group: 'ADMIN', label: 'Revizijski trag' },
];
