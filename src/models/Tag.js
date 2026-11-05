import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const tagSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, lowercase: true },
    color: { type: String, default: '#64748b' },
  },
  { timestamps: true }
);

tagSchema.plugin(tenantPlugin);
tagSchema.index({ organization: 1, name: 1 }, { unique: true });
tagSchema.set('toJSON', { virtuals: true });

export const Tag = mongoose.model('Tag', tagSchema);
