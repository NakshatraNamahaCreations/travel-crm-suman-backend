import { Organization } from '../models/Organization.js';
import { Plan } from '../models/Plan.js';
import { SubscriptionPayment } from '../models/SubscriptionPayment.js';
import { User } from '../models/User.js';
import { Query } from '../models/Query.js';
import { Booking } from '../models/Booking.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { seedMasterData } from '../seed/masterData.js';
import { collectOrgStats, statsFor } from './ownerOverview.controller.js';
import { SUBSCRIPTION_MODULES, normalizeModules, orgModules, planModules } from '../config/modules.js';
import { runWithTenant } from '../tenant/context.js';
import {
  readConnection,
  startConnection,
  readQr,
  endConnection,
  dropConnection,
} from './whatsappConnection.controller.js';

// Owner-panel handlers. These run WITHOUT a tenant context (the owner has no
// organization), so tenantPlugin is inert here — every query below passes its
// organization filter explicitly.

const orgSummary = (org, counts = {}) => ({
  ...org.toJSON(),
  subscriptionStatus: org.subscriptionStatus(),
  // Resolved list (an empty stored list means "everything"), so the panel never
  // has to re-implement that fallback.
  modules: orgModules(org),
  daysUntilExpiry: org.daysUntilExpiry(),
  ...counts,
});

// GET /api/owner/organizations — list with the headline usage numbers so the
// owner sees how much each client is actually using the CRM.
export const listOrganizations = asyncHandler(async (req, res) => {
  const orgs = await Organization.find().sort('-createdAt');
  const stats = await collectOrgStats();
  return ok(
    res,
    orgs.map((o) => {
      const s = statsFor(stats, o._id);
      return orgSummary(o, {
        users: s.users.total,
        queries: s.queries.total,
        bookings: s.bookings.total,
        bookedValue: s.bookings.totalAmount,
        collected: s.bookings.paidAmount,
        lastActivityAt: s.lastActivityAt,
      });
    })
  );
});

// POST /api/owner/organizations — create a company + its first admin.
export const createOrganization = asyncHandler(async (req, res) => {
  const { name, adminName, adminEmail, adminPassword, planId } = req.body || {};
  if (!name?.trim()) throw ApiError.badRequest('Company name is required');
  if (!adminName?.trim() || !adminEmail?.trim() || !adminPassword) {
    throw ApiError.badRequest('First admin name, email and password are required');
  }

  // Email is globally unique — check before creating anything.
  const emailTaken = await User.findOne({ email: adminEmail.toLowerCase().trim() });
  if (emailTaken) throw ApiError.conflict('Email already registered');

  const nameTaken = await Organization.findOne({ name: name.trim() });
  if (nameTaken) throw ApiError.conflict('A company with this name already exists');

  const subscription = {};
  if (planId) {
    const plan = await Plan.findById(planId);
    if (!plan) throw ApiError.badRequest('Plan not found');
    subscription.plan = plan._id;
    subscription.planName = plan.name;
    subscription.modules = planModules(plan);
  }

  const org = await Organization.create({
    name: name.trim(),
    createdBy: req.user._id,
    subscription,
  });

  try {
    const admin = await User.create({
      name: adminName.trim(),
      email: adminEmail.toLowerCase().trim(),
      password: adminPassword,
      role: 'admin',
      organization: org._id,
    });
    await OrgProfile.getFor(org._id); // profile from the config template
    await seedMasterData(org._id); // starter dropdowns / sources / tags
    return created(res, { organization: orgSummary(org, { users: 1 }), admin: admin.toJSON() });
  } catch (err) {
    // Roll back the half-created company so the name is reusable.
    await Organization.deleteOne({ _id: org._id }).catch(() => {});
    await OrgProfile.deleteOne({ organization: org._id }).catch(() => {});
    throw err;
  }
});

// GET /api/owner/organizations/:id
export const getOrganization = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id).populate('subscription.plan', 'name price durationMonths');
  if (!org) throw ApiError.notFound('Organization not found');
  const [users, payments, statsMap, recentQueries, recentBookings] = await Promise.all([
    User.find({ organization: org._id }).select('name email role isActive lastLoginAt createdAt').setOptions({ skipTenant: true }),
    SubscriptionPayment.find({ organization: org._id }).sort('-paidOn').populate('plan', 'name'),
    collectOrgStats([org._id]),
    Query.find({ organization: org._id })
      .select('queryNumber status guest.name startDate nights quotedAmount bookedAmount createdAt')
      .sort('-createdAt')
      .limit(10)
      .setOptions({ skipTenant: true }),
    Booking.find({ organization: org._id })
      .select('bookingNumber status title guest.name startDate totalAmount paidAmount createdAt')
      .sort('-createdAt')
      .limit(10)
      .setOptions({ skipTenant: true }),
  ]);

  const stats = statsFor(statsMap, org._id);
  return ok(res, {
    organization: orgSummary(org, {
      users: users.length,
      queries: stats.queries.total,
      bookings: stats.bookings.total,
    }),
    stats,
    users,
    recentQueries,
    recentBookings,
    subscriptionPayments: payments,
  });
});

// PATCH /api/owner/organizations/:id — rename / suspend / reactivate.
export const updateOrganization = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id);
  if (!org) throw ApiError.notFound('Organization not found');
  const { name, isActive, modules } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) throw ApiError.badRequest('Company name cannot be empty');
    org.name = name.trim();
  }
  if (isActive !== undefined) org.isActive = !!isActive;
  const nextModules = normalizeModules(modules);
  if (nextModules) {
    org.subscription = org.subscription || {};
    org.subscription.modules = nextModules;
  }
  await org.save();
  return ok(res, orgSummary(org));
});

