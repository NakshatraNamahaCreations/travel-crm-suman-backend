import { Hotel } from '../models/Hotel.js';
import { HotelPrice } from '../models/HotelPrice.js';
import { TransportService } from '../models/TransportService.js';
import { TransportPrice } from '../models/TransportPrice.js';
import { TravelActivity } from '../models/TravelActivity.js';
import { TravelActivityPrice } from '../models/TravelActivityPrice.js';
import { Quote } from '../models/Quote.js';
import { Booking } from '../models/Booking.js';
import { Installment } from '../models/Installment.js';
import { crudFactory } from '../utils/crudFactory.js';
import { makeCrudRouter } from './_crudRouter.js';
import { authorize, can } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { mergeHotels } from '../controllers/hotel.controller.js';
import { logEntityActivity } from '../controllers/activity.controller.js';

// Bulk-delete handler factory: removes every doc whose _id is in body.ids.
const bulkDelete = (Model) =>
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return ok(res, { deleted: 0 });
    const r = await Model.deleteMany({ _id: { $in: ids } });
    return ok(res, { deleted: r.deletedCount });
  });

// Inventory is maintained by ops + management. Writes are gated per-module by
// fine-grained permissions (hotels.* / transport.* / activities.*).
const W = { writeRoles: ['admin', 'manager', 'operations'] };
const stampCreator = (req) => ({ createdBy: req.user._id });

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asArray = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);

// Advanced filters for the Hotels list (driven by the filter drawer).
function hotelAdvancedFilter(q) {
  const f = {};
  if (q.destinations) f.destinations = { $in: asArray(q.destinations) };
  if (q.location) f['location.city'] = new RegExp(escapeRx(q.location.trim()), 'i');
  if (q.roomTypes) f['roomTypes.name'] = { $in: asArray(q.roomTypes) };
  if (q.mealPlans) f.mealPlans = { $in: asArray(q.mealPlans) };
  if (q.stars) {
    const stars = asArray(q.stars).map(Number).filter((n) => !Number.isNaN(n));
    if (stars.length) f.stars = { $in: stars };
  }
  if (q.updatedFrom || q.updatedTo) {
    const range = {};
    if (q.updatedFrom) range.$gte = new Date(q.updatedFrom);
    if (q.updatedTo) { const d = new Date(q.updatedTo); d.setHours(23, 59, 59, 999); range.$lte = d; }
    f.updatedAt = range;
  }
  return f;
}

// Price lists: ?activeOn=YYYY-MM-DD → rows whose season covers that date.
function priceAdvancedFilter(q) {
  const f = {};
  if (q.activeOn) {
    const d = new Date(q.activeOn);
    f.startDate = { $lte: d };
    f.endDate = { $gte: d };
  }
  return f;
}

// Advanced filters for the Travel Activities list.
function activityAdvancedFilter(q) {
  const f = {};
  if (q.destinations) f.destinations = { $in: asArray(q.destinations) };
  if (q.kind) f.kind = q.kind; // 'ticket' | 'activity'
  // ?city= matches the activity name or its pickup/drop locations ($and so it
  // composes with the search $or built by crudFactory).
  if (q.city) {
    const rx = new RegExp(escapeRx(q.city.trim()), 'i');
    f.$and = [{ $or: [{ name: rx }, { pickupLocations: rx }, { dropLocations: rx }] }];
  }
  if (q.isActive === 'false') f.isActive = false;
  return f;
}

// Advanced filters for the Transport Services list.
function transportAdvancedFilter(q) {
  const f = {};
  if (q.destinations) f.destinations = { $in: asArray(q.destinations) };
  if (q.from) f.from = new RegExp(escapeRx(q.from.trim()), 'i');
  if (q.to) f.to = new RegExp(escapeRx(q.to.trim()), 'i');
  if (q.updatedFrom || q.updatedTo) {
    const range = {};
    if (q.updatedFrom) range.$gte = new Date(q.updatedFrom);
    if (q.updatedTo) { const d = new Date(q.updatedTo); d.setHours(23, 59, 59, 999); range.$lte = d; }
    f.updatedAt = range;
  }
  return f;
}

export const hotelRoutes = makeCrudRouter(
  crudFactory(Hotel, {
    searchFields: ['name', 'location.city', 'address'],
    populate: [{ path: 'destinations', select: 'name' }],
    injectOnCreate: stampCreator,
    advancedFilter: hotelAdvancedFilter,
  }),
  { ...W, perm: 'hotels' }
);
// Custom: merge a duplicate hotel into a primary one (POST /hotels/merge).
hotelRoutes.post('/merge', authorize(...W.writeRoles), mergeHotels);
// Custom: bulk-delete selected hotels (POST /hotels/bulk-delete).
hotelRoutes.post('/bulk-delete', can('hotels.delete'), bulkDelete(Hotel));

// Helper: get booking IDs for quotes that include a given hotel.
async function bookingIdsForHotel(hotelId) {
  const quotes = await Quote.find({ 'packages.hotels.hotel': hotelId }, { _id: 1 });
  const qIds = quotes.map((q) => q._id);
  if (!qIds.length) return [];
  const bookings = await Booking.find({ quote: { $in: qIds } }, { _id: 1 });
  return bookings.map((b) => b._id);
}

