import { Installment } from '../models/Installment.js';
import { Payment } from '../models/Payment.js';
import { Counter } from '../models/Counter.js';
import { Booking } from '../models/Booking.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';
import { createNotification } from './notification.controller.js';
import { paymentReceiptHtml } from '../pdf/paymentReceiptHtml.js';
import { htmlToPdf } from '../pdf/renderPdf.js';
import { sendWhatsAppTemplate } from '../utils/whatsapp.js';
import { WhatsappTemplate } from '../models/WhatsappTemplate.js';
import { DEFAULT_WHATSAPP_TEMPLATES } from '../config/whatsappTemplates.js';
import { env } from '../config/env.js';
import { resolveSessionId } from './whatsappConnection.controller.js';
import { ownScope, applyScope } from '../utils/ownScope.js';

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function todayEnd() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
function daysAgo(n) {
  const d = todayStart();
  d.setDate(d.getDate() - n);
  return d;
}

// Recompute a booking's paidAmount from its customer payments.
async function syncBookingPaid(bookingId) {
  if (!bookingId) return;
  const rows = await Payment.aggregate([
    { $match: { booking: bookingId, party: 'customer' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  await Booking.findByIdAndUpdate(bookingId, { paidAmount: rows[0]?.total || 0 });
}

// Build the mongo filter for a given left-tab.
function tabFilter(tab) {
  switch (tab) {
    case 'upcoming':
      return { paid: false, dueDate: { $gte: todayStart() } };
    case 'past7':
      return { dueDate: { $gte: daysAgo(7), $lte: todayEnd() } };
    case 'unverified':
      return { paid: true, verified: false };
    case 'paid':
      return { paid: true, verified: true };
    case 'overdue':
      return { paid: false, dueDate: { $lt: todayStart() } };
    case 'all':
    default:
      return {};
  }
}

// GET /api/installments?direction=&filter=&search=&booking=
export const listInstallments = asyncHandler(async (req, res) => {
  const filter = { ...tabFilter(req.query.filter || 'all') };
  if (req.query.direction) filter.direction = req.query.direction;
  if (req.query.booking) filter.booking = req.query.booking;
  if (req.query.query) filter.query = req.query.query;
  if (req.query.search) {
    const rx = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ 'guest.name': rx }, { 'guest.phones.number': rx }, { tripId: rx }, { supplierName: rx }];
  }

  // Global ledger is scoped to the caller's own records for non-admin roles;
  // per-trip views (query/booking param) inherit the trip's visibility.
  const scoped = (req.query.query || req.query.booking)
    ? filter
    : applyScope(filter, ownScope(req.user, ['createdBy']));
  const total = await Installment.countDocuments(scoped);
  const meta = paginate(req.query, total);
  const items = await Installment.find(scoped).sort('dueDate').skip(meta.skip).limit(meta.limit).populate('verifiedBy', 'name');
  return ok(res, items, meta);
});

const pad4 = (n) => { const s = String(n ?? '').trim(); return /^\d+$/.test(s) ? s.padStart(4, '0') : s; };

// GET /api/installments/accounts?search=  — trip/guest accounts for the debit/credit picker
export const accountOptions = asyncHandler(async (req, res) => {
  const bookings = await Booking.find().populate('query', 'queryNumber').sort('-createdAt').limit(200);
  let guests = bookings.map((b) => {
    const name = [b.guest?.salutation, b.guest?.name].filter(Boolean).join(' ') || 'Guest';
    const tripId = b.query?.queryNumber || b.bookingNumber || '';
    const ph = b.guest?.phones?.[0];
    return {
      type: 'guest',
      label: `${name} - Trip ID: ${pad4(tripId)}`,
      phone: ph ? `+${ph.countryCode || '91'} ${ph.number}` : '',
      tripId: String(tripId),
    };
  });
  // de-dup by label
  const seen = new Set();
  guests = guests.filter((g) => (seen.has(g.label) ? false : seen.add(g.label)));
  if (req.query.search) {
    const rx = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    guests = guests.filter((g) => rx.test(g.label) || rx.test(g.phone));
  }
  return ok(res, guests);
});

// GET /api/installments/summary?direction=  — counts per tab
export const installmentSummary = asyncHandler(async (req, res) => {
  const base = req.query.direction ? { direction: req.query.direction } : {};
  const tabs = ['upcoming', 'past7', 'unverified', 'paid', 'overdue', 'all'];
  const entries = await Promise.all(
    tabs.map((t) => Installment.countDocuments({ ...base, ...tabFilter(t) }).then((c) => [t, c]))
  );
  return ok(res, Object.fromEntries(entries));
});

// POST /api/installments  — create a due manually
export const createInstallment = asyncHandler(async (req, res) => {
  const item = await Installment.create({ ...req.body, createdBy: req.user._id });
  return created(res, item);
});

// A duplicate-number insert means the sequence counter fell behind the
// numbers already in the collection (seen in prod: 11 behind, which no
// bounded retry can cross). Bump the counter past the current max so the
// next attempt gets a fresh number. Org comes from the E11000 key itself.
export async function healCounterFromDup(err, Model, key, field) {
  const org = err?.keyValue?.organization;
  if (!org) return;
  const top = await Model.findOne().sort(`-${field}`).select(field);
  if (top?.[field]) await Counter.syncFloor(org, key, top[field]);
}

// Retry Payment.create on E11000 duplicate paymentNumber.
async function createPaymentWithRetry(data, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      return await Payment.create({ ...data });
    } catch (err) {
      if (err.code === 11000 && i < retries - 1) {
        // eslint-disable-next-line no-await-in-loop
        await healCounterFromDup(err, Payment, 'payment', 'paymentNumber');
        continue;
      }
      throw err;
    }
  }
}

