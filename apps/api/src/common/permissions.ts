/** Katalog prava. Proverava ih backend (PermissionsGuard) — UI ih koristi samo za prikaz. */
export const P = {
  CATALOG_READ: 'catalog.read',
  CATALOG_WRITE: 'catalog.write',
  TABLE_READ: 'table.read',
  TABLE_WRITE: 'table.write',
  ORDER_READ: 'order.read',
  ORDER_READ_ALL: 'order.read_all', // pregled tuđih računa
  ORDER_WRITE: 'order.write',
  ORDER_VOID: 'order.void', // storniranje poslatih stavki
  ORDER_TRANSFER: 'order.transfer', // promena konobara/stola
  PAYMENT_CREATE: 'payment.create',
  SHIFT_MANAGE: 'shift.manage',
  REPORT_READ: 'report.read',
  USER_MANAGE: 'user.manage',
  AUDIT_READ: 'audit.read',
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
      P.ORDER_WRITE, P.ORDER_VOID, P.ORDER_TRANSFER, P.PAYMENT_CREATE, P.SHIFT_MANAGE, P.REPORT_READ, P.AUDIT_READ],
  },
  {
    code: 'CASHIER', name: 'Kasir',
    permissions: [P.CATALOG_READ, P.TABLE_READ, P.ORDER_READ, P.ORDER_READ_ALL, P.ORDER_WRITE, P.PAYMENT_CREATE, P.SHIFT_MANAGE],
  },
  {
    code: 'WAITER', name: 'Konobar',
    permissions: [P.CATALOG_READ, P.TABLE_READ, P.ORDER_READ, P.ORDER_WRITE, P.PAYMENT_CREATE],
  },
  { code: 'KITCHEN', name: 'Kuhinja', permissions: [P.CATALOG_READ, P.ORDER_READ, P.ORDER_READ_ALL] },
];
