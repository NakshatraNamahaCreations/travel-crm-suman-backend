import mongoose from 'mongoose';
import { Query } from '../models/Query.js';
import { Quote } from '../models/Quote.js';
import { Booking } from '../models/Booking.js';
import { Comment } from '../models/Comment.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { ownScope, applyScope } from '../utils/ownScope.js';
import { ApiError } from '../utils/ApiError.js';

// Statuses that represent a "won" sale.
const WON = ['converted', 'on_trip', 'past'];

function rangeFromQuery(q) {
  const now = new Date();
  const after = q.after ? new Date(q.after) : new Date(now.getFullYear(), now.getMonth(), 1);
  const before = q.before
    ? new Date(new Date(q.before).setHours(23, 59, 59, 999))
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { after, before };
}

/* -------------------------- date-bucket helpers -------------------------- */
function dayRange(offsetDays = 0) {
  const n = new Date();
  return {
    after: new Date(n.getFullYear(), n.getMonth(), n.getDate() + offsetDays, 0, 0, 0, 0),
    before: new Date(n.getFullYear(), n.getMonth(), n.getDate() + offsetDays, 23, 59, 59, 999),
  };
}
function spanRange(startOffset, endOffset) {
  return { after: dayRange(startOffset).after, before: dayRange(endOffset).before };
}
function weekRange() {
  const n = new Date();
  const diff = (n.getDay() + 6) % 7; // Monday as week start
  const after = new Date(n.getFullYear(), n.getMonth(), n.getDate() - diff, 0, 0, 0, 0);
  const before = new Date(after);
  before.setDate(after.getDate() + 6);
  before.setHours(23, 59, 59, 999);
  return { after, before };
}
function monthRange() {
  const n = new Date();
  return {
    after: new Date(n.getFullYear(), n.getMonth(), 1),
    before: new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59, 999),
  };
}
const rangeObj = (r) => ({ $gte: r.after, $lte: r.before });

/* ----------------------------- sales report ----------------------------- */

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Comma-separated id list → ObjectId (single) or $in (multiple). Aggregation
// $match stages do not cast strings, so ids are converted up front.
function idIn(v) {
  const ids = String(v).split(',').map((s) => s.trim()).filter((s) => mongoose.isValidObjectId(s));
  if (!ids.length) throw ApiError.badRequest(`Invalid id filter: ${v}`);
  const objs = ids.map((s) => new mongoose.Types.ObjectId(s));
  return objs.length > 1 ? { $in: objs } : objs[0];
}

// Re-key a Query filter under a prefix (for matching joined `q` documents).
function prefixKeys(obj, pre) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$or' || k === '$and') out[k] = v.map((x) => prefixKeys(x, pre));
    else out[pre + k] = v;
  }
  return out;
}

// Filters shared by the summary, the trips table and the breakdown tabs.
//   attr       — Query attribute filters (owner, team, source, destination, tag, status)
//   searchOr   — free-text search (guest name/phone/email, reference id, trip #)
//   queryMatch — the full Query filter (range + attr + search + visibility scope)
function salesFilters(req) {
  const { after, before } = rangeFromQuery(req.query);
  const q = req.query;

  const attr = {};
  if (q.owner) attr.owner = idIn(q.owner);
  if (q.salesTeam) attr.salesTeam = idIn(q.salesTeam);
  if (q.source) attr.source = idIn(q.source);
  if (q.destination) attr.destinations = idIn(q.destination);
  if (q.tag) attr.tags = idIn(q.tag);
  const status = q.status || q.type;
  if (status && status !== 'all') attr.status = status === 'won' ? { $in: WON } : status;

  let searchOr = null;
  const term = String(q.search || '').trim();
  if (term) {
    const rx = new RegExp(escapeRx(term), 'i');
    searchOr = [{ 'guest.name': rx }, { 'guest.phones.number': rx }, { 'guest.email': rx }, { referenceId: rx }];
    if (/^\d+$/.test(term)) searchOr.push({ queryNumber: Number(term) });
  }

  const queryMatch = applyScope(
    { createdAt: { $gte: after, $lte: before }, ...attr, ...(searchOr ? { $or: searchOr } : {}) },
    ownScope(req.user)
  );
  return { after, before, attr, searchOr, queryMatch, hasAttr: Object.keys(attr).length > 0 || !!searchOr };
}

