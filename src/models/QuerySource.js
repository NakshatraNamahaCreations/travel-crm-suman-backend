import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// Where a lead came from: Website, B2B, WhatsApp, Referral, Walk-in, etc.
const querySourceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

querySourceSchema.plugin(tenantPlugin);
querySourceSchema.index({ organization: 1, name: 1 }, { unique: true });
querySourceSchema.set('toJSON', { virtuals: true });

export const QuerySource = mongoose.model('QuerySource', querySourceSchema);