// POST /api/owner/organizations/:id/subscription — record an offline payment
// and extend the subscription. Extends from the current expiry while still
// active, from today when lapsed.
export const recordSubscriptionPayment = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id);
  if (!org) throw ApiError.notFound('Organization not found');

  const { planId, months, amount, paidOn, notes, modules } = req.body || {};
  const plan = planId ? await Plan.findById(planId) : null;
  if (planId && !plan) throw ApiError.badRequest('Plan not found');

  const effectiveMonths = Number(months) || plan?.durationMonths || 1;
  if (effectiveMonths < 1) throw ApiError.badRequest('Months must be at least 1');

  // Explicit selection wins, else the plan's modules, else whatever the org
  // already had (a top-up that keeps the current entitlement).
  const effectiveModules =
    normalizeModules(modules) ?? (plan ? planModules(plan) : orgModules(org));

  const payment = await SubscriptionPayment.create({
    organization: org._id,
    plan: plan?._id,
    planName: plan?.name,
    amount: Number(amount) || plan?.price || 0,
    months: effectiveMonths,
    modules: effectiveModules,
    paidOn: paidOn ? new Date(paidOn) : new Date(),
    notes,
    recordedBy: req.user._id,
  });

  const current = org.subscription?.expiresAt;
  const base = current && current.getTime() > Date.now() ? new Date(current) : new Date();
  base.setMonth(base.getMonth() + effectiveMonths);
  org.subscription = {
    plan: plan?._id || org.subscription?.plan,
    planName: plan?.name || org.subscription?.planName,
    expiresAt: base,
    modules: effectiveModules,
  };
  await org.save();

  return created(res, { organization: orgSummary(org), payment });
});

// ---- Plans ----

// GET /api/owner/plans
export const listPlans = asyncHandler(async (req, res) => ok(res, await Plan.find().sort('price')));

// POST /api/owner/plans
export const createPlan = asyncHandler(async (req, res) => {
  const { name, price, durationMonths, description, modules } = req.body || {};
  if (!name?.trim()) throw ApiError.badRequest('Plan name is required');
  const plan = await Plan.create({
    name: name.trim(),
    price,
    durationMonths,
    description,
    modules: normalizeModules(modules),
  });
  return created(res, plan);
});

// PATCH /api/owner/plans/:id
export const updatePlan = asyncHandler(async (req, res) => {
  const plan = await Plan.findById(req.params.id);
  if (!plan) throw ApiError.notFound('Plan not found');
  const { name, price, durationMonths, description, isActive, modules } = req.body || {};
  if (name !== undefined) plan.name = name.trim();
  if (price !== undefined) plan.price = price;
  if (durationMonths !== undefined) plan.durationMonths = durationMonths;
  if (description !== undefined) plan.description = description;
  if (isActive !== undefined) plan.isActive = !!isActive;
  const nextModules = normalizeModules(modules);
  if (nextModules) plan.modules = nextModules;
  await plan.save();
  return ok(res, plan);
});

// GET /api/owner/modules — the module catalog the owner picks from.
export const listModules = asyncHandler(async (req, res) => ok(res, SUBSCRIPTION_MODULES));

// ── A company's WhatsApp number, managed on its behalf ───────────────────────
//
// The platform owner sets WhatsApp up for a client company, so these run the tenant-facing
// operations inside that company's tenant context rather than reimplementing them. One
// implementation decides which number sends; a second copy here could drift from it, and the
// consequence of drift is a guest hearing from the wrong company.

/** The organization these endpoints act on, or a 404 when the id names nothing. */
async function orgOr404(id) {
  const org = await Organization.findById(id).select('_id name');
  if (!org) throw ApiError.notFound('Organization not found');
  return org;
}

// GET /api/owner/organizations/:id/whatsapp
export const getOrgWhatsapp = asyncHandler(async (req, res) => {
  const org = await orgOr404(req.params.id);
  const state = await runWithTenant(org._id, () => readConnection(req.user?._id));
  return ok(res, { company: org.name, ...state });
});

// POST /api/owner/organizations/:id/whatsapp/connect
export const connectOrgWhatsapp = asyncHandler(async (req, res) => {
  const org = await orgOr404(req.params.id);
  const state = await runWithTenant(org._id, () => startConnection(org._id, req.user?._id));
  return state.alreadyConnected ? ok(res, state) : created(res, state);
});

// GET /api/owner/organizations/:id/whatsapp/qr
export const getOrgWhatsappQr = asyncHandler(async (req, res) => {
  const org = await orgOr404(req.params.id);
  return ok(res, await runWithTenant(org._id, () => readQr(req.user?._id)));
});

// POST /api/owner/organizations/:id/whatsapp/disconnect
export const disconnectOrgWhatsapp = asyncHandler(async (req, res) => {
  const org = await orgOr404(req.params.id);
  return ok(res, await runWithTenant(org._id, () => endConnection(req.user?._id)));
});

// DELETE /api/owner/organizations/:id/whatsapp
export const removeOrgWhatsapp = asyncHandler(async (req, res) => {
  const org = await orgOr404(req.params.id);
  return ok(res, await runWithTenant(org._id, () => dropConnection(req.user?._id)));
});
