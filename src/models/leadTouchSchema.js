import mongoose from 'mongoose';
import { LEAD_CHANNEL_KEYS } from '../config/leadChannels.js';

// One visit by one person: what the link carried and where they landed.
//
// Shared by Visitor (where touches accumulate while the person is still anonymous) and Query
// (where the journey is copied once they enquire). Not a model of its own — a touch has no
// meaning apart from the visitor or lead it belongs to, and a third collection would mean a
// join on every report.
//
// Copied rather than referenced on purpose: visitor records expire after the retention window,
// and a lead whose journey emptied itself six months later would be a report that silently
// changes its own history.
export const leadTouchSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    channel: { type: String, enum: LEAD_CHANNEL_KEYS },
    // Why the classifier chose that channel — shown in the lead drawer so an agent can see
    // the evidence rather than trusting a label.
    because: { type: String, trim: true },

    // Campaign tags, cleaned (lowercased, hyphenated) when the cleanup rule is on.
    source: { type: String, trim: true },
    medium: { type: String, trim: true },
    campaign: { type: String, trim: true },
    content: { type: String, trim: true },
    term: { type: String, trim: true },
    campaignId: { type: String, trim: true },

    // Click ids, stored verbatim — case matters when they are reported back to the platform
    // for offline conversion upload, which is the whole reason for keeping them.
    clickIds: {
      google: { type: String, trim: true },
      meta: { type: String, trim: true },
      whatsapp: { type: String, trim: true },
      bing: { type: String, trim: true },
      linkedin: { type: String, trim: true },
    },

    landingPage: { type: String, trim: true },
    referrer: { type: String, trim: true },
    // Which tracking link produced this visit, when the visit arrived through a /r/<code>
    // redirect this CRM issued.
    trackingLink: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingLink' },
    // Tenant-defined extras (partner code, blog button id…), keyed by the parameter name.
    custom: { type: Map, of: String },
  },
  { _id: false }
);