// GET /hotels/:id/bookings — all bookings that used this hotel in their quote.
hotelRoutes.get('/:id/bookings', authorize('admin', 'manager', 'operations', 'sales'), asyncHandler(async (req, res) => {
  const quotes = await Quote.find(
    { 'packages.hotels.hotel': req.params.id },
    { _id: 1, packages: 1, selectedPackageIndex: 1 }
  );
  const qIds = quotes.map((q) => q._id);
  if (!qIds.length) return ok(res, []);

  const bookings = await Booking.find({ quote: { $in: qIds } })
    .populate([
      { path: 'destinations', select: 'name' },
      { path: 'query', select: 'queryNumber source' },
    ])
    .sort('-startDate')
    .limit(200);

  // Attach hotel-specific stay info from the quote.
  const quoteMap = {};
  for (const q of quotes) quoteMap[String(q._id)] = q;

  const items = bookings.map((b) => {
    const q = quoteMap[String(b.quote)];
    const pkg = q?.packages?.[q.selectedPackageIndex || 0] || q?.packages?.[0];
    const stays = (pkg?.hotels || []).filter((h) => String(h.hotel) === String(req.params.id));
    return {
      _id: b._id,
      bookingNumber: b.bookingNumber,
      title: b.title,
      guest: b.guest,
      query: b.query,
      destinations: b.destinations,
      startDate: b.startDate,
      endDate: b.endDate,
      nights: b.nights,
      status: b.status,
      totalAmount: b.totalAmount,
      currency: b.currency || 'INR',
      stays,
    };
  });
  return ok(res, items);
}));

// GET /hotels/:id/payments — installments for bookings using this hotel.
hotelRoutes.get('/:id/payments', authorize('admin', 'manager', 'operations', 'sales'), asyncHandler(async (req, res) => {
  const bookingIds = await bookingIdsForHotel(req.params.id);
  if (!bookingIds.length) return ok(res, [], { total: 0 });

  const filter = { booking: { $in: bookingIds } };
  if (req.query.direction) filter.direction = req.query.direction;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const f = req.query.filter;
  if (f === 'upcoming') { filter.paid = false; filter.dueDate = { $gte: today }; }
  else if (f === 'past7') { filter.updatedAt = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }; }
  else if (f === 'unverified') { filter.paid = true; filter.verified = false; }
  else if (f === 'paid') { filter.paid = true; filter.verified = true; }
  else if (f === 'overdue') { filter.paid = false; filter.dueDate = { $lt: today }; }

  const rows = await Installment.find(filter).sort('-createdAt').limit(200);
  return ok(res, rows, { total: rows.length });
}));

export const hotelPriceRoutes = makeCrudRouter(
  crudFactory(HotelPrice, {
    searchFields: ['mealPlan', 'roomType'],
    filterFields: ['hotel', 'mealPlan', 'roomType'],
    populate: [{ path: 'hotel', select: 'name location stars' }],
    sort: '-startDate',
    injectOnCreate: stampCreator,
    advancedFilter: priceAdvancedFilter,
  }),
  { ...W, perm: 'hotels' }
);

export const transportRoutes = makeCrudRouter(
  crudFactory(TransportService, {
    searchFields: ['name', 'from', 'to'],
    sort: 'from to name', // A→Z by route, not newest-first
    populate: [{ path: 'destinations', select: 'name' }, { path: 'createdBy', select: 'name' }],
    injectOnCreate: stampCreator,
    advancedFilter: transportAdvancedFilter,
    onChange: (req, doc, action) => logEntityActivity('transport', doc._id, req.user?._id, `${action} ${doc.name}`, action),
  }),
  { ...W, perm: 'transport' }
);
// Custom: bulk-disable every active transport service.
transportRoutes.post('/bulk-disable', authorize(...W.writeRoles), asyncHandler(async (req, res) => {
  const r = await TransportService.updateMany({ isActive: true }, { isActive: false });
  return ok(res, { disabled: r.modifiedCount });
}));
// Custom: bulk-delete selected transport services (POST /transport-services/bulk-delete).
transportRoutes.post('/bulk-delete', can('transport.delete'), bulkDelete(TransportService));

export const transportPriceRoutes = makeCrudRouter(
  crudFactory(TransportPrice, {
    searchFields: ['config', 'itemName'],
    filterFields: ['service'],
    populate: [{ path: 'service', select: 'name from to' }],
    sort: '-startDate',
    injectOnCreate: stampCreator,
    advancedFilter: priceAdvancedFilter,
  }),
  { ...W, perm: 'transport' }
);

export const activityRoutes = makeCrudRouter(
  crudFactory(TravelActivity, {
    searchFields: ['name'],
    populate: [{ path: 'destinations', select: 'name' }],
    injectOnCreate: stampCreator,
    advancedFilter: activityAdvancedFilter,
  }),
  { ...W, perm: 'activities' }
);
// Custom: bulk-disable every active travel activity.
activityRoutes.post('/bulk-disable', authorize(...W.writeRoles), asyncHandler(async (req, res) => {
  const r = await TravelActivity.updateMany({ isActive: { $ne: false } }, { isActive: false });
  return ok(res, { disabled: r.modifiedCount });
}));

export const activityPriceRoutes = makeCrudRouter(
  crudFactory(TravelActivityPrice, {
    searchFields: ['service', 'config'],
    filterFields: ['activity', 'service', 'config'],
    populate: [{ path: 'activity', select: 'name' }],
    sort: '-startDate',
    injectOnCreate: stampCreator,
    advancedFilter: priceAdvancedFilter,
  }),
  { ...W, perm: 'activities' }
);
