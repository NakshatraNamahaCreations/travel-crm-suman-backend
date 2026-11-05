import { ServiceBooking, SERVICE_BOOKING_STATUSES, SERVICE_BOOKING_KINDS } from '../models/ServiceBooking.js';
import { Quote } from '../models/Quote.js';
import { Query } from '../models/Query.js';
import { Hotel } from '../models/Hotel.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { voucherHtml } from '../pdf/voucherHtml.js';
import { htmlToPdf } from '../pdf/renderPdf.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';

const pkgOf = (quote) => quote?.packages?.[quote.selectedPackageIndex || 0] || quote?.packages?.[0] || null;
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };

// GET /api/service-bookings?query=<id>&kind=hotel
export const listServiceBookings = asyncHandler(async (req, res) => {
  const { query, kind } = req.query;
  if (!query) throw ApiError.badRequest('query id is required');
  const filter = { query };
  if (kind) filter.kind = kind;
  // Date-wise within each kind — a hotel booked again later in the trip must
  // sit at its own check-in date, not next to its earlier stay.
  const items = await ServiceBooking.find(filter).populate('bookedBy', 'name').sort({ kind: 1, checkIn: 1, order: 1, createdAt: 1 });
  return ok(res, items);
});

// A hotel row's `nights` can be non-contiguous (e.g. [1,5,6,7] — same hotel,
// checked back into on a later night after a stay elsewhere). Each
// contiguous run is a separate physical stay/booking, so split on gaps.
function contiguousRuns(nights) {
  const sorted = [...new Set(nights)].sort((a, b) => a - b);
  const runs = [];
  let run = [];
  for (const n of sorted) {
    if (run.length && n !== run[run.length - 1] + 1) { runs.push(run); run = []; }
    run.push(n);
  }
  if (run.length) runs.push(run);
  return runs.length ? runs : [[]];
}

// Build the booking rows for one kind from the quote package.
function rowsFromQuote(pkg, startDate) {
  // Alternative hotel options are quote-time choices — never booked as-is.
  // One ServiceBooking per CONTIGUOUS run of nights, so a hotel booked again
  // later in the trip shows as its own stay instead of one row spanning the gap.
  const hotels = [];
  (pkg.hotels || []).filter((h) => !h.isAlternative).forEach((h) => {
    const allNights = (h.nights || []).slice().sort((a, b) => a - b);
    const totalCount = Math.max(1, allNights.length);
    const perNight = Math.round((h.amount || 0) / totalCount);
    const bits = [h.mealPlan, `${h.rooms || 1} ${h.roomType || 'Room'}`];
    if (h.aweb) bits.push(`${h.aweb} AWEB`);
    if (h.cweb) bits.push(`${h.cweb} CWEB`);
    const detail = bits.filter(Boolean).join(' • ');

    contiguousRuns(allNights).forEach((run) => {
      const count = Math.max(1, run.length);
      const checkIn = startDate ? addDays(startDate, (run[0] || 1) - 1) : null;
      const checkOut = checkIn ? addDays(checkIn, count) : null;
      const nightRates = Array.from({ length: count }, (_, n) => ({
        date: checkIn ? addDays(checkIn, n) : null,
        given: perNight,
        booked: perNight,
      }));
      hotels.push({
        kind: 'hotel', name: h.hotelName, city: h.city, stars: h.stars, hotelRef: h.hotel || null,
        roomType: h.roomType, mealPlan: h.mealPlan, rooms: h.rooms, paxPerRoom: h.paxPerRoom,
        aweb: h.aweb, cweb: h.cweb, cnb: h.cnb,
        nights: run, checkIn, checkOut, nightRates, detail,
        price: perNight * count, order: hotels.length,
      });
    });
  });

  const operational = (pkg.transports || []).map((t, i) => {
    const price = (t.items || []).reduce((s, it) => s + (it.amount || (it.qty || 0) * (it.rate || 0)), 0);
    const detail = (t.items || []).map((it) => `${it.qty || 1}× ${it.type || 'Service'}`).join(', ');
    const dayNo = (Array.isArray(t.days) && t.days[0]) || t.day || i + 1;
    const checkIn = startDate ? addDays(startDate, dayNo - 1) : null;
    return {
      kind: 'operational', name: t.serviceLocation || t.serviceType || `Day ${dayNo} Service`,
      detail: [t.serviceType, detail].filter(Boolean).join(' — '), day: dayNo, checkIn, price, order: i,
    };
  });

  const flights = (pkg.flights || []).map((f, i) => ({
    kind: 'flight', name: f.label || `Flight ${i + 1}`, price: f.cost || 0, order: i,
  }));

  return { hotel: hotels, operational, flight: flights };
}

