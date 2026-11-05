import { Booking } from '../models/Booking.js';
import { Quote } from '../models/Quote.js';
import { Query } from '../models/Query.js';
import { Installment } from '../models/Installment.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';
import { generateForBooking, healCounterFromDup } from './installment.controller.js';
import { logActivity } from './activity.controller.js';
import { autoGenerateServiceBookings } from './serviceBooking.controller.js';
import { createNotification } from './notification.controller.js';
import { ownScope, applyScope } from '../utils/ownScope.js';
import { tripBasicsFrom } from '../utils/bookingSync.js';

const POPULATE = [
  { path: 'destinations', select: 'name' },
  { path: 'owner', select: 'name' },
  { path: 'query', select: 'queryNumber' },
];

// Map booking lifecycle onto the parent query's pipeline status.
const QUERY_STATUS_FOR = { confirmed: 'converted', on_trip: 'on_trip', completed: 'past', cancelled: 'canceled' };

// GET /api/bookings
export const listBookings = asyncHandler(async (req, res) => {
  let filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  if (req.query.createdAfter || req.query.createdBefore) {
    filter.createdAt = {};
    if (req.query.createdAfter) filter.createdAt.$gte = new Date(req.query.createdAfter);
    if (req.query.createdBefore) { const d = new Date(req.query.createdBefore); d.setHours(23, 59, 59, 999); filter.createdAt.$lte = d; }
  }
  if (req.query.startAfter || req.query.startBefore) {
    filter.startDate = {};
    if (req.query.startAfter) filter.startDate.$gte = new Date(req.query.startAfter);
    if (req.query.startBefore) { const d = new Date(req.query.startBefore); d.setHours(23, 59, 59, 999); filter.startDate.$lte = d; }
  }
  if (req.query.search) {
    const term = req.query.search.trim();
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ 'guest.name': rx }, { 'guest.phones.number': rx }];
    const n = Number(term);
    if (!Number.isNaN(n)) filter.$or.push({ bookingNumber: n });
  }
  // Non-admin/manager users see only bookings they own or created.
  filter = applyScope(filter, ownScope(req.user));
  const total = await Booking.countDocuments(filter);
  const meta = paginate(req.query, total);
  const items = await Booking.find(filter).populate(POPULATE).sort('-createdAt').skip(meta.skip).limit(meta.limit);
  return ok(res, items, meta);
});

// GET /api/bookings/:id
export const getBooking = asyncHandler(async (req, res) => {
  const b = await Booking.findById(req.params.id)
    .populate(POPULATE)
    .populate({ path: 'quote', select: 'quoteNumber pricing' })
    .populate('extras.addedBy', 'name');
  if (!b) throw ApiError.notFound('Booking not found');
  return ok(res, b);
});

