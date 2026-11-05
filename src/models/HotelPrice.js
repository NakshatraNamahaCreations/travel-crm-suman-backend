import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// A date-ranged rate card row for a hotel/room-type/meal-plan combination.
const hotelPriceSchema = new mongoose.Schema(
  {
    hotel: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    mealPlan: { type: String, required: true, trim: true },
    roomType: { type: String, required: true, trim: true },
    basePrice: { type: Number, required: true, min: 0 },
    persons: { type: Number, default: 2 }, // base occupancy
    aweb: { type: Number, default: 0 }, // adult with extra bed
    cweb: { type: Number, default: 0 }, // child with extra bed
    cwoeb: { type: Number, default: 0 }, // child without extra bed
    currency: { type: String, default: 'INR' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

hotelPriceSchema.index({ hotel: 1, startDate: 1, endDate: 1 });
hotelPriceSchema.set('toJSON', { virtuals: true });

hotelPriceSchema.plugin(tenantPlugin);

export const HotelPrice = mongoose.model('HotelPrice', hotelPriceSchema);
