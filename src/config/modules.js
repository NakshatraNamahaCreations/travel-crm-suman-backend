// Subscription modules — which parts of the CRM a tenant's plan includes.
//
// Distinct from config/permissions.js: a permission decides what a USER may do
// inside a module, a module decides whether the ORGANIZATION bought that part
// of the product at all. The owner picks modules on a plan (defaults) and may
// override them per company when recording a payment.
//
// A module the organization does not hold is hidden in the client nav and
// refused by the API (403 MODULE_NOT_IN_PLAN).

export const SUBSCRIPTION_MODULES = [
  { key: 'trips', label: 'Trips & Quotes', description: 'Queries, quotes, itineraries, sales reports' },
  { key: 'bookings', label: 'Bookings', description: 'Bookings, hotel check-ins, operational views' },
  { key: 'accounting', label: 'Accounting', description: 'Payments, invoices, accounts, transactions' },
  { key: 'tasks', label: 'Tasks', description: 'Task list and follow-ups' },
  { key: 'hotels', label: 'Hotels', description: 'Hotel inventory and hotel prices' },
  { key: 'transport', label: 'Transport', description: 'Transport services and transport prices' },
  { key: 'activities', label: 'Travel Activities', description: 'Activities and activity prices' },
  { key: 'whatsapp', label: 'WhatsApp Templates', description: 'Message templates sent to guests over WhatsApp' },
  { key: 'leads', label: 'Lead Sources & Assignment', description: 'Ad attribution, tracking links, automatic lead routing' },
];

export const MODULE_KEYS = SUBSCRIPTION_MODULES.map((m) => m.key);

// Drops unknown keys and keeps the catalog order so stored lists are stable.
// Returns undefined for a non-array so callers can tell "not supplied" from
// "supplied empty".
export function normalizeModules(input) {
  if (!Array.isArray(input)) return undefined;
  return MODULE_KEYS.filter((k) => input.includes(k));
}

// Modules an organization may use.
//
// An ABSENT list means the owner has never configured modules for this company,
// which grants everything — companies created before modules existed keep full
// access. A STORED list is taken literally, including an empty one, so the
// owner can switch every module off from the panel.
export function orgModules(org) {
  const m = org?.subscription?.modules;
  if (!Array.isArray(m)) return [...MODULE_KEYS];
  return m.filter((k) => MODULE_KEYS.includes(k));
}

// Same rule for a plan's own module list, used as the default when the owner
// records a payment.
export function planModules(plan) {
  const m = plan?.modules;
  if (!Array.isArray(m)) return [...MODULE_KEYS];
  return m.filter((k) => MODULE_KEYS.includes(k));
}

export function orgHasModule(org, key) {
  return orgModules(org).includes(key);
}
