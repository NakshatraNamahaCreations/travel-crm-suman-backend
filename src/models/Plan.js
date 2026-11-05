import mongoose from 'mongoose';
import { MODULE_KEYS } from '../config/modules.js';

// Owner-defined subscription plans (Basic / Pro ...). Platform-level data —
// NOT tenant-scoped. Billing is manual: the owner records offline payments
// against an organization and the plan drives the default duration, price and
// the set of modules the client gets.
const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    price: { type: Number, default: 0 },
    durationMonths: { type: Number, default: 1, min: 1 },
    description: { type: String, trim: true },
    // Modules this plan grants. Left unset the plan grants everything; once
    // set the list is exact, including empty. See config/modules.js.
    modules: { type: [{ type: String, enum: MODULE_KEYS }], default: undefined },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Plan = mongoose.model('Plan', planSchema);