// A partial payment closes the instalment at the paid amount and pushes the
// remainder into a NEW instalment with the same due date (Sembark behaviour)
// — so paying 20,000 of a 70,000 due leaves a 50,000 instalment open.
async function splitRemainder(inst, userId) {
  const remainder = Math.round((inst.amount || 0) - (inst.paidAmount || 0));
  if (remainder <= 0) return null;
  inst.amount = inst.paidAmount;
  const doc = {
    booking: inst.booking,
    query: inst.query,
    tripId: inst.tripId,
    guest: inst.guest,
    destinations: inst.destinations,
    startDate: inst.startDate,
    endDate: inst.endDate,
    currency: inst.currency,
    direction: inst.direction,
    supplierName: inst.supplierName,
    amount: remainder,
    dueDate: inst.dueDate,
    createdBy: userId,
  };
  for (let i = 0; i < 4; i++) {
    try {
      return await Installment.create(doc);
    } catch (e) {
      if (e.code === 11000 && i < 3) {
        // eslint-disable-next-line no-await-in-loop
        await healCounterFromDup(e, Installment, 'installment', 'installmentNumber');
        continue;
      }
      throw e;
    }
  }
}

// POST /api/installments/:id/log-payment
export const logPayment = asyncHandler(async (req, res) => {
  const inst = await Installment.findById(req.params.id);
  if (!inst) throw ApiError.notFound('Installment not found');

  const paidAmount = Number(req.body.paidAmount) || inst.amount;
  inst.paid = true;
  // Every logged payment awaits a second check: only an admin can verify it
  // (PATCH /:id/verify), and until then it shows as Pending Verification.
  inst.verified = false;
  inst.paidAmount = paidAmount;
  inst.paidOn = req.body.paidOn ? new Date(req.body.paidOn) : new Date();
  inst.reference = req.body.reference || inst.reference;
  inst.debitAccount = req.body.debitAccount || inst.debitAccount;
  inst.creditAccount = req.body.creditAccount || inst.creditAccount;

  // Tax-bill (GST-inclusive) payment entry — optional.
  if (req.body.taxableValue != null) {
    inst.taxableValue = Number(req.body.taxableValue) || 0;
    inst.gstPercent = Number(req.body.gstPercent) || 0;
    inst.taxAmount = Number(req.body.taxAmount) || 0;
  }

  // Mirror into the Payment ledger so accounting totals stay in sync.
  const payment = await createPaymentWithRetry({
    party: inst.direction === 'incoming' ? 'customer' : 'supplier',
    booking: inst.booking,
    query: inst.query,
    supplier: inst.direction === 'outgoing' ? { kind: 'other', name: inst.supplierName || 'Supplier' } : undefined,
    amount: paidAmount,
    currency: inst.currency,
    mode: req.body.mode || 'Bank Transfer',
    reference: inst.reference,
    date: inst.paidOn,
    notes: `Installment #${inst.installmentNumber}`,
    createdBy: req.user._id,
  });
  inst.payment = payment._id;
  await splitRemainder(inst, req.user._id);
  await inst.save();

  if (inst.direction === 'incoming') await syncBookingPaid(inst.booking);

  // Notify booking owner about received payment.
  if (inst.direction === 'incoming') {
    const booking = await Booking.findById(inst.booking).populate('owner', '_id');
    if (booking?.owner && String(booking.owner._id) !== String(req.user._id)) {
      await createNotification({
        recipient: booking.owner._id,
        type: 'payment_received',
        title: 'Payment Received',
        body: `₹${paidAmount.toLocaleString('en-IN')} received — Instalment #${inst.installmentNumber}`,
        link: `/bookings/${inst.booking}`,
        createdBy: req.user._id,
      });
    }
  }

  return ok(res, inst);
});