// Quotes created in the range (visibility-scoped by author) …
const quoteBase = (req, f) => [
  { $match: { createdAt: { $gte: f.after, $lte: f.before }, ...ownScope(req.user, ['createdBy']) } },
];
// … joined to their query so query-level filters (and group-by fields) apply.
function quoteJoin(f) {
  const stages = [
    { $lookup: { from: Query.collection.name, localField: 'query', foreignField: '_id', as: 'q' } },
    { $unwind: '$q' },
  ];
  const m = prefixKeys({ ...f.attr, ...(f.searchOr ? { $or: f.searchOr } : {}) }, 'q.');
  if (Object.keys(m).length) stages.push({ $match: m });
  return stages;
}

async function countQuotes(req, f) {
  if (!f.hasAttr) return Quote.countDocuments(quoteBase(req, f)[0].$match);
  const r = await Quote.aggregate([...quoteBase(req, f), ...quoteJoin(f), { $count: 'n' }]);
  return r[0]?.n || 0;
}

const and = (...parts) => ({ $and: parts });

// GET /api/reports/sales?after=&before=&type=|status=&owner=&salesTeam=&source=&destination=&tag=&search=
export const salesReport = asyncHandler(async (req, res) => {
  const f = salesFilters(req);
  const { after, before, queryMatch } = f;

  const [leads, quotes, conversion, dropped, wonAgg] = await Promise.all([
    Query.countDocuments(queryMatch),
    countQuotes(req, f),
    Query.countDocuments(and(queryMatch, { status: { $in: WON } })),
    Query.countDocuments(and(queryMatch, { status: 'dropped' })),
    Query.aggregate([
      { $match: and(queryMatch, { status: { $in: WON } }) },
      { $group: { _id: null, revenue: { $sum: '$bookedAmount' }, profit: { $sum: '$profit' } } },
    ]),
  ]);

  const revenue = wonAgg[0]?.revenue || 0;
  const totalProfit = wonAgg[0]?.profit || 0;
  const conversionPct = leads ? Math.round((conversion / leads) * 100) : 0;

  const LIMIT = 500;
  const rows = await Query.find(queryMatch)
    .populate('destinations', 'name')
    .populate('owner', 'name')
    .populate('salesTeam', 'name')
    .populate('source', 'name')
    .sort('-createdAt')
    .limit(LIMIT);

  const items = rows.map((q) => {
    const amount = q.bookedAmount || 0;
    const profit = q.profit || 0;
    return {
      _id: q._id,
      queryNumber: q.queryNumber,
      guest: q.guest,
      destinations: q.destinations,
      nights: q.nights,
      startDate: q.startDate,
      status: q.status,
      owner: q.owner,
      salesTeam: q.salesTeam,
      source: q.source,
      createdAt: q.createdAt,
      amount,
      currency: q.currency || 'INR',
      profit,
      profitPercent: amount ? Math.round((profit / amount) * 100) : 0,
    };
  });

  return ok(res, {
    range: { after, before },
    summary: { revenue, leads, quotes, conversion, conversionPct, dropped, profit: totalProfit },
    items,
    total: leads,
    truncated: leads > items.length,
  });
});

/* --------------------------- sales breakdown ---------------------------- */

// Group-by dimensions for the Sales Report tabs.
const BREAKDOWNS = {
  owner: { field: 'owner', model: 'User', label: 'Sales Person', empty: 'Unassigned' },
  salesTeam: { field: 'salesTeam', model: 'Team', label: 'Team', empty: 'No team' },
  destinations: { field: 'destinations', model: 'Destination', label: 'Destination', empty: 'No destination', array: true },
  source: { field: 'source', model: 'QuerySource', label: 'Trip Source', empty: 'No source' },
  tags: { field: 'tags', model: 'Tag', label: 'Tag', empty: 'Untagged', array: true },
};

const emptyBucket = (id) => ({ _id: id, leads: 0, quotes: 0, conversion: 0, dropped: 0, revenue: 0, profit: 0 });

