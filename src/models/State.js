import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const stateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    country: { type: String, trim: true, default: 'India' },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

stateSchema.plugin(tenantPlugin);
stateSchema.index({ organization: 1, name: 1 }, { unique: true });
stateSchema.index({ name: 'text' });
stateSchema.set('toJSON', { virtuals: true });

export const State = mongoose.model('State', stateSchema);
