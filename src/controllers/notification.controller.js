import { Notification } from '../models/Notification.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ok } from '../utils/apiResponse.js';

// Utility — call from any controller to push a notification.
export async function createNotification({ recipient, type, title, body, link, createdBy }) {
  if (!recipient) return;
  try {
    await Notification.create({ recipient, type, title, body, link, createdBy });
  } catch {
    // Non-fatal — never block the main action.
  }
}

// GET /api/notifications?page=&limit=
export const listNotifications = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const page  = Math.max(Number(req.query.page)  || 1, 1);
  const skip  = (page - 1) * limit;

  const filter = { recipient: req.user._id };
  if (req.query.unread === 'true') filter.read = false;

  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('createdBy', 'name'),
    Notification.countDocuments(filter),
    Notification.countDocuments({ recipient: req.user._id, read: false }),
  ]);

  return ok(res, items, { total, page, limit, unread });
});

// GET /api/notifications/unread-count
export const unreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({ recipient: req.user._id, read: false });
  return ok(res, { count });
});

// PATCH /api/notifications/:id/read
export const markRead = asyncHandler(async (req, res) => {
  const n = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipient: req.user._id },
    { read: true },
    { new: true }
  );
  if (!n) throw ApiError.notFound('Notification not found');
  return ok(res, n);
});

// PATCH /api/notifications/read-all
export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ recipient: req.user._id, read: false }, { read: true });
  return ok(res, { message: 'All notifications marked as read' });
});

// DELETE /api/notifications/:id
export const deleteNotification = asyncHandler(async (req, res) => {
  const n = await Notification.findOneAndDelete({ _id: req.params.id, recipient: req.user._id });
  if (!n) throw ApiError.notFound('Notification not found');
  return ok(res, { id: req.params.id });
});

// DELETE /api/notifications/clear-all
export const clearAll = asyncHandler(async (req, res) => {
  await Notification.deleteMany({ recipient: req.user._id, read: true });
  return ok(res, { message: 'Read notifications cleared' });
});