// PATCH /api/installments/:id/payment — correct an already-logged payment
// (amount, date, accounts, reference, tax split). Keeps the mirrored Payment
// ledger row and the booking's paid totals in sync.
export const editPayment = asyncHandler(async (req, res) => {
  const inst = await Installment.findById(req.params.id);
  if (!inst) throw ApiError.notFound('Installment not found');
  if (!inst.paid) throw ApiError.badRequest('No payment logged for this instalment yet');

  if (req.body.paidAmount != null) inst.paidAmount = Number(req.body.paidAmount) || inst.paidAmount;
  if (req.body.paidOn) inst.paidOn = new Date(req.body.paidOn);
  if (req.body.reference !== undefined) inst.reference = req.body.reference;
  if (req.body.debitAccount) inst.debitAccount = req.body.debitAccount;
  if (req.body.creditAccount) inst.creditAccount = req.body.creditAccount;
  if (req.body.taxableValue != null) {
    inst.taxableValue = Number(req.body.taxableValue) || 0;
    inst.gstPercent = Number(req.body.gstPercent) || 0;
    inst.taxAmount = Number(req.body.taxAmount) || 0;
  }

  if (inst.payment) {
    await Payment.findByIdAndUpdate(inst.payment, {
      amount: inst.paidAmount,
      date: inst.paidOn,
      reference: inst.reference,
      ...(req.body.mode ? { mode: req.body.mode } : {}),
    });
  }
  // If the corrected paid amount is below the instalment's due amount, the
  // balance becomes a new open instalment (same as a fresh partial payment).
  await splitRemainder(inst, req.user._id);
  await inst.save();
  if (inst.direction === 'incoming') await syncBookingPaid(inst.booking);
  return ok(res, inst);
});

// DELETE /api/installments/:id/payment — undo a mistakenly logged payment:
// clears the paid state (and any verification), removes the mirrored Payment
// ledger row, and re-syncs the booking's paid total. The instalment itself
// stays scheduled, back to its due state.
export const undoPayment = asyncHandler(async (req, res) => {
  const inst = await Installment.findById(req.params.id);
  if (!inst) throw ApiError.notFound('Installment not found');
  if (!inst.paid) throw ApiError.badRequest('No payment logged for this instalment');

  if (inst.payment) await Payment.findByIdAndDelete(inst.payment);
  inst.paid = false;
  inst.verified = false;
  inst.paidAmount = undefined;
  inst.paidOn = undefined;
  inst.reference = undefined;
  inst.payment = undefined;
  inst.verifiedBy = undefined;
  inst.verifiedAt = undefined;
  inst.taxableValue = undefined;
  inst.gstPercent = undefined;
  inst.taxAmount = undefined;
  await inst.save();
  if (inst.direction === 'incoming') await syncBookingPaid(inst.booking);
  return ok(res, inst);
});

