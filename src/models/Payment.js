import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// Customer collections (money in) and supplier payments (money out).
const paymentSchema = new mongoose.Schema(
  {
    paymentNumber: { type: Number, index: true }, // unique per-org (compound index below)
    party: { type: String, enum: ['customer', 'supplier'], required: true, index: true },

    // Customer payments link to a booking; supplier payments name a supplier.
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query' },
    supplier: {
      kind: { type: String, enum: ['hotel', 'transport', 'activity', 'other'], default: 'other' },
      refId: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String, trim: true },
    },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    mode: { type: String, trim: true, default: 'Cash' }, // free-form so payment methods are user-extensible
    reference: { type: String, trim: true },
    date: { type: Date, default: Date.now },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Tenant scoping — registered BEFORE assignNumber so this.organization is
// stamped when the counter key is built.
paymentSchema.plugin(tenantPlugin);
paymentSchema.index({ organization: 1, paymentNumber: 1 }, { unique: true });

paymentSchema.pre('save', async function assignNumber(next) {
  if (this.isNew && !this.paymentNumber) {
    this.paymentNumber = await Counter.nextFor(this.organization, 'payment', 8100000);
  }
  next();
});

paymentSchema.set('toJSON', { virtuals: true });

export const Payment = mongoose.model('Payment', paymentSchema);
