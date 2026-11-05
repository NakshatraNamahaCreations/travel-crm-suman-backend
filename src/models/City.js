import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const citySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    state: { type: mongoose.Schema.Types.ObjectId, ref: 'State', index: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

citySchema.plugin(tenantPlugin);
citySchema.index({ organization: 1, name: 1 }, { unique: true });
citySchema.index({ name: 'text' });
citySchema.set('toJSON', { virtuals: true });

export const City = mongoose.model('City', citySchema);
