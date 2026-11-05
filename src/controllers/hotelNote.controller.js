import { HotelNote } from '../models/HotelNote.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';

// GET /api/hotel-notes
export const listHotelNotes = asyncHandler(async (req, res) => {
  const items = await HotelNote.find().populate('createdBy', 'name').sort('-createdAt');
  return ok(res, items);
});

// POST /api/hotel-notes
export const createHotelNote = asyncHandler(async (req, res) => {
  if (!req.body.notes?.trim()) throw ApiError.badRequest('Notes are required');
  const item = await HotelNote.create({ ...req.body, createdBy: req.user._id });
  return created(res, item);
});

// PATCH /api/hotel-notes/:id
export const updateHotelNote = asyncHandler(async (req, res) => {
  const item = await HotelNote.findByIdAndUpdate(req.params.id, { ...req.body }, { new: true, runValidators: true });
  if (!item) throw ApiError.notFound('Note not found');
  return ok(res, item);
});

// DELETE /api/hotel-notes/:id
export const deleteHotelNote = asyncHandler(async (req, res) => {
  const item = await HotelNote.findByIdAndDelete(req.params.id);
  if (!item) throw ApiError.notFound('Note not found');
  return ok(res, { id: req.params.id });
});