// Shared helper — called from createFromQuote and the manual generate endpoint.
export async function autoGenerateServiceBookings(queryId, quoteId, userId, kinds = ['hotel', 'operational', 'flight']) {
  const [quote, query] = await Promise.all([Quote.findById(quoteId), Query.findById(queryId)]);
  if (!quote) return [];
  const pkg = pkgOf(quote);
  if (!pkg) return [];

  const startDate = quote.startDate || query?.startDate;
  const byKind = rowsFromQuote(pkg, startDate);

  const createdRows = [];
  for (const k of kinds) {
    const exists = await ServiceBooking.countDocuments({ query: queryId, kind: k });
    if (exists) continue;
    const rows = (byKind[k] || []).map((r) => ({ ...r, query: queryId, quote: quoteId, bookedBy: userId || null }));
    if (rows.length) createdRows.push(...(await ServiceBooking.insertMany(rows)));
  }
  return createdRows;
}

/* ------------- re-sync after the converted quote is edited in place ------------- */

const dkey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// The "slot" a line occupies in the trip: a hotel stay is identified by its
// first night, an operational service by day + name, a flight by its label.
// Editing what is booked in a slot (another hotel for night 3) keeps the line;
// the line is rewritten or flagged depending on how far operations got.
function slotKey(kind, r) {
  if (kind === 'hotel') return `hotel:${(r.nights || [])[0] ?? dkey(r.checkIn)}`;
  if (kind === 'operational') return `op:${r.day ?? ''}:${r.name || ''}`;
  return `flight:${r.name || ''}`;
}
function withOccurrence(kind, rows) {
  const counts = {};
  return rows.map((row) => {
    const k = slotKey(kind, row);
    counts[k] = (counts[k] || 0) + 1;
    return { key: `${k}#${counts[k]}`, row };
  });
}
// What the quote says about a line, normalised so defaults compare equal.
const fingerprint = (r) => JSON.stringify({
  name: r.name || '', city: r.city || '', roomType: r.roomType || '', mealPlan: r.mealPlan || '',
  rooms: r.rooms ?? null, paxPerRoom: r.paxPerRoom ?? 2, aweb: r.aweb || 0, cweb: r.cweb || 0, cnb: r.cnb || 0,
  nights: [...(r.nights || [])], checkIn: dkey(r.checkIn), checkOut: dkey(r.checkOut),
  detail: r.detail || '', price: Math.round(r.price || 0), day: r.day ?? null,
});
const describe = (kind, r) => (kind === 'hotel'
  ? `${r.name}${r.roomType ? `, ${r.rooms || 1} ${r.roomType}` : ''}${r.mealPlan ? ` (${r.mealPlan})` : ''}, ${dkey(r.checkIn)} to ${dkey(r.checkOut)}, INR ${Math.round(r.price || 0).toLocaleString('en-IN')}`
  : `${r.name}${r.detail ? ` — ${r.detail}` : ''}, INR ${Math.round(r.price || 0).toLocaleString('en-IN')}`);
// A line nobody has started on, paid for or vouchered can be rewritten silently.
const untouched = (r) => r.status === 'initialized' && !(r.amountPaid > 0) && !r.confirmationNumber && !r.voucherGeneratedAt;

