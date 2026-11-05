import { Organization } from '../models/Organization.js';
import { SubscriptionPayment } from '../models/SubscriptionPayment.js';
import { User } from '../models/User.js';
import { Query } from '../models/Query.js';
import { Quote } from '../models/Quote.js';
import { Booking } from '../models/Booking.js';
import { Payment } from '../models/Payment.js';
import { Installment } from '../models/Installment.js';
import { GstInvoice } from '../models/GstInvoice.js';
import { Hotel } from '../models/Hotel.js';
import { TransportService } from '../models/TransportService.js';
import { TravelActivity } from '../models/TravelActivity.js';
import { Destination } from '../models/Destination.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { ACTIVE_STATUSES } from '../constants/queryStatus.js';

// Cross-tenant rollups for the owner panel. These run without a tenant
// context, so tenantPlugin's $match is never injected — every pipeline below
// groups by `organization` on purpose, and skipTenant keeps that intent
// explicit even if a context ever wraps these calls.
const AGG = { skipTenant: true };

const WON_STATUSES = ['converted', 'on_trip', 'past'];
const LOST_STATUSES = ['canceled', 'dropped'];

const key = (v) => (v ? String(v) : '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const latest = (...dates) => {
  const ts = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return ts.length ? new Date(Math.max(...ts)) : null;
};

const emptyStats = () => ({
  users: { total: 0, active: 0, lastLoginAt: null },
  queries: { total: 0, active: 0, converted: 0, lost: 0, quotedAmount: 0, bookedAmount: 0, profit: 0, lastAt: null },
  quotes: { total: 0, lastAt: null },
  bookings: {
    total: 0, confirmed: 0, onTrip: 0, completed: 0, cancelled: 0,
    totalAmount: 0, paidAmount: 0, balanceDue: 0, lastAt: null,
  },
  payments: { inCount: 0, inAmount: 0, outCount: 0, outAmount: 0, net: 0 },
  installments: { incomingPending: 0, outgoingPending: 0, overdueCount: 0 },
  invoices: { count: 0, amount: 0, taxable: 0, tax: 0 },
  services: { hotels: 0, transport: 0, activities: 0, destinations: 0 },
  subscription: { paymentsCount: 0, paidTotal: 0, lastPaidOn: null },
  lastActivityAt: null,
});

