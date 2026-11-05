import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

teamSchema.plugin(tenantPlugin);
teamSchema.index({ organization: 1, name: 1 }, { unique: true });
teamSchema.set('toJSON', { virtuals: true });

export const Team = mongoose.model('Team', teamSchema);
