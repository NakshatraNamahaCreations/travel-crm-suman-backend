import { PaymentGateway } from '../models/PaymentGateway.js';
import { GatewayTransaction } from '../models/GatewayTransaction.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';

// Period window [start, end) for the gateway filters.
function periodWindow(period, now = new Date()) {
  const d = new Date(now);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  switch (period) {
    case 'today': { const s = startOfDay(d); return [s, new Date(s.getTime() + 864e5)]; }
    case 'yesterday': { const s = startOfDay(new Date(d.getTime() - 864e5)); return [s, new Date(s.getTime() + 864e5)]; }
    case 'month': return [new Date(d.getFullYear(), d.getMonth(), 1), new Date(d.getFullYear(), d.getMonth() + 1, 1)];
    case 'last-month': return [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 1)];
    default: return [null, null];
  }
}

// GET /api/gateways  — configured gateways
export const listGateways = asyncHandler(async (req, res) => {
  const items = await PaymentGateway.find().sort('name');
  return ok(res, items);
});

// POST /api/gateways
export const createGateway = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw ApiError.badRequest('Gateway name is required');
  const g = await PaymentGateway.create({ name, provider: req.body.provider || 'payu', createdBy: req.user?._id });
  return created(res, g);
});

function buildTxnFilter(query) {
  const filter = {};
  filter.type = query.type === 'settlement' ? 'settlement' : 'transaction';
  if (query.gateway) filter.gateway = query.gateway;
  const [start, end] = periodWindow(query.period);
  if (start && end) filter.date = { $gte: start, $lt: end };
  if (query.search) {
    const rx = new RegExp(String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ txnId: rx }, { guestName: rx }, { reference: rx }];
  }
  return filter;
}

// GET /api/gateways/transactions?type=&period=&gateway=&search=
export const listGatewayTransactions = asyncHandler(async (req, res) => {
  const filter = buildTxnFilter(req.query);
  const total = await GatewayTransaction.countDocuments(filter);
  const meta = paginate(req.query, total);
  const items = await GatewayTransaction.find(filter).populate('gateway', 'name').sort('-date').skip(meta.skip).limit(meta.limit);
  return ok(res, items, meta);
});

// GET /api/gateways/summary?period=&gateway=  — counts/amount per status for the transactions tab
export const gatewaySummary = asyncHandler(async (req, res) => {
  const filter = buildTxnFilter({ ...req.query, type: 'transaction', search: undefined });
  delete filter.$or;
  const rows = await GatewayTransaction.aggregate([
    { $match: filter },
    { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  return ok(res, {
    amount: rows.reduce((s, r) => s + (r._id === 'successful' ? r.amount : 0), 0),
    successful: by.successful?.n || 0,
    failure: by.failure?.n || 0,
    cancelled: by.cancelled?.n || 0,
  });
});
