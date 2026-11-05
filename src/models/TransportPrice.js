import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// Date-ranged rate for a transport service (optionally a specific item) and config.
const transportPriceSchema = new mongoose.Schema(
  {
    service: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TransportService',
      required: true,
      index: true,
    },
    itemName: { type: String, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    config: { type: String, trim: true }, // e.g. vehicle type / pax slab
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

transportPriceSchema.set('toJSON', { virtuals: true });

transportPriceSchema.plugin(tenantPlugin);

export const TransportPrice = mongoose.model('TransportPrice', transportPriceSchema);
