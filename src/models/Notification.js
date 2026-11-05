import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const notificationSchema = new mongoose.Schema(
  {
    recipient:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['booking_created', 'payment_received', 'comment_added', 'query_assigned', 'instalment_due', 'booking_status', 'quote_accepted'],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    body:  { type: String, trim: true },
    link:  { type: String, trim: true }, // frontend route e.g. /trips/:id
    read:  { type: Boolean, default: false, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Compound index for fast per-user unread queries.
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

notificationSchema.plugin(tenantPlugin);

export const Notification = mongoose.model('Notification', notificationSchema);
