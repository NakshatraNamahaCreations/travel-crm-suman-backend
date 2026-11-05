import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// Generic, user-extensible option lists for categorical dropdowns
// (mealPlan, salutation, currency, paymentMode, vehicleType, …).
const optionSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true, index: true },
    value: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    description: { type: String, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Cab / vehicle-type attributes (category 'vehicleType').
    destinations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],
    capacity: { type: Number },
    childAge: { type: Number },
  },
  { timestamps: true }
);

optionSchema.plugin(tenantPlugin);
optionSchema.index({ organization: 1, category: 1, value: 1 }, { unique: true });
optionSchema.set('toJSON', { virtuals: true });

export const Option = mongoose.model('Option', optionSchema);