// GET /api/reports/sales/breakdown?by=owner|salesTeam|destinations|source|tags&after=&before=&…filters
export const salesBreakdown = asyncHandler(async (req, res) => {
  const g = BREAKDOWNS[req.query.by];
  if (!g) throw ApiError.badRequest(`Unknown breakdown: ${req.query.by}`);
  const f = salesFilters(req);
  const isWon = { $in: ['$status', WON] };

  // Leads / conversions / revenue per group (from queries).
  const qPipe = [{ $match: f.queryMatch }];
  if (g.array) qPipe.push({ $unwind: { path: `$${g.field}`, preserveNullAndEmptyArrays: true } });
  qPipe.push({
    $group: {
      _id: `$${g.field}`,
      leads: { $sum: 1 },
      conversion: { $sum: { $cond: [isWon, 1, 0] } },
      dropped: { $sum: { $cond: [{ $eq: ['$status', 'dropped'] }, 1, 0] } },
      revenue: { $sum: { $cond: [isWon, { $ifNull: ['$bookedAmount', 0] }, 0] } },
      profit: { $sum: { $cond: [isWon, { $ifNull: ['$profit', 0] }, 0] } },
    },
  });

  // Quotes per group (from quotes joined to their query).
  const quotePipe = [...quoteBase(req, f), ...quoteJoin(f)];
  if (g.array) quotePipe.push({ $unwind: { path: `$q.${g.field}`, preserveNullAndEmptyArrays: true } });
  quotePipe.push({ $group: { _id: `$q.${g.field}`, quotes: { $sum: 1 } } });

  const [qRows, quoteRows] = await Promise.all([Query.aggregate(qPipe), Quote.aggregate(quotePipe)]);

  const buckets = new Map();
  const key = (id) => (id ? String(id) : '');
  for (const r of qRows) buckets.set(key(r._id), { ...emptyBucket(r._id), ...r });
  for (const r of quoteRows) {
    const k = key(r._id);
    if (!buckets.has(k)) buckets.set(k, emptyBucket(r._id));
    buckets.get(k).quotes = r.quotes;
  }

  const ids = [...buckets.keys()].filter(Boolean);
  const refs = ids.length ? await mongoose.model(g.model).find({ _id: { $in: ids } }).select('name email color').lean() : [];
  const refById = new Map(refs.map((d) => [String(d._id), d]));

  const rows = [...buckets.values()]
    .map((r) => {
      const ref = r._id ? refById.get(String(r._id)) : null;
      const revenue = Math.round(r.revenue || 0);
      const profit = Math.round(r.profit || 0);
      return {
        _id: r._id || null,
        name: ref?.name || (r._id ? 'Deleted' : g.empty),
        email: ref?.email,
        color: ref?.color,
        leads: r.leads,
        quotes: r.quotes,
        conversion: r.conversion,
        conversionPct: r.leads ? Math.round((r.conversion / r.leads) * 100) : 0,
        dropped: r.dropped,
        revenue,
        profit,
        profitPct: revenue ? Math.round((profit / revenue) * 1000) / 10 : 0,
        avgDeal: r.conversion ? Math.round(revenue / r.conversion) : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.conversion - a.conversion || b.leads - a.leads || a.name.localeCompare(b.name));

  return ok(res, { by: req.query.by, label: g.label, range: { after: f.after, before: f.before }, rows });
});

/* ------------------------------ dashboard ------------------------------- */

async function computeSales(range, scope, quoteScope = {}) {
  const inRange = { createdAt: rangeObj(range) };
  const baseQ = { ...inRange, ...scope };
  const [leads, quotes, conversion, wonAgg] = await Promise.all([
    Query.countDocuments(baseQ),
    Quote.countDocuments({ ...inRange, ...quoteScope }),
    Query.countDocuments({ ...baseQ, status: { $in: WON } }),
    Query.aggregate([
      { $match: { ...baseQ, status: { $in: WON } } },
      { $group: { _id: null, revenue: { $sum: '$bookedAmount' }, profit: { $sum: '$profit' } } },
    ]),
  ]);
  return {
    revenue: wonAgg[0]?.revenue || 0,
    profit: wonAgg[0]?.profit || 0,
    leads,
    quotes,
    conversion,
    conversionPct: leads ? Math.round((conversion / leads) * 100) : 0,
  };
}

const HAS_BALANCE = { $expr: { $gt: [{ $subtract: ['$totalAmount', '$paidAmount'] }, 0] } };

async function dueAgg(match) {
  const r = await Booking.aggregate([
    { $match: { ...HAS_BALANCE, ...match } },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: { $subtract: ['$totalAmount', '$paidAmount'] } } } },
  ]);
  return { count: r[0]?.count || 0, amount: Math.round(r[0]?.amount || 0) };
}

