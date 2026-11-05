import { Comment } from '../models/Comment.js';
import { Query } from '../models/Query.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';
import { ownScope, applyScope } from '../utils/ownScope.js';

const POPULATE = [
  { path: 'assignedTo', select: 'name' },
  { path: 'createdBy', select: 'name' },
];

// GET /api/comments?query=<id>
export const listComments = asyncHandler(async (req, res) => {
  if (!req.query.query) throw ApiError.badRequest('query id is required');
  const items = await Comment.find({ query: req.query.query }).populate(POPULATE).sort('-createdAt');
  return ok(res, items);
});

// GET /api/comments/tasks  — actionable tasks across all trips, with tab + advanced filters
export const listTasks = asyncHandler(async (req, res) => {
  const { tab = 'all', assignedTo, createdBy, destination, status, search } = req.query;
  const idList = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);

  const now = new Date();
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // start of today
  const eod = new Date(sod.getTime() + 864e5 - 1);                        // end of today
  const soy = new Date(sod.getTime() - 864e5);                            // start of yesterday
  const eoy = new Date(sod.getTime() - 1);                                // end of yesterday

  const filter = { isActionable: true };
  const scope = ownScope(req.user, ['createdBy', 'assignedTo']);
  const statuses = status ? idList(status) : [];

  if (statuses.length) {
    // Advanced "Task Status" filter overrides the tab's date/resolved logic.
    const or = [];
    if (statuses.includes('done')) or.push({ isResolved: true });
    if (statuses.includes('overdue')) or.push({ isResolved: false, dueDate: { $lt: sod } });
    if (statuses.includes('upcoming')) or.push({ isResolved: false, dueDate: { $gte: sod } });
    if (or.length) filter.$or = or;
  } else if (tab === 'today') { filter.isResolved = false; filter.dueDate = { $gte: sod, $lte: eod }; }
  else if (tab === 'yesterday') { filter.isResolved = false; filter.dueDate = { $gte: soy, $lte: eoy }; }
  else if (tab === 'overdue') { filter.isResolved = false; filter.dueDate = { $lt: sod }; }
  else if (tab === 'upcoming') { filter.isResolved = false; filter.dueDate = { $gt: eod }; }
  // tab === 'all' → no date/resolved restriction

  if (assignedTo) filter.assignedTo = { $in: idList(assignedTo) };
  if (createdBy) filter.createdBy = { $in: idList(createdBy) };
  if (destination) {
    const qIds = await Query.find({ destinations: { $in: idList(destination) } }).distinct('_id');
    filter.query = { $in: qIds };
  }
  if (search) filter.body = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const scopedTasks = applyScope(filter, scope);
  const total = await Comment.countDocuments(scopedTasks);
  const meta = paginate(req.query, total);
  const items = await Comment.find(scopedTasks)
    .populate(POPULATE)
    .populate({
      path: 'query',
      select: 'queryNumber guest source destinations',
      populate: [{ path: 'source', select: 'name' }, { path: 'destinations', select: 'name' }],
    })
    .sort(tab === 'all' && !statuses.length ? '-createdAt' : 'dueDate')
    .skip(meta.skip)
    .limit(meta.limit);
  return ok(res, items, meta);
});

// POST /api/comments
export const createComment = asyncHandler(async (req, res) => {
  const item = await Comment.create({ ...req.body, createdBy: req.user._id });
  const populated = await item.populate(POPULATE);
  return created(res, populated);
});

// PATCH /api/comments/:id  — edit / toggle resolve
export const updateComment = asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  if (patch.isResolved === true) patch.resolvedAt = new Date();
  if (patch.isResolved === false) patch.resolvedAt = undefined;
  const item = await Comment.findByIdAndUpdate(req.params.id, patch, { new: true }).populate(POPULATE);
  if (!item) throw ApiError.notFound('Comment not found');
  return ok(res, item);
});

// DELETE /api/comments/:id
export const deleteComment = asyncHandler(async (req, res) => {
  const item = await Comment.findByIdAndDelete(req.params.id);
  if (!item) throw ApiError.notFound('Comment not found');
  return ok(res, { id: req.params.id });
});
