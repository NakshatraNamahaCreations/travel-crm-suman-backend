import { AdSpend, monthStart } from '../models/AdSpend.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { LEAD_CHANNELS, channelMeta } from '../config/leadChannels.js';

// Channels a tenant can record spend against. Organic search, blog and direct traffic have no
// media cost, and offering a box for them would invite someone to type their SEO retainer in
// and quietly ruin every cost-per-lead figure on the page.
const SPENDABLE = new Set(['google_ads', 'meta_ads', 'offline', 'referral']);

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

const keyOf = (d) => {
  const x = new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
};

/** '2026-11' → the first instant of that month, in server-local time, matching monthStart. */
function parseMonthKey(v) {
  const m = MONTH_KEY.exec(String(v || '').trim());
  if (!m) throw ApiError.badRequest('Month must look like 2026-11');
  return new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0, 0);
}

// GET /api/leads/ad-spend?months=6
export const listAdSpend = asyncHandler(async (req, res) => {
  const count = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  const now = monthStart(new Date());

  // Newest first, so the current month is the first column the page shows — on a phone the
  // rightmost columns are the ones scrolled off screen.
  const months = [];
  for (let i = 0; i < count; i++) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const oldest = months[months.length - 1];

  const rows = await AdSpend.find({ month: { $gte: oldest } }).select('channel month amount').lean();
  const byChannel = new Map();
  for (const r of rows) {
    const map = byChannel.get(r.channel) || {};
    map[keyOf(r.month)] = r.amount || 0;
    byChannel.set(r.channel, map);
  }

  const monthKeys = months.map(keyOf);
  const totals = Object.fromEntries(monthKeys.map((k) => [k, 0]));
  const out = LEAD_CHANNELS.map((c) => {
    const stored = byChannel.get(c.key) || {};
    const byMonth = Object.fromEntries(monthKeys.map((k) => [k, stored[k] || 0]));
    for (const k of monthKeys) totals[k] += byMonth[k];
    return {
      channel: c.key,
      label: c.label,
      icon: c.icon,
      color: c.color,
      paid: !!c.paid,
      editable: SPENDABLE.has(c.key),
      byMonth,
    };
  });

  return ok(res, {
    currency: 'INR',
    months: monthKeys,
    monthLabels: months.map((d) => d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })),
    rows: out,
    totals,
  });
});

// PUT /api/leads/ad-spend  { channel, month: '2026-11', amount }
export const saveAdSpend = asyncHandler(async (req, res) => {
  const { channel, month, amount } = req.body || {};
  if (!SPENDABLE.has(channel)) {
    const known = channelMeta(channel);
    throw ApiError.badRequest(
      LEAD_CHANNELS.some((c) => c.key === channel)
        ? known.label + ' has no media cost, so spend cannot be recorded against it'
        : 'Unknown channel: ' + channel
    );
  }
  const monthDate = parseMonthKey(month);
  // A month far in the future is a typo, not a plan, and it would sit at the top of the grid
  // skewing the range every page load.
  const limit = monthStart(new Date());
  limit.setMonth(limit.getMonth() + 1);
  if (monthDate > limit) throw ApiError.badRequest('That month has not happened yet');

  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest('Spend must be zero or more');
  if (n > 1e11) throw ApiError.badRequest('That figure looks like a typo');

  const row = await AdSpend.findOneAndUpdate(
    { channel, month: monthDate },
    { $set: { amount: Math.round(n), updatedBy: req.user._id }, $setOnInsert: { channel, month: monthDate, currency: 'INR' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return ok(res, {
    channel: row.channel,
    month: keyOf(row.month),
    amount: row.amount,
    label: channelMeta(row.channel).label,
  });
});
