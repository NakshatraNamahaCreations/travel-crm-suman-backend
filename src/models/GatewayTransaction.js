import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// A row under a payment gateway — either a customer transaction or a settlement.
const gatewayTransactionSchema = new mongoose.Schema(
  {
    gateway: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentGateway', index: true },
    type: { type: String, enum: ['transaction', 'settlement'], default: 'transaction', index: true },
    txnId: { type: String, trim: true, index: true },
    tripId: { type: Number },
    guestName: { type: String, trim: true },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    // transaction statuses: successful / failure / cancelled ; settlement: settled
    status: { type: String, enum: ['successful', 'failure', 'cancelled', 'settled'], default: 'successful', index: true },
    fee: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    reference: { type: String, trim: true }, // UTR / settlement reference
    narration: { type: String, trim: true },
    date: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

gatewayTransactionSchema.set('toJSON', { virtuals: true });

gatewayTransactionSchema.plugin(tenantPlugin);

export const GatewayTransaction = mongoose.model('GatewayTransaction', gatewayTransactionSchema);
