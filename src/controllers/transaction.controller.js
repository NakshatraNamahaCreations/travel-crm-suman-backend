import { Transaction } from '../models/Transaction.js';
import { Account } from '../models/Account.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';
import { ownScope, applyScope } from '../utils/ownScope.js';

const POPULATE = [
  { path: 'debitAccount', select: 'name kind' },
  { path: 'creditAccount', select: 'name kind' },
  { path: 'createdBy', select: 'name' },
];

// Start of a named period relative to `now`. Returns null for "all".
function periodStart(period, now = new Date()) {
  const d = new Date(now);
  switch (period) {
    case 'month': return new Date(d.getFullYear(), d.getMonth(), 1);
    case 'last-month': return new Date(d.getFullYear(), d.getMonth() - 1, 1);
    default: return null;
  }
}

// GET /api/transactions?period=&account=&search=&sort=
export const listTransactions = asyncHandler(async (req, res) => {
  const { period, account, search } = req.query;
  // Non-admin/manager users see only entries they recorded.
  const filter = { ...ownScope(req.user, ['createdBy']) };

  if (period && period !== 'all') {
    const start = periodStart(period);
    if (period === 'last-month') {
      const end = new Date();
      filter.date = { $gte: start, $lt: new Date(end.getFullYear(), end.getMonth(), 1) };
    } else if (start) {
      filter.date = { $gte: start };
    }
  }
  if (account) filter.$or = [{ debitAccount: account }, { creditAccount: account }];
  if (search) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const or = [{ txnId: rx }, { refId: rx }, { narration: rx }];
    filter.$and = [{ $or: or }];
  }

  const total = await Transaction.countDocuments(filter);
  const meta = paginate(req.query, total);
  const sort = req.query.sort === 'date-asc' ? 'date' : '-date';
  const items = await Transaction.find(filter).populate(POPULATE).sort(sort).skip(meta.skip).limit(meta.limit);
  return ok(res, items, meta);
});

// GET /api/transactions/summary?period=
export const transactionsSummary = asyncHandler(async (req, res) => {
  const filter = {};
  const start = periodStart(req.query.period);
  if (start) filter.date = { $gte: start };
  const rows = await Transaction.aggregate([
    { $match: filter },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]);
  return ok(res, { count: rows[0]?.count || 0, amount: rows[0]?.amount || 0 });
});

// POST /api/transactions  { debitAccount, creditAccount, amount, date?, refId?, narration? }
export const createTransaction = asyncHandler(async (req, res) => {
  const { debitAccount, creditAccount, amount } = req.body;
  if (!debitAccount || !creditAccount) throw ApiError.badRequest('Debit and credit accounts are required');
  if (String(debitAccount) === String(creditAccount)) throw ApiError.badRequest('Debit and credit accounts must differ');
  if (!(Number(amount) > 0)) throw ApiError.badRequest('Amount must be greater than zero');

  const [d, c] = await Promise.all([Account.findById(debitAccount), Account.findById(creditAccount)]);
  if (!d || !c) throw ApiError.badRequest('Account not found');

  const t = await Transaction.create({
    debitAccount, creditAccount,
    amount: Number(amount),
    currency: req.body.currency || 'INR',
    date: req.body.date ? new Date(req.body.date) : new Date(),
    refId: req.body.refId,
    narration: req.body.narration,
    booking: req.body.booking || undefined,
    tripId: req.body.tripId,
    source: 'manual',
    createdBy: req.user?._id,
  });
  const populated = await t.populate(POPULATE);
  return created(res, populated);
});

// DELETE /api/transactions/:id
export const deleteTransaction = asyncHandler(async (req, res) => {
  const t = await Transaction.findByIdAndDelete(req.params.id);
  if (!t) throw ApiError.notFound('Transaction not found');
  return ok(res, { id: req.params.id });
});
