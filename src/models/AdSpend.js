import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { LEAD_CHANNEL_KEYS } from '../config/leadChannels.js';

// What was spent on a channel in a given month.
//
// Entered by hand, one row per channel per month. Volume on its own is a misleading number:
// fifty Meta leads converting at 2% are worth less than ten Google leads converting at 30%,
// and a Lead Sources page without cost will tell you to put money into the wrong one. A dozen
// numbers typed once a month buys cost-per-lead and return on ad spend, which is the question
// the page exists to answer.
//
// Pulling spend from the Meta and Google APIs instead would remove the typing, at the price of
// OAuth, token refresh and per-account mapping; the manual row is deliberately the first step.
const adSpendSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: LEAD_CHANNEL_KEYS, required: true },
    // First day of the month the spend belongs to, normalized on write so the same month
    // cannot be stored twice under different days.
    month: { type: Date, required: true },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR', trim: true },
    notes: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

adSpendSchema.plugin(tenantPlugin);
adSpendSchema.index({ organization: 1, channel: 1, month: 1 }, { unique: true });
adSpendSchema.set('toJSON', { virtuals: true });

/** First instant of the month a date falls in, in server-local time. */
export const monthStart = (d) => {
  const x = new Date(d || Date.now());
  return new Date(x.getFullYear(), x.getMonth(), 1, 0, 0, 0, 0);
};

export const AdSpend = mongoose.model('AdSpend', adSpendSchema);
