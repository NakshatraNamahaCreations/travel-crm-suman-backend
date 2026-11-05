import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const destinationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    country: { type: String, trim: true, default: 'India' },
    region: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

destinationSchema.plugin(tenantPlugin);
destinationSchema.index({ organization: 1, name: 1 }, { unique: true });
destinationSchema.index({ name: 'text' });
destinationSchema.set('toJSON', { virtuals: true });

export const Destination = mongoose.model('Destination', destinationSchema);
