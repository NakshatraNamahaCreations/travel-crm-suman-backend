import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { decodePermissionKey } from '../config/permissions.js';

// Tenant staff roles. The platform 'owner' role is deliberately NOT in this
// list so tenant-facing role dropdowns/validators never offer it.
export const ROLES = ['admin', 'manager', 'sales', 'operations', 'accounts'];
export const PLATFORM_ROLES = ['owner'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true, // global — one email = one account = one org (or owner)
      lowercase: true,
      trim: true,
    },
    phone: { type: String, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: [...ROLES, ...PLATFORM_ROLES], default: 'sales', index: true },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', index: true },
    // Per-user permission overrides: { 'payments.cancel': false, 'trips.create': true }.
    // Unset keys fall back to the role default. See config/permissions.js.
    permissionOverrides: { type: Map, of: Boolean, default: undefined },
    avatarUrl: { type: String },
    isActive: { type: Boolean, default: true, select: false },
    lastLoginAt: { type: Date },

    // Lead routing availability. Separate from `isActive`, which is account access: somebody
    // on leave still logs in to finish their paperwork, they just must not be handed a new
    // enquiry that then goes uncalled for a week.
    leads: {
      // Opt out of automatic assignment without going on leave (a manager who only takes
      // escalations, an agent on a training day).
      accepts: { type: Boolean, default: true },
      // Most open leads this person should hold at once. 0 means no limit.
      capacity: { type: Number, default: 25, min: 0 },
      // Set to a date to mark leave. Cleared automatically by being in the past, so nobody has
      // to remember to switch the person back on the morning they return.
      awayUntil: { type: Date },
      awayReason: { type: String, trim: true },
      // Works the after-hours shift. Held back from the day rotation and is the only pool
      // considered once the office has closed.
      nightShift: { type: Boolean, default: false },
    },
    // Password reset: only the sha256 of the emailed token is stored, so a DB
    // leak can't be replayed as a reset link. Single-use + 1h expiry.
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

// Adds the `organization` field + tenant scoping. Registered BEFORE the other
// hooks so the org stamp runs first in the pre-save chain.
userSchema.plugin(tenantPlugin);
// Every user except the platform owner must belong to an organization.
userSchema.path('organization').required(function orgRequired() {
  return this.role !== 'owner';
}, 'organization is required for tenant users');

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Strip sensitive fields from JSON output
userSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.password;
    delete ret.__v;
    // Hand back the dotted keys the API and UI speak.
    if (ret.permissionOverrides) {
      const src = ret.permissionOverrides instanceof Map
        ? Object.fromEntries(ret.permissionOverrides)
        : ret.permissionOverrides;
      ret.permissionOverrides = Object.fromEntries(
        Object.entries(src).map(([k, v]) => [decodePermissionKey(k), v])
      );
    }
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
