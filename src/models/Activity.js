import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// Lightweight audit trail of notable actions on a query/trip (stage changes, quotes, etc.).
const activitySchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', index: true },
    // Generic entity audit (e.g. transport services). entityType + entity together
    // identify a non-query record this activity belongs to.
    entityType: { type: String, trim: true, index: true },
    entity: { type: mongoose.Schema.Types.ObjectId, index: true },
    type: { type: String, trim: true }, // 'created' | 'updated' | 'deleted' | 'stage' | 'quote' | 'note'
    message: { type: String, required: true, trim: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

activitySchema.set('toJSON', { virtuals: true });

activitySchema.plugin(tenantPlugin);

export const Activity = mongoose.model('Activity', activitySchema);
