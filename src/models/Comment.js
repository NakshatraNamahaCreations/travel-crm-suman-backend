import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// Tasks & comments attached to a query/trip. An "actionable" comment is a task
// that shows in the demanding list until resolved.
const commentSchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required: true, index: true },
    body: { type: String, required: true, trim: true },
    isActionable: { type: Boolean, default: false, index: true },
    dueDate: { type: Date },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isResolved: { type: Boolean, default: false },
    resolvedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

commentSchema.set('toJSON', { virtuals: true });

commentSchema.plugin(tenantPlugin);

export const Comment = mongoose.model('Comment', commentSchema);
