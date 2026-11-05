import mongoose from 'mongoose';
import { MODULE_KEYS } from '../config/modules.js';

// Tenant company. Every tenant-owned document carries an `organization` ref
// (added by tenantPlugin); users belong to exactly one organization except the
// platform owner. Subscription is managed manually by the owner — expiresAt
// null means "never expires" (e.g. the migrated default org until a plan is
// assigned).

// How long before expiry the client starts seeing renewal reminders.
export const RENEWAL_REMINDER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, trim: true, lowercase: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    subscription: {
      plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
      planName: { type: String, trim: true },
      expiresAt: { type: Date, default: null },
      // What this company may actually use. Seeded from the plan when a payment
      // is recorded (so later edits to the plan never silently change what a
      // paying client already has) and editable per company from the owner
      // panel. Absent = never configured = everything; a stored list is exact,
      // including empty. See config/modules.js.
      modules: { type: [{ type: String, enum: MODULE_KEYS }], default: undefined },
    },
  },
  { timestamps: true }
);

organizationSchema.pre('save', function slugify(next) {
  if (!this.slug && this.name) {
    this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  next();
});

// Whole days until expiry; negative once lapsed, null when it never expires.
organizationSchema.methods.daysUntilExpiry = function daysUntilExpiry() {
  const exp = this.subscription?.expiresAt;
  if (!exp) return null;
  return Math.ceil((exp.getTime() - Date.now()) / DAY_MS);
};

// Subscription state helper: 'active' | 'expiring' (inside the reminder
// window) | 'expired'.
organizationSchema.methods.subscriptionStatus = function subscriptionStatus() {
  const exp = this.subscription?.expiresAt;
  if (!exp) return 'active';
  const now = Date.now();
  if (exp.getTime() < now) return 'expired';
  if (exp.getTime() - now <= RENEWAL_REMINDER_DAYS * DAY_MS) return 'expiring';
  return 'active';
};

export const Organization = mongoose.model('Organization', organizationSchema);
