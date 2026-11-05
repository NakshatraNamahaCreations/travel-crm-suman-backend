import mongoose from 'mongoose';
import { MODULE_KEYS } from '../config/modules.js';

// Manual subscription payment history, recorded by the platform owner when a
// tenant pays offline (bank/UPI). Platform-level data — NOT tenant-scoped.
const subscriptionPaymentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    planName: { type: String, trim: true },
    amount: { type: Number, default: 0 },
    months: { type: Number, default: 1, min: 1 },
    // Modules sold in this transaction — a record of what the client paid for.
    modules: { type: [{ type: String, enum: MODULE_KEYS }], default: undefined },
    paidOn: { type: Date, default: Date.now },
    notes: { type: String, trim: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const SubscriptionPayment = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);