// Bring the trip's service booking lines back in line with the (edited)
// converted quote. Returns counts, or null when there is nothing to derive from.
export async function resyncServiceBookings(queryId, quoteId, userId) {
  const [quote, query] = await Promise.all([Quote.findById(quoteId), Query.findById(queryId)]);
  const pkg = pkgOf(quote);
  if (!quote || !pkg) return null;

  const byKind = rowsFromQuote(pkg, quote.startDate || query?.startDate);
  const summary = { updated: 0, added: 0, removed: 0, flagged: 0 };
  const stamp = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const flag = (row, text) => {
    row.flagged = true;
    row.comment = [row.comment, `[Quote changed ${stamp}] ${text}`].filter(Boolean).join('\n');
    if (row.status === 'in_progress') row.status = 'changed';
  };

  for (const kind of SERVICE_BOOKING_KINDS) {
    const existing = await ServiceBooking.find({ query: queryId, kind }).sort({ checkIn: 1, order: 1, createdAt: 1 });
    const want = withOccurrence(kind, byKind[kind] || []);
    const have = withOccurrence(kind, existing);
    const haveByKey = new Map(have.map((h) => [h.key, h.row]));
    const kept = new Set();

    for (const { key, row: desired } of want) {
      const current = haveByKey.get(key);
      if (!current) {
        // eslint-disable-next-line no-await-in-loop
        await ServiceBooking.create({ ...desired, query: queryId, quote: quoteId, bookedBy: userId || null });
        summary.added += 1;
        continue;
      }
      kept.add(key);
      if (fingerprint(current) === fingerprint(desired)) continue;
      if (untouched(current)) {
        Object.assign(current, desired, { quote: quoteId });
        summary.updated += 1;
      } else {
        flag(current, `quote now has ${describe(kind, desired)}`);
        summary.flagged += 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await current.save();
    }

    for (const { key, row: current } of have) {
      if (kept.has(key)) continue;
      if (untouched(current)) {
        // eslint-disable-next-line no-await-in-loop
        await current.deleteOne();
        summary.removed += 1;
      } else {
        flag(current, 'no longer part of the quote');
        summary.flagged += 1;
        // eslint-disable-next-line no-await-in-loop
        await current.save();
      }
    }
  }
  return summary;
}

// POST /api/service-bookings/generate  { query, quote, kind? }
// Creates booking lines from the accepted quote for kinds that have none yet.
export const generateServiceBookings = asyncHandler(async (req, res) => {
  const { query: queryId, quote: quoteId, kind } = req.body;
  if (!queryId || !quoteId) throw ApiError.badRequest('query and quote are required');

  const kinds = kind ? [kind] : ['hotel', 'operational', 'flight'];
  const createdRows = await autoGenerateServiceBookings(queryId, quoteId, req.user?._id, kinds);
  if (!createdRows.length && !kind) throw ApiError.badRequest('Quote has no package to generate from');
  return created(res, createdRows);
});

// PATCH /api/service-bookings/:id  — status / price / tag / comment / detail / nightRates / occupancy
export const updateServiceBooking = asyncHandler(async (req, res) => {
  const patch = {};
  const fields = [
    'status', 'price', 'amountPaid', 'tag', 'comment', 'detail', 'name', 'roomType', 'mealPlan', 'rooms',
    'paxPerRoom', 'aweb', 'cweb', 'cnb', 'nightRates', 'flagged',
  ];
  for (const f of fields) {
    if (req.body[f] !== undefined) patch[f] = req.body[f];
  }
  if (patch.status && !SERVICE_BOOKING_STATUSES.includes(patch.status)) {
    throw ApiError.badRequest('Invalid status');
  }
  // The Prices panel edits nights directly — keep price/checkIn/checkOut/nights in sync.
  if (Array.isArray(patch.nightRates)) {
    const dates = patch.nightRates.map((n) => n.date).filter(Boolean).sort();
    patch.price = patch.nightRates.reduce((s, n) => s + (Number(n.booked) || 0), 0);
    patch.nights = patch.nightRates.map((_, i) => i + 1);
    if (dates.length) {
      patch.checkIn = dates[0];
      patch.checkOut = addDays(new Date(dates[dates.length - 1]), 1);
    }
  }
  const item = await ServiceBooking.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true })
    .populate('bookedBy', 'name');
  if (!item) throw ApiError.notFound('Service booking not found');
  return ok(res, item);
});