// GET /api/reports/dashboard
export const dashboard = asyncHandler(async (req, res) => {
  const scope = {};
  if (req.query.owner) scope.owner = req.query.owner;

  // Non-admin/manager users see their own numbers only — same visibility rule
  // as the Trips/Bookings/Tasks tables the cards drill into.
  const ownQ = ownScope(req.user);                                  // Query/Booking: owner|createdBy
  const ownQuote = ownScope(req.user, ['createdBy']);               // Quote
  const ownTask = ownScope(req.user, ['createdBy', 'assignedTo']);  // Comment
  Object.assign(scope, ownQ);

  const fBase = { isActionable: true, isResolved: false, ...ownTask };
  const startStatus = { status: { $in: ['confirmed', 'on_trip'] } };
  const endStatus = { status: { $in: ['confirmed', 'on_trip', 'completed'] } };
  const now = new Date();

  const [
    salesToday, salesWeek, salesMonth,
    fToday, fYesterday, fNext7,
    startToday, startYesterday, startNext7,
    endToday, endTomorrow, endPrev7,
    dueToday, dueYesterday,
    liveDue, endedYestDue, starts7Due,
  ] = await Promise.all([
    computeSales(dayRange(0), scope, ownQuote),
    computeSales(weekRange(), scope, ownQuote),
    computeSales(monthRange(), scope, ownQuote),
    Comment.countDocuments({ ...fBase, dueDate: rangeObj(dayRange(0)) }),
    Comment.countDocuments({ ...fBase, dueDate: rangeObj(dayRange(-1)) }),
    Comment.countDocuments({ ...fBase, dueDate: rangeObj(spanRange(0, 7)) }),
    Booking.countDocuments({ ...startStatus, ...ownQ, startDate: rangeObj(dayRange(0)) }),
    Booking.countDocuments({ ...startStatus, ...ownQ, startDate: rangeObj(dayRange(-1)) }),
    Booking.countDocuments({ ...startStatus, ...ownQ, startDate: rangeObj(spanRange(0, 7)) }),
    Booking.countDocuments({ ...endStatus, ...ownQ, endDate: rangeObj(dayRange(0)) }),
    Booking.countDocuments({ ...endStatus, ...ownQ, endDate: rangeObj(dayRange(1)) }),
    Booking.countDocuments({ ...endStatus, ...ownQ, endDate: rangeObj(spanRange(-7, -1)) }),
    dueAgg({ ...ownQ, startDate: rangeObj(dayRange(0)) }),
    dueAgg({ ...ownQ, startDate: rangeObj(dayRange(-1)) }),
    dueAgg({ ...ownQ, startDate: { $lte: now }, endDate: { $gte: now } }),
    dueAgg({ ...ownQ, endDate: rangeObj(dayRange(-1)) }),
    dueAgg({ ...ownQ, startDate: rangeObj(spanRange(0, 7)) }),
  ]);

  return ok(res, {
    salesStats: { today: salesToday, week: salesWeek, month: salesMonth },
    followups: { today: fToday, yesterday: fYesterday, next7: fNext7 },
    payments: { dueIncoming: { today: dueToday, yesterday: dueYesterday } },
    tripsStarting: { today: startToday, yesterday: startYesterday, next7: startNext7 },
    tripsEnding: { today: endToday, tomorrow: endTomorrow, prev7: endPrev7 },
    liveDuePayments: { live: liveDue, endedYesterday: endedYestDue, starts7: starts7Due },
  });
});

/* --------------------------- drill-down lists --------------------------- */

function bookingRow(b) {
  const balanceDue = Math.max(0, (b.totalAmount || 0) - (b.paidAmount || 0));
  return {
    _id: b._id,
    bookingNumber: b.bookingNumber,
    query: b.query,
    guest: b.guest,
    destinations: b.destinations,
    startDate: b.startDate,
    endDate: b.endDate,
    nights: b.nights,
    status: b.status,
    owner: b.owner,
    currency: b.currency || 'INR',
    totalAmount: b.totalAmount || 0,
    paidAmount: b.paidAmount || 0,
    balanceDue,
  };
}

