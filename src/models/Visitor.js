import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { leadTouchSchema } from './leadTouchSchema.js';

// An anonymous website visitor, keyed by the id the tracking script keeps in their browser.
//
// This is where the touches pile up BEFORE the person enquires — the whole point of the
// module. Somebody sees an Instagram reel in October, reads a blog post a week later and only
// fills the form in November: without this record the lead would arrive looking like it came
// from nowhere, and the reel that actually started it would get no credit.
//
// Deliberately NOT personal data: no name, phone or email. Once the person enquires the
// journey is copied onto their Query and `linkedQuery` is set, so this row becomes a
// disposable cache that the retention window is free to delete.
const visitorSchema = new mongoose.Schema(
  {
    visitorId: { type: String, required: true, trim: true },
    touches: { type: [leadTouchSchema], default: [] },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    // No schema default on purpose. The ingest upserts with `$inc`, and a default would be
    // folded into `$setOnInsert` by setDefaultsOnInsert — Mongo rejects a field that appears
    // in both, so the very first visit from every new browser would fail.
    visitCount: { type: Number },

    device: { type: String, trim: true },
    city: { type: String, trim: true },
    gaClientId: { type: String, trim: true },

    // Set when the visitor turned into a lead. Kept (rather than deleting the row) so a second
    // enquiry from the same browser can be recognised as the same person.
    linkedQuery: { type: mongoose.Schema.Types.ObjectId, ref: 'Query' },

    // Rolling expiry, pushed forward on every visit to `lastSeenAt + retention days`. A
    // visitor who keeps coming back keeps their history; one who never returns is forgotten on
    // the schedule the tenant chose on the UTM Capture page.
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

visitorSchema.plugin(tenantPlugin);
// The browser id is only unique within one tenant: two companies' sites each set their own
// cookie, and nothing stops the two values colliding.
visitorSchema.index({ organization: 1, visitorId: 1 }, { unique: true });
// Mongo's TTL monitor deletes on this field, so retention needs no sweep of our own.
visitorSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
visitorSchema.set('toJSON', { virtuals: true });

// The touch that gets credit for creating the interest, and the one that got them to enquire.
visitorSchema.virtual('firstTouch').get(function firstTouch() {
  return this.touches?.length ? this.touches[0] : null;
});
visitorSchema.virtual('lastTouch').get(function lastTouch() {
  return this.touches?.length ? this.touches[this.touches.length - 1] : null;
});

export const Visitor = mongoose.model('Visitor', visitorSchema);
