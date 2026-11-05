import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// A configured payment-gateway provider (e.g. PayU). No live credentials are stored here —
// this is the UI/model layer; settlement & transaction rows live in GatewayTransaction.
const paymentGatewaySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // display name, e.g. "PayU"
    provider: { type: String, trim: true, default: 'payu' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

paymentGatewaySchema.set('toJSON', { virtuals: true });

paymentGatewaySchema.plugin(tenantPlugin);

export const PaymentGateway = mongoose.model('PaymentGateway', paymentGatewaySchema);
