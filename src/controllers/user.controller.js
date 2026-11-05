import { User } from '../models/User.js';
import { Query } from '../models/Query.js';
import { Booking } from '../models/Booking.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';
import { ALL_PERMISSIONS, encodePermissionKey } from '../config/permissions.js';

// Keep only known permission keys with explicit boolean values.
function sanitizeOverrides(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const key of ALL_PERMISSIONS) {
    // Stored under the encoded key — Mongoose Maps reject dots in key names.
    if (typeof input[key] === 'boolean') out[encodePermissionKey(key)] = input[key];
  }
  return Object.keys(out).length ? out : undefined;
}

// GET /api/users
export const listUsers = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.search) {
    const rx = new RegExp(req.query.search.trim(), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  if (req.query.role) filter.role = req.query.role;
  if (req.query.team) filter.team = req.query.team;

  const total = await User.countDocuments(filter);
  const meta = paginate(req.query, total);
  const users = await User.find(filter)
    .populate('team', 'name')
    .sort('-createdAt')
    .skip(meta.skip)
    .limit(meta.limit);
  return ok(res, users, meta);
});

// GET /api/users/:id
export const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('team', 'name');
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

// POST /api/users  (admin/manager)
export const createUser = asyncHandler(async (req, res) => {
  // Email is globally unique (one email = one account across all tenants), so
  // the conflict check must bypass the tenant filter.
  const exists = await User.findOne({ email: req.body.email }).setOptions({ skipTenant: true });
  if (exists) throw ApiError.conflict('Email already registered');
  // organization comes from the tenant context (never from the request body),
  // and the platform 'owner' role can only be created via bootstrap:owner.
  const { organization, ...body } = req.body;
  if (body.role === 'owner') throw ApiError.forbidden('Invalid role');
  const user = await User.create({
    ...body,
    permissionOverrides: sanitizeOverrides(body.permissionOverrides),
  });
  return created(res, user);
});

// PUT /api/users/:id  — password only updated if provided
export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  const { name, phone, role, team, avatarUrl, password, permissionOverrides } = req.body;
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (role !== undefined) {
    if (role === 'owner') throw ApiError.forbidden('Invalid role');
    user.role = role;
  }
  if (team !== undefined) user.team = team || undefined;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  if (password) user.password = password; // re-hashed by pre-save hook
  if (permissionOverrides !== undefined) {
    user.permissionOverrides = sanitizeOverrides(permissionOverrides);
    user.markModified('permissionOverrides');
  }

  await user.save();
  user.password = undefined;
  return ok(res, user);
});

// PATCH /api/users/:id/status  — activate / deactivate
export const setUserStatus = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isActive: !!req.body.isActive },
    { new: true }
  );
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

// DELETE /api/users/:id  (admin)
// Users are referenced by the trips/bookings they own, so a hard delete would
// leave those records pointing at nothing. We only allow it for accounts that
// own no work; anything else should be deactivated instead.
export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  if (String(user._id) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot delete your own account');
  }
  if (user.role === 'owner') throw ApiError.forbidden('The platform owner cannot be deleted');

  // Never leave the organization without an active admin.
  if (user.role === 'admin') {
    const admins = await User.countDocuments({ role: 'admin', isActive: { $ne: false } });
    if (admins <= 1) throw ApiError.badRequest('This is the only active admin — promote another admin first');
  }

  const [trips, bookings] = await Promise.all([
    Query.countDocuments({ owner: user._id }),
    Booking.countDocuments({ owner: user._id }),
  ]);
  if (trips || bookings) {
    throw ApiError.badRequest(
      `This user still owns ${trips} trip(s) and ${bookings} booking(s). `
      + 'Reassign them first, or deactivate the user instead of deleting.'
    );
  }

  await User.findByIdAndDelete(user._id);
  return ok(res, { id: req.params.id, deleted: true });
});
