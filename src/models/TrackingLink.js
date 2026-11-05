import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { LEAD_CHANNEL_KEYS } from '../config/leadChannels.js';

// A campaign link the CRM issued, and what it brought back.
//
// Saving the link (rather than only generating a string to paste) is what makes "which flyer
// drop worked" answerable: the short code is counted on redirect, and leads that arrive
// carrying the same utm_campaign are attributed to this row. A link nobody saved can still be
// measured by campaign name, but it cannot report clicks, because nothing of ours was in the
// path.
const trackingLinkSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true }, // "Diwali reel (Instagram)"
    destination: { type: String, required: true, trim: true }, // LINK_DESTINATIONS key
    channel: { type: String, enum: LEAD_CHANNEL_KEYS, required: true },

    targetUrl: { type: String, required: true, trim: true },
    campaign: { type: String, required: true, trim: true, index: true }, // the generated utm_campaign
    source: { type: String, trim: true },
    medium: { type: String, trim: true },
    content: { type: String, trim: true },
    term: { type: String, trim: true },
    // The finished link, stored so the list can offer Copy without rebuilding it — and so a
    // link already printed on a flyer keeps working unchanged after the builder's conventions
    // are revised.
    url: { type: String, trim: true },

    // Short code behind /r/<code>, for QR codes and WhatsApp messages where a long URL with
    // five utm tags is unusable. Indexed below, unique across the platform.
    code: { type: String, trim: true },

    clicks: { type: Number, default: 0 },
    lastClickAt: { type: Date },

    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

trackingLinkSchema.plugin(tenantPlugin);
// The short code is resolved by a PUBLIC route with no tenant context, so it has to be unique
// across the whole platform, not just within one organization. Sparse: rows created before a
// code was minted, and links a tenant chose not to shorten, must not collide on null.
trackingLinkSchema.index({ code: 1 }, { unique: true, sparse: true });
trackingLinkSchema.index({ organization: 1, createdAt: -1 });
trackingLinkSchema.set('toJSON', { virtuals: true });

export const TrackingLink = mongoose.model('TrackingLink', trackingLinkSchema);