// Builds the payment receipt PDF for a paid instalment. Shared by the
// authenticated route below and the public (tokenised) share link.
export async function buildReceiptPdf(id, orgId) {
  const inst = await Installment.findById(id)
    .populate('payment', 'mode')
    .populate('query', 'queryNumber pax');
  if (!inst) throw ApiError.notFound('Installment not found');
  if (!inst.paid) throw ApiError.badRequest('No payment logged for this instalment yet');

  const org = await OrgProfile.getFor(orgId).catch(() => null);
  // Paid-so-far / scheduled totals across the trip's incoming instalments.
  const queryId = inst.query?._id || inst.query;
  const siblings = queryId ? await Installment.find({ query: queryId, direction: 'incoming' }) : [inst];
  const totals = {
    paid: siblings.reduce((s, r) => s + (r.paidAmount || 0), 0),
    scheduled: siblings.reduce((s, r) => s + (r.amount || 0), 0),
  };
  const paxObj = inst.query?.pax;
  const pax = paxObj
    ? `${paxObj.adults || 0} Adult${(paxObj.adults || 0) === 1 ? '' : 's'}${paxObj.children?.length ? `, ${paxObj.children.length} Child${paxObj.children.length === 1 ? '' : 'ren'}` : ''}`
    : '';

  const html = paymentReceiptHtml(inst.toObject(), { org: org?.toObject(), mode: inst.payment?.mode || '', pax, totals });
  const pdf = await htmlToPdf(html);
  return { pdf, filename: `PaymentReceipt-${inst.installmentNumber}.pdf` };
}

