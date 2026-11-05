import { HotelPrice } from '../models/HotelPrice.js';
import { TravelActivityPrice } from '../models/TravelActivityPrice.js';
import { TransportPrice } from '../models/TransportPrice.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';

// Season-aware lookup with fallback: prefer the season covering the date;
// otherwise the most recent past season; otherwise the earliest future one.
// Uploaded rate sheets often end before the travel date — a stale rate the
// user can adjust beats returning nothing.
const findRate = async (Model, filter, date) => {
  const d = date ? new Date(date) : new Date();
  let price = await Model.findOne({ ...filter, startDate: { $lte: d }, endDate: { $gte: d } }).sort('-startDate');
  if (!price) price = await Model.findOne({ ...filter, startDate: { $lte: d } }).sort('-startDate');
  if (!price) price = await Model.findOne(filter).sort('startDate');
  return price;
};

// GET /api/lookups/hotel-rate?hotel=&roomType=&mealPlan=&date=
export const hotelRate = asyncHandler(async (req, res) => {
  const { hotel, roomType, mealPlan, date } = req.query;
  const filter = { hotel };
  if (roomType) filter.roomType = roomType;
  if (mealPlan) filter.mealPlan = mealPlan;
  const price = await findRate(HotelPrice, filter, date);
  return ok(res, price);
});

// GET /api/lookups/activity-rate?activity=&service=&config=&date=
export const activityRate = asyncHandler(async (req, res) => {
  const { activity, service, config, date } = req.query;
  const filter = { activity };
  if (service) filter.service = service;
  if (config) filter.config = config;
  const price = await findRate(TravelActivityPrice, filter, date);
  return ok(res, price);
});

// GET /api/lookups/transport-rate?service=&config=&item=&date=
// Config matching is forgiving: exact (case-insensitive) → substring → any config,
// since uploaded price sheets label vehicles like "Wagon R (3 Pax)" while the
// builder may just say "Wagon R". A transport service route can carry several
// priced items (e.g. "Cellular Jail Visit" vs "Ross Island" under the same
// Port Blair route) — when `item` is given, the itemName must match too,
// otherwise the lookup can silently return another item's price.
export const transportRate = asyncHandler(async (req, res) => {
  const { service, config, item, date } = req.query;
  if (!service) throw ApiError.badRequest('service is required');
  const base = { service };
  if (item) {
    const escaped = item.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    base.itemName = new RegExp(`^${escaped}$`, 'i');
  }
  let price = null;
  if (config) {
    const escaped = config.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    price = await findRate(TransportPrice, { ...base, config: new RegExp(`^${escaped}$`, 'i') }, date);
    if (!price) price = await findRate(TransportPrice, { ...base, config: new RegExp(escaped, 'i') }, date);
  }
  if (!price) price = await findRate(TransportPrice, base, date);
  // An item-scoped miss falls back to any item on the route, so a rate still
  // surfaces for services imported before itemName was captured.
  if (!price && item) price = await findRate(TransportPrice, { service }, date);
  return ok(res, price);
});