// One stats object per organization, keyed by org id string.
// `orgIds` null = every tenant on the platform.
export async function collectOrgStats(orgIds = null) {
  const scope = orgIds?.length ? { organization: { $in: orgIds } } : null;
  const pre = scope ? [{ $match: scope }] : [];
  const countByOrg = (Model) => Model.aggregate([...pre, { $group: { _id: '$organization', n: { $sum: 1 } } }], AGG);

  const [
    users, queries, quotes, bookings, payments, installments,
    invoices, hotels, transport, activities, destinations, subs,
  ] = await Promise.all([
    User.aggregate(
      [
        { $match: { organization: { $ne: null }, ...(scope || {}) } },
        {
          $group: {
            _id: '$organization',
            total: { $sum: 1 },
            active: { $sum: { $cond: ['$isActive', 1, 0] } },
            lastLoginAt: { $max: '$lastLoginAt' },
          },
        },
      ],
      AGG
    ),
    Query.aggregate(
      [
        ...pre,
        {
          $group: {
            _id: '$organization',
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $in: ['$status', ACTIVE_STATUSES] }, 1, 0] } },
            converted: { $sum: { $cond: [{ $in: ['$status', WON_STATUSES] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $in: ['$status', LOST_STATUSES] }, 1, 0] } },
            quotedAmount: { $sum: '$quotedAmount' },
            bookedAmount: { $sum: '$bookedAmount' },
            profit: { $sum: '$profit' },
            lastAt: { $max: '$createdAt' },
          },
        },
      ],
      AGG
    ),
    Quote.aggregate([...pre, { $group: { _id: '$organization', total: { $sum: 1 }, lastAt: { $max: '$createdAt' } } }], AGG),
    Booking.aggregate(
      [
        ...pre,
        {
          $group: {
            _id: '$organization',
            total: { $sum: 1 },
            confirmed: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0] } },
            onTrip: { $sum: { $cond: [{ $eq: ['$status', 'on_trip'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            totalAmount: { $sum: '$totalAmount' },
            paidAmount: { $sum: '$paidAmount' },
            lastAt: { $max: '$createdAt' },
          },
        },
      ],
      AGG
    ),
    Payment.aggregate(
      [...pre, { $group: { _id: { org: '$organization', party: '$party' }, n: { $sum: 1 }, amount: { $sum: '$amount' } } }],
      AGG
    ),
    Installment.aggregate(
      [
        ...pre,
        { $match: { paid: { $ne: true } } },
        {
          $group: {
            _id: { org: '$organization', direction: '$direction' },
            amount: { $sum: '$amount' },
            overdue: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, 1, 0] } },
          },
        },
      ],
      AGG
    ),
    GstInvoice.aggregate(
      [
        ...pre,
        {
          $group: {
            _id: '$organization',
            count: { $sum: 1 },
            amount: { $sum: '$amount' },
            taxable: { $sum: '$taxableValue' },
            tax: { $sum: { $add: ['$cgst', '$sgst', '$igst'] } },
          },
        },
      ],
      AGG
    ),
    countByOrg(Hotel),
    countByOrg(TransportService),
    countByOrg(TravelActivity),
    countByOrg(Destination),
    SubscriptionPayment.aggregate(
      [...pre, { $group: { _id: '$organization', n: { $sum: 1 }, amount: { $sum: '$amount' }, lastPaidOn: { $max: '$paidOn' } } }],
      AGG
    ),
  ]);

  const out = new Map();
  const slot = (id) => {
    const k = key(id);
    if (!k) return null;
    if (!out.has(k)) out.set(k, emptyStats());
    return out.get(k);
  };

  for (const r of users) {
    const s = slot(r._id);
    if (s) s.users = { total: r.total, active: r.active, lastLoginAt: r.lastLoginAt || null };
  }
  for (const r of queries) {
    const s = slot(r._id);
    if (!s) continue;
    s.queries = {
      total: r.total,
      active: r.active,
      converted: r.converted,
      lost: r.lost,
      quotedAmount: round2(r.quotedAmount),
      bookedAmount: round2(r.bookedAmount),
      profit: round2(r.profit),
      lastAt: r.lastAt || null,
    };
  }
  for (const r of quotes) {
    const s = slot(r._id);
    if (s) s.quotes = { total: r.total, lastAt: r.lastAt || null };
  }
  for (const r of bookings) {
    const s = slot(r._id);
    if (!s) continue;
    s.bookings = {
      total: r.total,
      confirmed: r.confirmed,
      onTrip: r.onTrip,
      completed: r.completed,
      cancelled: r.cancelled,
      totalAmount: round2(r.totalAmount),
      paidAmount: round2(r.paidAmount),
      balanceDue: round2(Math.max(0, (r.totalAmount || 0) - (r.paidAmount || 0))),
      lastAt: r.lastAt || null,
    };
  }
  for (const r of payments) {
    const s = slot(r._id?.org);
    if (!s) continue;
    if (r._id.party === 'supplier') {
      s.payments.outCount = r.n;
      s.payments.outAmount = round2(r.amount);
    } else {
      s.payments.inCount = r.n;
      s.payments.inAmount = round2(r.amount);
    }
    s.payments.net = round2(s.payments.inAmount - s.payments.outAmount);
  }
  for (const r of installments) {
    const s = slot(r._id?.org);
    if (!s) continue;
    if (r._id.direction === 'outgoing') s.installments.outgoingPending = round2(r.amount);
    else s.installments.incomingPending = round2(r.amount);
    s.installments.overdueCount += r.overdue || 0;
  }
  for (const r of invoices) {
    const s = slot(r._id);
    if (s) s.invoices = { count: r.count, amount: round2(r.amount), taxable: round2(r.taxable), tax: round2(r.tax) };
  }
  const applyCount = (rows, field) => {
    for (const r of rows) {
      const s = slot(r._id);
      if (s) s.services[field] = r.n;
    }
  };
  applyCount(hotels, 'hotels');
  applyCount(transport, 'transport');
  applyCount(activities, 'activities');
  applyCount(destinations, 'destinations');
  for (const r of subs) {
    const s = slot(r._id);
    if (s) s.subscription = { paymentsCount: r.n, paidTotal: round2(r.amount), lastPaidOn: r.lastPaidOn || null };
  }

  for (const s of out.values()) {
    s.lastActivityAt = latest(s.queries.lastAt, s.bookings.lastAt, s.quotes.lastAt, s.users.lastLoginAt);
  }
  return out;
}

// Stats for one org, with a zeroed shape when the company has no data yet.
export const statsFor = (map, orgId) => map.get(key(orgId)) || emptyStats();

// GET /api/owner/overview — platform totals plus a client-wise rollup row for
// every tenant company.
export const platformOverview = asyncHandler(async (req, res) => {
  const orgs = await Organization.find().sort('-createdAt');
  const stats = await collectOrgStats();

  const companies = orgs.map((org) => ({
    _id: org._id,
    name: org.name,
    slug: org.slug,
    isActive: org.isActive,
    createdAt: org.createdAt,
    subscriptionStatus: org.subscriptionStatus(),
    subscription: org.subscription,
    ...statsFor(stats, org._id),
  }));

  const sum = (pick) => round2(companies.reduce((a, c) => a + (Number(pick(c)) || 0), 0));
  const totals = {
    companies: companies.length,
    activeCompanies: companies.filter((c) => c.isActive && c.subscriptionStatus !== 'expired').length,
    suspended: companies.filter((c) => !c.isActive).length,
    expiring: companies.filter((c) => c.isActive && c.subscriptionStatus === 'expiring').length,
    expired: companies.filter((c) => c.isActive && c.subscriptionStatus === 'expired').length,
    users: sum((c) => c.users.total),
    queries: sum((c) => c.queries.total),
    activeQueries: sum((c) => c.queries.active),
    quotes: sum((c) => c.quotes.total),
    bookings: sum((c) => c.bookings.total),
    bookedValue: sum((c) => c.bookings.totalAmount),
    collected: sum((c) => c.bookings.paidAmount),
    balanceDue: sum((c) => c.bookings.balanceDue),
    supplierPaid: sum((c) => c.payments.outAmount),
    invoices: sum((c) => c.invoices.count),
    invoiceAmount: sum((c) => c.invoices.amount),
    gstCollected: sum((c) => c.invoices.tax),
    subscriptionRevenue: sum((c) => c.subscription.paidTotal),
  };

  return ok(res, { totals, companies, generatedAt: new Date() });
});
