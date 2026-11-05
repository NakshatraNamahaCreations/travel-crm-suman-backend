import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// One organization's own WhatsApp number, linked through the OpenWA gateway.
//
// Each tenant links its own phone by scanning its own QR, so a guest hears from the company
// they enquired with rather than from whichever number the platform happens to hold. The
// gateway owns the session (and its credentials); this row only remembers which session
// belongs to this organization, plus the last state we saw, so a page can render something
// before the gateway answers.
//
// `status` mirrors OpenWA's own session states (created / qr_ready / authenticating / ready /
// stopped / failed). It is a cache, never the authority: a read refreshes it from the gateway,
// because a session can be unlinked from the phone without telling us.

const whatsappConnectionSchema = new mongoose.Schema(
  {
    // OpenWA's session id. Null between the row being created and the gateway accepting it.
    sessionId: { type: String, trim: true, default: null, index: true },
    // The name the session carries in OpenWA. Unique per gateway, so it is derived from the
    // organization id rather than its display name, which two tenants could share.
    sessionName: { type: String, trim: true },
    status: { type: String, trim: true, default: 'none' },
    // The linked handset, as the gateway reports it once the scan completes.
    phone: { type: String, trim: true, default: null },
    pushName: { type: String, trim: true, default: null },
    connectedAt: { type: Date, default: null },
    // Last failure from the gateway, kept so an admin sees why a connection dropped.
    lastError: { type: String, trim: true, default: null },
    lastCheckedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Adds the `organization` field, already indexed. No unique index is declared on it: that would
// restate the key the plugin already indexes, and one row per organization is held by the
// controller's atomic upsert instead — the same way OrgProfile keeps its single row.
whatsappConnectionSchema.plugin(tenantPlugin);

export const WhatsappConnection = mongoose.model('WhatsappConnection', whatsappConnectionSchema);
