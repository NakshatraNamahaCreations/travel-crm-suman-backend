import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { defaultCaptureParams } from '../config/captureParams.js';

// One settings document per organization, holding both halves of the module: what the website
// records about a visit, and how a new lead is routed to a person.
//
// Kept together rather than split into two collections because the Setup page reports on both
// at once and every tenant has exactly one of each — two singletons would mean two upserts and
// two round trips to answer one screen.

const captureParamSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    // Where the value lands inside Query.attribution. Editable so a tenant can re-point a
    // parameter without a code change; validated against the catalog on write.
    field: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    // Set on rows the tenant added themselves (partner codes, blog button ids).
    label: { type: String, trim: true },
    custom: { type: Boolean, default: false },
  },
  { _id: false }
);

const leadSettingsSchema = new mongoose.Schema(
  {
    // The credential in the public ingest URL. The website posts visits and form submissions
    // to /api/public/track/<token>, so this token identifies the tenant with no login — which
    // is why it is long, and why rotating it is offered on the Setup page.
    ingestToken: { type: String, index: true },

    capture: {
      enabled: { type: Boolean, default: true },
      // The tenant's own hostnames. A referrer among these is navigation inside the site, not
      // a referral — without this every internal page-to-page hop invents a new "referral".
      siteHosts: [{ type: String, trim: true, lowercase: true }],
      params: { type: [captureParamSchema], default: defaultCaptureParams },
      touchMode: { type: String, enum: ['both', 'first', 'last'], default: 'both' },
      retentionDays: { type: Number, default: 90, min: 1, max: 730 },
      // Stops a later untracked visit overwriting the ad that actually brought the person.
      // Someone clicks an ad, then types the URL direct two days later: without this the ad
      // loses the credit it earned.
      protectAdTouch: { type: Boolean, default: true },
      cleanValues: { type: Boolean, default: true },
      ignoreIps: [{ type: String, trim: true }],
      trackSubdomains: { type: Boolean, default: true },
      // Only relevant to tenants serving EU/UK visitors; off by default because a consent gate
      // that nobody needs simply loses data.
      requireConsent: { type: Boolean, default: false },
      // Query parameter marking a blog call-to-action, e.g. ?ref=blog-cta-inline
      blogParam: { type: String, default: 'ref', trim: true },
    },

    assignment: {
      autoAssign: { type: Boolean, default: false },
      defaultMethod: { type: String, enum: ['round_robin', 'least_busy', 'direct', 'top_closer'], default: 'least_busy' },
      hours: {
        start: { type: String, default: '09:00' },
        end: { type: String, default: '20:00' },
      },
      afterHours: {
        mode: { type: String, enum: ['night_shift', 'hold', 'assign_now'], default: 'hold' },
      },
      sla: {
        firstCallMinutes: { type: Number, default: 15, min: 1 },
        reassignMinutes: { type: Number, default: 15, min: 0 }, // 0 = never reassign
        managerMinutes: { type: Number, default: 30, min: 0 }, // 0 = never escalate
        notifyApp: { type: Boolean, default: true },
        notifyWhatsapp: { type: Boolean, default: false },
      },
      fairness: {
        repeatToSameRep: { type: Boolean, default: true },
        mergeDuplicateDays: { type: Number, default: 30, min: 0 }, // 0 = never merge
        allowManualOverride: { type: Boolean, default: true },
        explainSkips: { type: Boolean, default: true },
      },
      // Acknowledgement sent to the guest the moment the lead is assigned. Reuses the existing
      // WhatsApp template catalog rather than inventing a second message store.
      ackTemplateKey: { type: String, default: 'enquiry_received', trim: true },
      ackEnabled: { type: Boolean, default: false },
      // Round-robin position per rule. Persisted so turns survive a restart; a cursor that
      // reset on every deploy would quietly hand the same person every lead.
      cursors: { type: Map, of: Number, default: undefined },
    },

    // Prefix on generated campaign names: irs-meta-diwali-maldives-mdu-202611
    campaignPrefix: { type: String, default: 'crm', trim: true },
  },
  { timestamps: true }
);

leadSettingsSchema.plugin(tenantPlugin);
leadSettingsSchema.set('toJSON', { virtuals: true });

const newIngestToken = () => crypto.randomBytes(24).toString('hex');

/**
 * The calling organization's settings, created on first read.
 *
 * Atomic upsert rather than find-then-create: two requests arriving together (the Setup page
 * loads several panels at once) would otherwise both find nothing and both insert. There is no
 * unique index to lean on here — tenantPlugin already indexes `organization`, and adding a
 * unique one would restate the plugin's own key.
 */
leadSettingsSchema.statics.getFor = async function getFor() {
  return this.findOneAndUpdate(
    {},
    { $setOnInsert: { ingestToken: newIngestToken() } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

/** Replaces the ingest token, revoking every URL already pasted into a website. */
leadSettingsSchema.statics.rotateToken = async function rotateToken() {
  return this.findOneAndUpdate({}, { ingestToken: newIngestToken() }, { new: true, upsert: true, setDefaultsOnInsert: true });
};

export const LeadSettings = mongoose.model('LeadSettings', leadSettingsSchema);
export { newIngestToken };
