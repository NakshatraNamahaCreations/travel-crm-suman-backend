// Fine-grained permission catalog layered on top of roles.
//
// Each user's effective permission for a key is resolved as:
//   1. explicit per-user override (user.permissionOverrides[key], true/false) — wins if set
//   2. otherwise the role default (see ROLE_DEFAULTS / SUPER_ROLES below)
//
// The role defaults below intentionally mirror the pre-permission route
// `authorize(...)` lists, so turning the system on does not change any
// existing access — admins simply gain the ability to grant/revoke per user.

export const PERMISSION_MODULES = [
  { key: 'trips', label: 'Trips / Queries', actions: ['create', 'edit', 'delete'] },
  { key: 'quotes', label: 'Quotes & Itineraries', actions: ['create', 'edit', 'delete'] },
  { key: 'bookings', label: 'Bookings', actions: ['create', 'cancel'] },
  { key: 'payments', label: 'Payments', actions: ['create', 'cancel'] },
  { key: 'invoices', label: 'Invoices (Proforma / GST)', actions: ['create', 'edit', 'delete'] },
  { key: 'accounting', label: 'Accounts & Transactions', actions: ['create', 'edit', 'delete'] },
  { key: 'hotels', label: 'Hotels & Hotel Prices', actions: ['create', 'edit', 'delete'] },
  { key: 'transport', label: 'Transport & Prices', actions: ['create', 'edit', 'delete'] },
  { key: 'activities', label: 'Activities & Prices', actions: ['create', 'edit', 'delete'] },
  { key: 'masterdata', label: 'Destinations, Cities, Tags & Sources', actions: ['create', 'edit', 'delete'] },
  { key: 'teams', label: 'Teams', actions: ['create', 'edit', 'delete'] },
  { key: 'settings', label: 'Organization Profile', actions: ['edit'] },
  { key: 'imports', label: 'Excel Imports', actions: ['create'] },
  { key: 'users', label: 'Users', actions: ['create', 'edit', 'delete'] },
  { key: 'whatsapp', label: 'WhatsApp Templates', actions: ['create', 'edit', 'delete'] },
  { key: 'leads', label: 'Lead Sources, Tracking & Assignment', actions: ['edit', 'assign'] },
];

export const ACTION_LABELS = {
  create: 'Create / Add',
  edit: 'Edit',
  delete: 'Delete',
  cancel: 'Cancel / Delete',
  assign: 'Reassign leads',
};

export const ALL_PERMISSIONS = PERMISSION_MODULES.flatMap((m) =>
  m.actions.map((a) => `${m.key}.${a}`)
);

// Roles that implicitly hold every permission.
export const SUPER_ROLES = ['admin', 'manager'];

// Baseline grants for the remaining roles (mirrors previous route authorize lists).
const BASE = [
  'trips.create', 'trips.edit', 'bookings.create',
  // Quoting has always been part of the sales flow, so it stays with BASE to
  // avoid changing anyone's existing access when these keys were introduced.
  'quotes.create', 'quotes.edit',
];
export const ROLE_DEFAULTS = {
  sales: [...BASE],
  operations: [
    ...BASE,
    'hotels.create', 'hotels.edit', 'hotels.delete',
    'transport.create', 'transport.edit', 'transport.delete',
    'activities.create', 'activities.edit', 'activities.delete',
    'masterdata.create', 'masterdata.edit',
    'imports.create',
  ],
  accounts: [
    ...BASE,
    'payments.create', 'payments.cancel',
    'invoices.create', 'invoices.edit', 'invoices.delete',
    'accounting.create', 'accounting.edit', 'accounting.delete',
  ],
};

export function roleDefaults(role) {
  if (SUPER_ROLES.includes(role)) return ALL_PERMISSIONS;
  return ROLE_DEFAULTS[role] || [];
}

// Permission keys are dotted ("bookings.cancel") but Mongoose Map keys cannot
// contain dots, so they are stored with ':' and translated at the persistence
// boundary. The API contract stays dotted in both directions.
export const encodePermissionKey = (k) => String(k).replace(/\./g, ':');
export const decodePermissionKey = (k) => String(k).replace(/:/g, '.');

// Reads an override from either a Mongoose Map or a plain object, accepting
// the stored (encoded) key and the dotted form for any pre-existing data.
function readOverride(overrides, key) {
  if (!overrides) return undefined;
  const enc = encodePermissionKey(key);
  if (typeof overrides.get === 'function') {
    const v = overrides.get(enc);
    return v === undefined ? overrides.get(key) : v;
  }
  return overrides[enc] === undefined ? overrides[key] : overrides[enc];
}

export function userCan(user, key) {
  if (!user) return false;
  const ov = readOverride(user.permissionOverrides, key);
  if (ov !== undefined && ov !== null) return !!ov;
  return roleDefaults(user.role).includes(key);
}

// Flat list of every permission this user effectively holds (sent to the client).
export function effectivePermissions(user) {
  return ALL_PERMISSIONS.filter((k) => userCan(user, k));
}
