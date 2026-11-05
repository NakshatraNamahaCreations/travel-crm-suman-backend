import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// Date-ranged price for an activity ticket type and tourist config (Adult/Child).
const travelActivityPriceSchema = new mongoose.Schema(
  {
    activity: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TravelActivity',
      required: true,
      index: true,
    },
    service: { type: String, trim: true }, // ticket type name, e.g. "Nautika Ferry: Royal"
    config: { type: String, trim: true }, // "Adult" | "Child (2-12)"
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

travelActivityPriceSchema.set('toJSON', { virtuals: true });

travelActivityPriceSchema.plugin(tenantPlugin);

export const TravelActivityPrice = mongoose.model(
  'TravelActivityPrice',
  travelActivityPriceSchema
);