// POST /api/bookings/from-quote/:quoteId
export const createFromQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.quoteId);
  if (!quote) throw ApiError.notFound('Quote not found');

  const query = await Query.findById(quote.query);
  if (!query) throw ApiError.badRequest('Parent query missing');

  const existing = await Booking.findOne({ quote: quote._id });
  if (existing) throw ApiError.conflict('A booking already exists for this quote');

  const booking = await Booking.create({
    query: query._id,
    quote: quote._id,
    title: quote.title,
    guest: query.guest,
    destinations: query.destinations,
    startDate: quote.startDate || query.startDate,
    nights: quote.nights ?? query.nights,
    pax: quote.pax || query.pax,
    days: quote.days,
    costItems: quote.costItems,
    currency: quote.currency,
    totalAmount: quote.pricing?.total || 0,
    owner: query.owner,
    createdBy: req.user._id,
  });

  // Confirming the quote + booking moves the query to converted.
  // Only one quote per trip can be the converted one — demote any other accepted quote.
  await Quote.updateMany({ query: query._id, _id: { $ne: quote._id }, status: 'accepted' }, { status: 'sent' });
  await Quote.findByIdAndUpdate(quote._id, { status: 'accepted' });
  // The trip now shows the converted quote's dates / nights / pax, so the
  // header, hotel lines and vouchers agree with what was actually sold.
  await Query.findByIdAndUpdate(query._id, { status: 'converted', bookedAmount: booking.totalAmount, ...tripBasicsFrom(quote) });
  await logActivity(query._id, req.user?._id, `converted to booking from quote #${quote.quoteNumber}`, 'booking');

  // Notify the trip owner that a booking was created.
  if (query.owner && String(query.owner) !== String(req.user._id)) {
    await createNotification({
      recipient: query.owner,
      type: 'booking_created',
      title: 'New Booking Created',
      body: `Booking confirmed for ${query.guest?.name || 'Guest'} — Quote #${quote.quoteNumber}`,
      link: `/bookings/${booking._id}`,
      createdBy: req.user._id,
    });
  }

  // Generate the incoming + outgoing payment schedule for this trip.
  // The conversion page can pass a custom instalment split + comment.
  try {
    await generateForBooking(booking, quote, req.user._id, {
      instalments: req.body?.instalments,
      comment: req.body?.comment,
    });
  } catch (err) {
    // Non-fatal — the booking still succeeds — but a missing schedule means
    // payments can't be tracked, so never swallow this silently.
    // eslint-disable-next-line no-console
    console.error(`[booking] instalment schedule generation FAILED for booking ${booking._id}:`, err);
  }

  // Auto-generate service booking lines (hotel / operational / flight) so the
  // Services Bookings tab is populated immediately after conversion.
  try {
    await autoGenerateServiceBookings(query._id, quote._id, req.user._id);
  } catch {
    /* non-fatal */
  }

  const populated = await booking.populate(POPULATE);
  return created(res, populated);
});

// PATCH /api/bookings/:id/status
export const updateBookingStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'on_trip', 'completed', 'cancelled'].includes(status)) {
    throw ApiError.badRequest('Invalid status');
  }
  const b = await Booking.findByIdAndUpdate(req.params.id, { status }, { new: true }).populate(POPULATE);
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.query && QUERY_STATUS_FOR[status]) {
    await Query.findByIdAndUpdate(b.query._id || b.query, { status: QUERY_STATUS_FOR[status] });
  }
  return ok(res, b);
});

// Retry instalment creation on E11000 (duplicate installmentNumber from counter race).
async function createInstalment(data) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await Installment.create({ ...data });
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

// PUT /api/bookings/:id/instalment-schedule
// Replaces all unpaid incoming instalments with the new schedule.
export const updateInstalmentSchedule = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('destinations', 'name')
    .populate('query', 'queryNumber');
  if (!booking) throw ApiError.notFound('Booking not found');

  const { instalments = [], comment } = req.body;
  if (!Array.isArray(instalments) || instalments.length === 0) {
    throw ApiError.badRequest('At least one instalment is required');
  }

  // Delete all existing unpaid incoming instalments for this booking —
  // except the ones collecting admin-added extras, which are not part of
  // the package schedule being replaced.
  const extraIds = (booking.extras || []).map((e) => e.installment).filter(Boolean);
  await Installment.deleteMany({ booking: booking._id, direction: 'incoming', paid: false, _id: { $nin: extraIds } });

  const base = {
    booking: booking._id,
    query: booking.query?._id || booking.query,
    tripId: booking.query?.queryNumber ? String(booking.query.queryNumber) : undefined,
    guest: booking.guest,
    destinations: (booking.destinations || []).map((d) => d.name).filter(Boolean),
    startDate: booking.startDate,
    endDate: booking.endDate,
    currency: booking.currency || 'INR',
    createdBy: req.user._id,
    direction: 'incoming',
  };

  for (const inst of instalments) {
    if (inst._id) continue; // already paid — backend kept it, skip recreation
    // eslint-disable-next-line no-await-in-loop
    await createInstalment({
      ...base,
      amount: Math.round(Number(inst.amount) || 0),
      dueDate: inst.dueDate ? new Date(inst.dueDate) : booking.startDate,
      ...(comment ? { comments: [{ body: comment, createdBy: req.user._id }] } : {}),
    });
  }

  const updated = await Installment.find({ booking: booking._id, direction: 'incoming' }).sort('dueDate');
  return ok(res, updated);
});