// GET /api/installments/:id/receipt — payment receipt PDF for a paid instalment
export const receiptPdf = asyncHandler(async (req, res) => {
  const { pdf, filename } = await buildReceiptPdf(req.params.id, req.organizationId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  return res.send(pdf);
});

// POST /api/installments/:id/whatsapp-template  { templateName, bodyValues }
// Sends a pre-approved WhatsApp template (e.g. a "payment received" thank-you)
// via Gallabox — templateName/bodyValues must match what's actually been
// created and approved in the Gallabox dashboard.
export const sendPaymentTemplate = asyncHandler(async (req, res) => {
  const inst = await Installment.findById(req.params.id);
  if (!inst) throw ApiError.notFound('Instalment not found');
  if (!inst.paid) throw ApiError.badRequest('No payment logged for this instalment yet');

  const { templateName, bodyValues } = req.body;
  if (!String(templateName || '').trim()) throw ApiError.badRequest('Template name is required');

  const phone0 = inst.guest?.phones?.[0];
  const phone = phone0 ? `${phone0.countryCode || '91'}${phone0.number || ''}` : '';
  const guestName = [inst.guest?.salutation, inst.guest?.name].filter(Boolean).join(' ') || 'Guest';

  // The OpenWA transport sends finished text, so it needs the copy this name refers to. Looked
  // up server-side rather than trusted from the client, as in the trip-scoped send, falling back
  // to the starter catalog for a template the organization never seeded.
  const stored = await WhatsappTemplate.findOne({ name: templateName }).select('body').lean();
  const body = stored?.body || DEFAULT_WHATSAPP_TEMPLATES.find((t) => t.name === templateName)?.body;

  const result = await sendWhatsAppTemplate({
    phone,
    name: guestName,
    templateName,
    bodyValues,
    body,
    // This organization's own linked number, so the guest hears from the company they booked with.
    sessionId: env.whatsapp.provider === 'openwa' ? await resolveSessionId() : undefined,
  });
  return ok(res, { sent: true, ...result });
});

// PATCH /api/installments/:id/verify — admin-only second check on a logged payment.
export const verifyInstallment = asyncHandler(async (req, res) => {
  const inst = await Installment.findByIdAndUpdate(
    req.params.id,
    { verified: true, verifiedBy: req.user._id, verifiedAt: new Date() },
    { new: true }
  );
  if (!inst) throw ApiError.notFound('Installment not found');
  return ok(res, inst);
});

// POST /api/installments/:id/comments
export const addComment = asyncHandler(async (req, res) => {
  const inst = await Installment.findById(req.params.id);
  if (!inst) throw ApiError.notFound('Installment not found');
  if (!req.body.body?.trim()) throw ApiError.badRequest('Comment is required');
  inst.comments.push({ body: req.body.body.trim(), createdBy: req.user._id });
  await inst.save();
  return ok(res, inst);
});

// DELETE /api/installments/:id
export const deleteInstallment = asyncHandler(async (req, res) => {
  const inst = await Installment.findByIdAndDelete(req.params.id);
  if (!inst) throw ApiError.notFound('Installment not found');
  if (inst.payment) await Payment.findByIdAndDelete(inst.payment);
  if (inst.direction === 'incoming') await syncBookingPaid(inst.booking);
  return ok(res, { id: req.params.id });
});

/**
 * Create incoming + outgoing instalments for a freshly-created booking.
 * Incoming = full selling price due at trip start (what the customer owes us).
 * Outgoing = total supplier cost due at trip start (what we owe suppliers).
 * Safe to call repeatedly — skips a direction if one already exists.
 */
export async function generateForBooking(booking, quote, userId, opts = {}) {
  if (!booking) return;
  const b = await Booking.findById(booking._id).populate('destinations', 'name').populate('query', 'queryNumber');
  if (!b) return;
  const base = {
    booking: b._id,
    query: b.query?._id || b.query,
    tripId: b.query?.queryNumber ? String(b.query.queryNumber) : undefined,
    guest: b.guest,
    destinations: (b.destinations || []).map((d) => d.name).filter(Boolean),
    startDate: b.startDate,
    endDate: b.endDate,
    currency: b.currency || 'INR',
    dueDate: b.startDate || b.createdAt || new Date(),
    createdBy: userId,
  };

  const out = [];
  const hasIncoming = await Installment.findOne({ booking: b._id, direction: 'incoming' });
  if (!hasIncoming && b.totalAmount > 0) {
    // Custom schedule from the conversion page, else one full-amount instalment.
    const rows = (Array.isArray(opts.instalments) ? opts.instalments : [])
      .map((r) => ({ amount: Number(r.amount) || 0, dueDate: r.dueDate ? new Date(r.dueDate) : base.dueDate }))
      .filter((r) => r.amount > 0);
    const schedule = rows.length ? rows : [{ amount: b.totalAmount, dueDate: base.dueDate }];
    const comment = opts.comment?.trim() ? [{ body: opts.comment.trim(), createdBy: userId }] : null;
    schedule.forEach((r, i) => out.push({
      ...base, direction: 'incoming', amount: r.amount, dueDate: r.dueDate,
      ...(i === 0 && comment ? { comments: comment } : {}),
    }));
  }
  const supplierCost = (quote?.costItems || b.costItems || []).reduce((s, it) => s + (it.amount || 0), 0);
  const hasOutgoing = await Installment.findOne({ booking: b._id, direction: 'outgoing' });
  if (!hasOutgoing && supplierCost > 0) {
    out.push({ ...base, direction: 'outgoing', amount: supplierCost, supplierName: `Suppliers (Trip ${base.tripId || ''})`.trim() });
  }
  for (const doc of out) {
    // create() one-by-one so the pre-save counter runs; retry on E11000 —
    // a desynced counter here once cost a booking its whole payment schedule.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await Installment.create(doc);
        break;
      } catch (err) {
        if (err.code === 11000 && attempt < 3) {
          // eslint-disable-next-line no-await-in-loop
          await healCounterFromDup(err, Installment, 'installment', 'installmentNumber');
          continue;
        }
        throw err;
      }
    }
  }
  return out.length;
}
