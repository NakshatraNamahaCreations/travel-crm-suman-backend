import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User } from '../models/User.js';
import { Organization } from '../models/Organization.js';
import { userCan } from '../config/permissions.js';
import { orgHasModule } from '../config/modules.js';

// Throws when a tenant organization must not be served. Shared by `protect`
// and the login flow so lockout applies to existing sessions and new logins
// alike.
//
// Lockout is deliberately MANUAL: a lapsed subscription does NOT cut access on
// its own. An expired client keeps working and keeps seeing the renewal banner
// until the platform owner suspends the company (isActive) or switches off its
// modules from the owner panel — so nobody is locked out of a live operation by
// a date rolling over.
export function assertOrgAccess(org) {
  if (!org || !org.isActive) {
    throw ApiError.forbidden('Your organization is suspended. Contact support.', 'ORG_SUSPENDED');
  }
}

// Verifies the Bearer token (or auth cookie) and attaches req.user.
// For tenant users the organization is loaded and verified (active +
// subscription not expired) on every request, so owner-side suspension takes
// effect immediately.
export const protect = asyncHandler(async (req, res, next) => {
  let token;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1];
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  }

  if (!token) throw ApiError.unauthorized('Not authenticated');

  let decoded;
  try {
    decoded = jwt.verify(token, env.jwtSecret);
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }

  // No tenant context exists yet at this point, so this lookup is unscoped by
  // design; the _id filter is sufficient.
  const user = await User.findById(decoded.sub).select('+isActive');
  if (!user || !user.isActive) throw ApiError.unauthorized('Account not found or disabled');

  if (user.role !== 'owner') {
    const org = await Organization.findById(user.organization).select('isActive subscription');
    assertOrgAccess(org);
    req.organization = org;
    req.organizationId = user.organization;
  }

  req.user = user;
  next();
});

// Restricts a route to one or more roles. Usage: authorize('admin', 'manager')
export const authorize =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };

// Restricts a route to users holding a fine-grained permission key.
// Usage: can('payments.cancel'). Resolves role defaults + per-user overrides.
export const can =
  (key) =>
  (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!userCan(req.user, key)) {
      return next(ApiError.forbidden(`You don't have permission to perform this action (${key})`));
    }
    next();
  };

// Refuses a route when the caller's organization holds none of the modules
// that own it. Pass several keys for a route shared by modules (e.g. reports,
// served to both Trips and Bookings subscribers) — any one of them lets it
// through. The platform owner has no organization and is exempt.
// Usage: requireModule('accounting') / requireModule('trips', 'bookings')
export const requireModule =
  (...keys) =>
  (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === 'owner') return next();
    if (!keys.some((k) => orgHasModule(req.organization, k))) {
      return next(
        ApiError.forbidden(
          'This module is not included in your subscription plan. Contact support to upgrade.',
          'MODULE_NOT_IN_PLAN'
        )
      );
    }
    next();
  };
