import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request tenant identity, set once by the tenantContext middleware and
// read by tenantPlugin's query hooks. AsyncLocalStorage survives awaits, so
// every DB call in a request handler sees the caller's organization without
// threading it through arguments.
//
// When no store exists (login, seeds, migrations, owner-panel requests) the
// plugin is a deliberate no-op — those code paths pass organization filters
// explicitly where needed.
export const tenantALS = new AsyncLocalStorage();

export const getTenantId = () => tenantALS.getStore()?.orgId ?? null;

export const runWithTenant = (orgId, fn) =>
  tenantALS.run({ orgId: orgId ? orgId.toString() : null }, fn);

// Sets the tenant context for the remainder of the current execution. Meant
// for CLI scripts (seeds / importers) right after connectDB(); request-scoped
// code must use runWithTenant instead.
export const enterTenant = (orgId) =>
  tenantALS.enterWith({ orgId: orgId ? orgId.toString() : null });
