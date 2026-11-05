import { Option } from '../models/Option.js';
import { Hotel } from '../models/Hotel.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// How many hotels use each option value, per category (drives the "Hotels" column).
const USAGE = {
  mealPlan: () => Hotel.aggregate([{ $unwind: '$mealPlans' }, { $group: { _id: '$mealPlans', n: { $sum: 1 } } }]),
  roomType: () => Hotel.aggregate([{ $unwind: '$roomTypes' }, { $group: { _id: '$roomTypes.name', n: { $sum: 1 } } }]),
  hotelGroup: () => Hotel.aggregate([{ $match: { groupName: { $nin: [null, ''] } } }, { $group: { _id: '$groupName', n: { $sum: 1 } } }]),
  paymentPreference: () => Hotel.aggregate([{ $match: { paymentPreference: { $nin: [null, ''] } } }, { $group: { _id: '$paymentPreference', n: { $sum: 1 } } }]),
};

// GET /api/options?category=&search=
export const listOptions = asyncHandler(async (req, res) => {
  const { category, search } = req.query;
  if (!category) throw ApiError.badRequest('category is required');
  const filter = { category, isActive: true };
  if (search) filter.value = new RegExp(escapeRx(search.trim()), 'i');
  // Alphabetical (case-insensitive) so dropdowns read A, B, C…
  const items = await Option.find(filter)
    .collation({ locale: 'en', strength: 1 })
    .sort({ value: 1 })
    .limit(100);
  return ok(res, items);
});

// GET /api/options/usage?category=  — options with their hotel-usage counts + creator
export const optionUsage = asyncHandler(async (req, res) => {
  const { category, search, disabled } = req.query;
  if (!category) throw ApiError.badRequest('category is required');
  // disabled=true → only disabled entries; otherwise everything not explicitly disabled.
  const filter = { category, isActive: disabled === 'true' ? false : { $ne: false } };
  if (search) filter.value = new RegExp(escapeRx(search.trim()), 'i');
  const items = await Option.find(filter)
    .populate('createdBy', 'name')
    .populate('destinations', 'name')
    .sort({ order: 1, value: 1 })
    .limit(500);

  let counts = {};
  if (USAGE[category]) {
    const rows = await USAGE[category]();
    counts = Object.fromEntries(rows.map((r) => [String(r._id || '').toLowerCase(), r.n]));
  }
  const out = items.map((o) => ({ ...o.toObject(), hotels: counts[String(o.value).toLowerCase()] || 0 }));
  return ok(res, out);
});

// Pull the optional cab/vehicle-type attributes out of a request body.
const cabAttrs = (body) => {
  const out = {};
  if (Array.isArray(body.destinations)) out.destinations = body.destinations;
  if (body.capacity !== undefined) out.capacity = body.capacity === '' ? undefined : Number(body.capacity);
  if (body.childAge !== undefined) out.childAge = body.childAge === '' ? undefined : Number(body.childAge);
  return out;
};

// POST /api/options  { category, value, label?, description?, destinations?, capacity?, childAge? }  — find-or-create (case-insensitive)
export const createOption = asyncHandler(async (req, res) => {
  const category = String(req.body.category || '').trim();
  const value = String(req.body.value || '').trim();
  if (!category || !value) throw ApiError.badRequest('category and value are required');

  const extra = cabAttrs(req.body);

  const existing = await Option.findOne({
    category,
    value: new RegExp(`^${escapeRx(value)}$`, 'i'),
  });
  if (existing) {
    // allow updating description / cab attributes on an existing entry
    if (req.body.description !== undefined) existing.description = req.body.description;
    Object.assign(existing, extra);
    await existing.save();
    return ok(res, existing);
  }

  const max = await Option.findOne({ category }).sort('-order');
  const item = await Option.create({
    category,
    value,
    label: req.body.label || value,
    description: req.body.description,
    order: (max?.order || 0) + 1,
    createdBy: req.user?._id,
    ...extra,
  });
  return created(res, item);
});

// PATCH /api/options/:id  — edit value/label/description and cab attributes
export const updateOption = asyncHandler(async (req, res) => {
  const patch = { ...cabAttrs(req.body) };
  if (req.body.value !== undefined) patch.value = String(req.body.value).trim();
  if (req.body.label !== undefined) patch.label = req.body.label;
  if (req.body.description !== undefined) patch.description = req.body.description;
  if (req.body.isActive !== undefined) patch.isActive = req.body.isActive;
  const item = await Option.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  if (!item) throw ApiError.notFound('Option not found');
  return ok(res, item);
});

// POST /api/options/bulk-delete-unused  { category }  — delete options not referenced by any hotel
export const bulkDeleteUnused = asyncHandler(async (req, res) => {
  const category = String(req.body.category || '').trim();
  if (!USAGE[category]) throw ApiError.badRequest('Usage is not tracked for this category');
  const rows = await USAGE[category]();
  const used = new Set(rows.map((r) => String(r._id || '').toLowerCase()));
  const all = await Option.find({ category });
  const ids = all.filter((o) => !used.has(String(o.value).toLowerCase())).map((o) => o._id);
  await Option.deleteMany({ _id: { $in: ids } });
  return ok(res, { deleted: ids.length });
});

// DELETE /api/options/:id  (admin/manager)
export const deleteOption = asyncHandler(async (req, res) => {
  const item = await Option.findByIdAndDelete(req.params.id);
  if (!item) throw ApiError.notFound('Option not found');
  return ok(res, { id: req.params.id });
});
