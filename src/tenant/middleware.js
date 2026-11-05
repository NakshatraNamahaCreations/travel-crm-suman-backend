import { ApiError } from '../utils/ApiError.js';
import { runWithTenant } from './context.js';

// Runs after `protect`. Establishes the tenant context for the rest of the
// request so tenantPlugin scopes every DB call to the caller's organization.
// The platform owner has no organization and only uses /api/owner/* and
// /api/auth/* — owners reaching tenant routes are rejected outright.
export function tenantContext(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  if (req.user.role === 'owner') {
    return next(ApiError.forbidden('Platform owner cannot access tenant APIs'));
  }
  if (!req.user.organization) {
    return next(ApiError.forbidden('Account is not linked to an organization'));
  }
  return runWithTenant(req.user.organization, () => next());
}

// Multer (file uploads) parses the request from raw socket events, which do
// NOT inherit the AsyncLocalStorage context set by tenantContext — everything
// after `upload.single(...)` would run unscoped and save org-less documents.
// Place this middleware immediately AFTER any multer middleware to re-enter
// the caller's tenant context.
export function retenant(req, res, next) {
  if (req.user && req.user.role !== 'owner' && req.user.organization) {
    return runWithTenant(req.user.organization, () => next());
  }
  return next();
}