function buildTripFilter(view, bucket) {
  const f = {};
  const now = new Date();
  const set = (field, r) => { f[field] = rangeObj(r); };

  if (view === 'starting') {
    f.status = { $in: ['confirmed', 'on_trip'] };
    if (bucket === 'today') set('startDate', dayRange(0));
    else if (bucket === 'yesterday') set('startDate', dayRange(-1));
    else if (bucket === 'next7') set('startDate', spanRange(0, 7));
  } else if (view === 'ending') {
    f.status = { $in: ['confirmed', 'on_trip', 'completed'] };
    if (bucket === 'today') set('endDate', dayRange(0));
    else if (bucket === 'tomorrow') set('endDate', dayRange(1));
    else if (bucket === 'prev7') set('endDate', spanRange(-7, -1));
  } else if (view === 'due-incoming') {
    Object.assign(f, HAS_BALANCE);
    if (bucket === 'today') set('startDate', dayRange(0));
    else if (bucket === 'yesterday') set('startDate', dayRange(-1));
  } else if (view === 'live-due') {
    Object.assign(f, HAS_BALANCE);
    if (bucket === 'live') { f.startDate = { $lte: now }; f.endDate = { $gte: now }; }
    else if (bucket === 'endedYesterday') set('endDate', dayRange(-1));
    else if (bucket === 'starts7') set('startDate', spanRange(0, 7));
  }
  return f;
}

// GET /api/reports/trips?view=&bucket=
export const tripsReport = asyncHandler(async (req, res) => {
  const view = req.query.view || 'starting';
  const bucket = req.query.bucket || 'all';

  if (view === 'followups') {
    const f = { isActionable: true, isResolved: false, ...ownScope(req.user, ['createdBy', 'assignedTo']) };
    if (bucket === 'today') f.dueDate = rangeObj(dayRange(0));
    else if (bucket === 'yesterday') f.dueDate = rangeObj(dayRange(-1));
    else if (bucket === 'next7') f.dueDate = rangeObj(spanRange(0, 7));
    const rows = await Comment.find(f)
      .populate({ path: 'query', select: 'queryNumber guest', populate: { path: 'destinations', select: 'name' } })
      .populate('assignedTo', 'name')
      .populate('createdBy', 'name')
      .sort('dueDate')
      .limit(300);
    const items = rows.map((c) => ({
      _id: c._id,
      dueDate: c.dueDate,
      body: c.body,
      query: c.query,
      assignedTo: c.assignedTo,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
    }));
    return ok(res, { view, bucket, kind: 'followups', items });
  }

  const filter = { ...buildTripFilter(view, bucket), ...ownScope(req.user) };
  const sortField = view === 'ending' ? 'endDate' : 'startDate';
  const rows = await Booking.find(filter)
    .populate('destinations', 'name')
    .populate('owner', 'name')
    .sort(sortField)
    .limit(300);
  return ok(res, { view, bucket, kind: 'trips', items: rows.map(bookingRow) });
});

/* ---------------------- trip check-in / check-out report ---------------------- */

// Estimate supplier (booking) cost + tax for a booking from its cost snapshot.
function bookingFinance(b) {
  const pkg = b.totalAmount || 0;
  const cost = (b.costItems || []).reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const tax = b.quote?.pricing?.tax || 0;
  const bookings = Math.round(cost);
  const profit = Math.round(pkg - bookings - tax);
  return { pkg, tax: Math.round(tax), bookings, profit, profitPct: pkg ? Math.round((profit / pkg) * 1000) / 10 : 0 };
}

// GET /api/reports/trip-check-in-out?direction=checkout|checkin&after=&before=
export const tripCheckInOutReport = asyncHandler(async (req, res) => {
  const direction = req.query.direction === 'checkin' ? 'checkin' : 'checkout';
  const { after, before } = rangeFromQuery(req.query);
  const dateField = direction === 'checkin' ? 'startDate' : 'endDate';

  const rows = await Booking.find({ [dateField]: { $gte: after, $lte: before }, ...ownScope(req.user) })
    .populate('destinations', 'name')
    .populate({ path: 'quote', select: 'pricing' })
    .sort(dateField)
    .limit(500);

  const items = rows.map((b) => {
    const fin = bookingFinance(b);
    return {
      _id: b._id,
      bookingNumber: b.bookingNumber,
      query: b.query,
      guest: b.guest,
      destinations: b.destinations,
      startDate: b.startDate,
      endDate: b.endDate,
      nights: b.nights,
      status: b.status,
      currency: b.currency || 'INR',
      package: fin.pkg,
      tax: fin.tax,
      bookings: fin.bookings,
      profit: fin.profit,
      profitPct: fin.profitPct,
    };
  });

  const totals = items.reduce(
    (a, x) => ({ packages: a.packages + x.package, bookings: a.bookings + x.bookings }),
    { packages: 0, bookings: 0 }
  );

  return ok(res, { direction, range: { after, before }, count: items.length, totals, items });
});
