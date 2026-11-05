import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// A ledger account in the double-entry accounting system.
// kind groups accounts the way the Accounts page tabs do.
const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // company: company-wide / restricted; employee: staff salary etc.;
    // third_party: vendors/expenses; guest: per-trip guest account; gateway/bank: settlement accounts.
    kind: {
      type: String,
      enum: ['company', 'employee', 'third_party', 'guest', 'gateway', 'bank'],
      default: 'company',
      index: true,
    },
    tags: [{ type: String, trim: true }],
    phone: { type: String, trim: true },
    // Optional links to the entity this account represents.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    tripId: { type: Number },
    openingBalance: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

accountSchema.index({ name: 'text' });
accountSchema.set('toJSON', { virtuals: true });
accountSchema.set('toObject', { virtuals: true });

accountSchema.plugin(tenantPlugin);

export const Account = mongoose.model('Account', accountSchema);
