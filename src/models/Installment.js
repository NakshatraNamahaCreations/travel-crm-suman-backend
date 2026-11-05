import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { shareTokenField } from '../utils/shareToken.js';

// A scheduled payment due (instalment) — incoming (from customer) or outgoing (to supplier).
// Status is derived: paid+verified = paid, paid+!verified = unverified, else overdue/upcoming by due date.
const commentSchema = new mongoose.Schema(
  {
    body: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const installmentSchema = new mongoose.Schema(
  {
    installmentNumber: { type: Number, index: true }, // unique per-org (compound index below)
    direction: { type: String, enum: ['incoming', 'outgoing'], required: true, index: true },

    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query' },

    // Contact / trip snapshot (shown in the list + modal)
    tripId: { type: String, trim: true }, // query number as a string, e.g. "3901101"
    guest: {
      salutation: String,
      name: String,
      phones: [{ countryCode: String, number: String }],
    },
    destinations: [{ type: String, trim: true }],
    startDate: { type: Date },
    endDate: { type: Date },
    supplierName: { type: String, trim: true }, // for outgoing

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    dueDate: { type: Date },

    paid: { type: Boolean, default: false },
    verified: { type: Boolean, default: false },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    paidAmount: { type: Number, default: 0 },
    paidOn: { type: Date },
    reference: { type: String, trim: true },

    // Set when this payment was logged as a tax bill (GST-inclusive amount
    // entered directly) — paidAmount = taxableValue + taxAmount. Reused by
    // the GST Invoice form so the agent doesn't have to re-enter/back-compute it.
    taxableValue: { type: Number },
    gstPercent: { type: Number },
    taxAmount: { type: Number },
    debitAccount: { type: String, trim: true },
    creditAccount: { type: String, trim: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

    comments: [commentSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ...shareTokenField,
  },
  { timestamps: true }
);

installmentSchema.virtual('status').get(function () {
  if (this.paid && this.verified) return 'paid';
  if (this.paid && !this.verified) return 'unverified';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (this.dueDate && this.dueDate < today) return 'overdue';
  return 'upcoming';
});

installmentSchema.virtual('balance').get(function () {
  return Math.max(0, (this.amount || 0) - (this.paidAmount || 0));
});

// Tenant scoping — registered BEFORE assignNumber so this.organization is
// stamped when the counter key is built.
installmentSchema.plugin(tenantPlugin);
installmentSchema.index({ organization: 1, installmentNumber: 1 }, { unique: true });

installmentSchema.pre('save', async function assignNumber(next) {
  if (this.isNew && !this.installmentNumber) {
    this.installmentNumber = await Counter.nextFor(this.organization, 'installment', 3800000);
  }
  next();
});

installmentSchema.set('toJSON', { virtuals: true });
installmentSchema.set('toObject', { virtuals: true });

export const Installment = mongoose.model('Installment', installmentSchema);
