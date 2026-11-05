import mongoose from 'mongoose';
import { Account } from '../models/Account.js';
import { Transaction } from '../models/Transaction.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';
import { ownScope, applyScope } from '../utils/ownScope.js';

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Net balance per account = opening + debits(into account) − credits(out of account).
async function balanceMap(ids) {
  const match = ids ? { $or: [{ debitAccount: { $in: ids } }, { creditAccount: { $in: ids } }] } : {};
  const rows = await Transaction.aggregate([
    { $match: match },
    {
      $facet: {
        debits: [{ $group: { _id: '$debitAccount', n: { $sum: '$amount' } } }],
        credits: [{ $group: { _id: '$creditAccount', n: { $sum: '$amount' } } }],
      },
    },
  ]);
  const map = {};
  const d = rows[0]?.debits || [];
  const c = rows[0]?.credits || [];
  for (const r of d) map[String(r._id)] = (map[String(r._id)] || 0) + r.n;
  for (const r of c) map[String(r._id)] = (map[String(r._id)] || 0) - r.n;
  return map;
}

// GET /api/accounts?kind=&search=
export const listAccounts = asyncHandler(async (req, res) => {
  const { kind, search } = req.query;
  // Non-admin/manager users see only accounts they created.
  const filter = { ...ownScope(req.user, ['createdBy']) };
  if (kind && kind !== 'all') filter.kind = kind;
  if (search) filter.name = new RegExp(escapeRx(search.trim()), 'i');

  const total = await Account.countDocuments(filter);
  const meta = paginate(req.query, total);
  const items = await Account.find(filter).populate('user', 'name').sort('-createdAt').skip(meta.skip).limit(meta.limit);

  const ids = items.map((a) => a._id);
  const bal = await balanceMap(ids);
  const out = items.map((a) => ({ ...a.toObject(), balance: (a.openingBalance || 0) + (bal[String(a._id)] || 0) }));
  return ok(res, out, meta);
});

// GET /api/accounts/:id
export const getAccount = asyncHandler(async (req, res) => {
  const a = await Account.findById(req.params.id).populate('user', 'name');
  if (!a) throw ApiError.notFound('Account not found');
  const bal = await balanceMap([a._id]);
  return ok(res, { ...a.toObject(), balance: (a.openingBalance || 0) + (bal[String(a._id)] || 0) });
});

// POST /api/accounts
export const createAccount = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw ApiError.badRequest('Account name is required');
  const a = await Account.create({
    name,
    kind: req.body.kind || 'company',
    tags: req.body.tags || [],
    phone: req.body.phone,
    user: req.body.user || undefined,
    booking: req.body.booking || undefined,
    tripId: req.body.tripId,
    openingBalance: Number(req.body.openingBalance) || 0,
    currency: req.body.currency || 'INR',
    createdBy: req.user?._id,
  });
  return created(res, a);
});

// PATCH /api/accounts/:id
export const updateAccount = asyncHandler(async (req, res) => {
  const patch = {};
  for (const k of ['name', 'kind', 'tags', 'phone', 'openingBalance', 'isActive', 'currency']) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  const a = await Account.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  if (!a) throw ApiError.notFound('Account not found');
  return ok(res, a);
});

// DELETE /api/accounts/:id  — refuse if the account has any transactions.
export const deleteAccount = asyncHandler(async (req, res) => {
  const id = new mongoose.Types.ObjectId(req.params.id);
  const used = await Transaction.countDocuments({ $or: [{ debitAccount: id }, { creditAccount: id }] });
  if (used) throw ApiError.badRequest('Cannot delete an account that has transactions');
  const a = await Account.findByIdAndDelete(req.params.id);
  if (!a) throw ApiError.notFound('Account not found');
  return ok(res, { id: req.params.id });
});