/* ----------------------------- extra charges ----------------------------- */

const extrasTotal = (b) => (b.extras || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);

// POST /api/bookings/:id/extras  { label, amount, dueDate?, note? }   (admin)
// Adds a charge on top of the package and schedules it as its own instalment.
export const addBookingExtra = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('destinations', 'name')
    .populate('query', 'queryNumber');
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.status === 'cancelled') throw ApiError.badRequest('This booking is cancelled');

  const label = String(req.body.label || '').trim();
  const amount = Math.round(Number(req.body.amount) || 0);
  const note = String(req.body.note || '').trim();
  if (!label) throw ApiError.badRequest('Say what the extra charge is for');
  if (amount <= 0) throw ApiError.badRequest('Amount must be greater than zero');

  const inst = await createInstalment({
    booking: booking._id,
    query: booking.query?._id || booking.query,
    tripId: booking.query?.queryNumber ? String(booking.query.queryNumber) : undefined,
    guest: booking.guest,
    destinations: (booking.destinations || []).map((d) => d.name).filter(Boolean),
    startDate: booking.startDate,
    endDate: booking.endDate,
    currency: booking.currency || 'INR',
    direction: 'incoming',
    amount,
    dueDate: req.body.dueDate ? new Date(req.body.dueDate) : booking.startDate || new Date(),
    comments: [{ body: `Extra: ${label}${note ? ` — ${note}` : ''}`, createdBy: req.user._id }],
    createdBy: req.user._id,
  });

  booking.extras.push({ label, amount, note, installment: inst._id, addedBy: req.user._id });
  booking.totalAmount = Math.round((booking.totalAmount || 0) + amount);
  await booking.save();
  await logActivity(
    booking.query?._id || booking.query,
    req.user._id,
    `added extra charge ${booking.currency || 'INR'} ${amount.toLocaleString('en-IN')} for "${label}" (trip total now ${(booking.totalAmount || 0).toLocaleString('en-IN')})`,
    'booking'
  );
  const populated = await Booking.findById(booking._id).populate(POPULATE).populate('extras.addedBy', 'name');
  return created(res, { booking: populated, installment: inst });
});

// DELETE /api/bookings/:id/extras/:extraId   (admin) — only while unpaid.
export const removeBookingExtra = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw ApiError.notFound('Booking not found');
  const extra = booking.extras.id(req.params.extraId);
  if (!extra) throw ApiError.notFound('Extra charge not found');

  const inst = extra.installment ? await Installment.findById(extra.installment) : null;
  if (inst && (inst.paid || (inst.paidAmount || 0) > 0)) {
    throw ApiError.badRequest('This extra has already been paid — undo the payment first');
  }
  if (inst) await inst.deleteOne();

  booking.totalAmount = Math.max(0, Math.round((booking.totalAmount || 0) - (extra.amount || 0)));
  extra.deleteOne();
  await booking.save();
  await logActivity(booking.query, req.user._id, `removed extra charge "${extra.label}" (${booking.currency || 'INR'} ${(extra.amount || 0).toLocaleString('en-IN')})`, 'booking');
  const populated = await Booking.findById(booking._id).populate(POPULATE).populate('extras.addedBy', 'name');
  return ok(res, populated);
});

// DELETE /api/bookings/:id
export const deleteBooking = asyncHandler(async (req, res) => {
  const b = await Booking.findByIdAndDelete(req.params.id);
  if (!b) throw ApiError.notFound('Booking not found');
  return ok(res, { id: req.params.id });
});
