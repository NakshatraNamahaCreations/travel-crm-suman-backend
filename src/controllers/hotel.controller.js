import { Hotel } from '../models/Hotel.js';
import { HotelPrice } from '../models/HotelPrice.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';

// POST /api/hotels/merge { source, target }
// Folds the source hotel into the target: moves its price rows, unions meal plans
// & room types onto the target, then deletes the source.
export const mergeHotels = asyncHandler(async (req, res) => {
  const { source, target } = req.body;
  if (!source || !target) throw ApiError.badRequest('source and target hotels are required');
  if (String(source) === String(target)) throw ApiError.badRequest('Pick two different hotels to merge');

  const [src, tgt] = await Promise.all([Hotel.findById(source), Hotel.findById(target)]);
  if (!src || !tgt) throw ApiError.notFound('Hotel not found');

  // Re-point price rows to the surviving hotel.
  await HotelPrice.updateMany({ hotel: src._id }, { hotel: tgt._id });

  // Union meal plans + room types onto the target.
  tgt.mealPlans = [...new Set([...(tgt.mealPlans || []), ...(src.mealPlans || [])])];
  const have = new Set((tgt.roomTypes || []).map((r) => r.name));
  tgt.roomTypes = [...(tgt.roomTypes || []), ...((src.roomTypes || []).filter((r) => !have.has(r.name)))];
  await tgt.save();

  await Hotel.findByIdAndDelete(src._id);
  return ok(res, { merged: true, target: tgt._id, name: tgt.name });
});
