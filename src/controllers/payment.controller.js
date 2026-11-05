import { Payment } from '../models/Payment.js';
import { Booking } from '../models/Booking.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';

// Recompute a booking's paidAmount from its customer payments.
async function syncBookingPaid(bookingId) {
  if (!bookingId) return;
  const rows = await Payment.aggregate([
    { $match: { booking: bookingId, party: 'customer' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  await Booking.findByIdAndUpdate(bookingId, { paidAmount: rows[0]?.total || 0 });
}

// GET /api/payments?party=&booking=
export const listPayments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.party) filter.party = req.query.party;
  if (req.query.booking) filter.booking = req.query.booking;
  if (req.query.supplierKind) filter['supplier.kind'] = req.query.supplierKind;
  if (req.query.search) {
    const rx = new RegExp(req.query.search.trim(), 'i');
    filter.$or = [{ reference: rx }, { 'supplier.name': rx }, { notes: rx }];
  }

  const total = await Payment.countDocuments(filter);
  const meta = paginate(req.query, total);
  const items = await Payment.find(filter)
    .populate({ path: 'booking', select: 'bookingNumber guest' })
    .sort('-date')
    .skip(meta.skip)
    .limit(meta.limit);
  return ok(res, items, meta);
});

// GET /api/payments/summary?party=
export const paymentsSummary = asyncHandler(async (req, res) => {
  const match = {};
  if (req.query.party) match.party = req.query.party;
  const rows = await Payment.aggregate([
    { $match: match },
    { $group: { _id: '$party', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const byParty = Object.fromEntries(rows.map((r) => [r._id, { total: r.total, count: r.count }]));
  return ok(res, {
    customer: byParty.customer || { total: 0, count: 0 },
    supplier: byParty.supplier || { total: 0, count: 0 },
  });
});

// POST /api/payments
export const createPayment = asyncHandler(async (req, res) => {
  if (req.body.party === 'customer' && !req.body.booking) {
    throw ApiError.badRequest('Customer payment requires a booking');
  }
  const payment = await Payment.create({ ...req.body, createdBy: req.user._id });
  if (payment.party === 'customer') await syncBookingPaid(payment.booking);
  return created(res, payment);
});

// PATCH /api/payments/:id
export const updatePayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findByIdAndUpdate(req.params.id, { ...req.body }, { new: true });
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.party === 'customer') await syncBookingPaid(payment.booking);
  return ok(res, payment);
});

// DELETE /api/payments/:id
export const deletePayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findByIdAndDelete(req.params.id);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.party === 'customer') await syncBookingPaid(payment.booking);
  return ok(res, { id: req.params.id });
});

// GET /api/payments/supplier-ledger — supplier payments grouped by supplier
export const supplierLedger = asyncHandler(async (req, res) => {
  const rows = await Payment.aggregate([
    { $match: { party: 'supplier' } },
    {
      $group: {
        _id: { name: '$supplier.name', kind: '$supplier.kind' },
        totalPaid: { $sum: '$amount' },
        payments: { $sum: 1 },
        lastPaid: { $max: '$date' },
      },
    },
    { $sort: { totalPaid: -1 } },
  ]);
  const ledger = rows.map((r) => ({
    supplier: r._id.name || 'Unnamed',
    kind: r._id.kind,
    totalPaid: r.totalPaid,
    payments: r.payments,
    lastPaid: r.lastPaid,
  }));
  return ok(res, ledger);
});