// DELETE /api/service-bookings/:id
export const deleteServiceBooking = asyncHandler(async (req, res) => {
  const item = await ServiceBooking.findByIdAndDelete(req.params.id);
  if (!item) throw ApiError.notFound('Service booking not found');
  return ok(res, { id: req.params.id });
});

// POST /api/service-bookings/:id/voucher?format=html|pdf
// Saves the confirmation number / contact / notes on the stay, then builds a
// single-hotel confirmation voucher (Bookings > Hotel Check-Ins "Generate").
export const generateHotelVoucher = asyncHandler(async (req, res) => {
  const { confirmationNumber, voucherContact, voucherNotes, prices, removeBranding } = req.body || {};
  const row = await ServiceBooking.findByIdAndUpdate(
    req.params.id,
    { confirmationNumber, voucherContact, voucherNotes, voucherGeneratedAt: new Date() },
    { new: true, runValidators: true }
  ).populate({ path: 'query', select: 'queryNumber guest pax destinations' });
  if (!row) throw ApiError.notFound('Service booking not found');
  if (row.kind !== 'hotel') throw ApiError.badRequest('Vouchers are only available for hotel bookings');

  const [org, hotel] = await Promise.all([
    OrgProfile.getFor(req.organizationId).catch(() => null),
    row.hotelRef ? Hotel.findById(row.hotelRef).select('address checkIn checkOut') : null,
  ]);

  const count = Math.max(1, row.nightRates?.length || row.nights?.length || 1);
  const syntheticQuote = {
    query: row.query || {},
    nights: count,
    startDate: row.checkIn,
    packages: [{
      hotels: [{
        nights: Array.from({ length: count }, (_, i) => i + 1),
        hotelName: row.name, city: row.city, roomType: row.roomType, mealPlan: row.mealPlan,
        rooms: row.rooms, aweb: row.aweb, cweb: row.cweb, cnb: row.cnb, amount: row.price, isAlternative: false,
      }],
    }],
  };

  const html = voucherHtml(syntheticQuote, {
    org: org?.toObject?.() || org,
    type: 'hotels',
    options: {
      prices: !!prices, removeBranding: !!removeBranding,
      confirmationNumber: confirmationNumber || '', voucherContact: voucherContact || '', voucherNotes: voucherNotes || '',
      hotelAddress: hotel?.address || '', hotelCheckInTime: hotel?.checkIn || '', hotelCheckOutTime: hotel?.checkOut || '',
    },
  });

  if (req.query.format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }
  const pdf = await htmlToPdf(html);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="HOTEL-VOUCHER-${row.query?.queryNumber || row._id}-${(row.name || 'hotel').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
  return res.send(pdf);
});

// GET /api/service-bookings/:id/hotel-info — hotel master address/check-in
// policy for the "verify hotel details" panel in the Generate Voucher modal.
export const getHotelVoucherInfo = asyncHandler(async (req, res) => {
  const row = await ServiceBooking.findById(req.params.id).select('hotelRef name city');
  if (!row) throw ApiError.notFound('Service booking not found');
  const hotel = row.hotelRef ? await Hotel.findById(row.hotelRef).select('address checkIn checkOut') : null;
  return ok(res, { hotelId: row.hotelRef || null, address: hotel?.address || row.city || '', checkIn: hotel?.checkIn || '', checkOut: hotel?.checkOut || '' });
});
