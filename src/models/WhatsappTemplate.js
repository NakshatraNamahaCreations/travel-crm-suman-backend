import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { TEMPLATE_STAGE_KEYS, TEMPLATE_DOC_KINDS } from '../config/whatsappTemplates.js';

// A tenant's own WhatsApp message template.
//
// `name` is the template as it is approved in the Gallabox dashboard — the
// send fails unless it matches exactly, so it is kept separate from `label`
// (what agents see in the picker) and from `key` (a stable handle the UI uses
// to preselect a template for the stage a button lives on).
//
// `body` is the message copy with {{placeholders}}. Every placeholder should
// have a row in `variables` naming the value source that fills it; a
// placeholder with no row, or one whose source is 'manual', is left for the
// agent to type in before sending.

const variableSchema = new mongoose.Schema(
  {
    // The {{placeholder}} name, without the braces.
    name: { type: String, required: true, trim: true },
    // Key of a value source resolved from the trip context (see the client's
    // templateSources.js). 'manual' means the agent types it every time.
    source: { type: String, trim: true, default: 'manual' },
    // Used when the source resolves to nothing.
    fallback: { type: String, trim: true },
  },
  { _id: false }
);

const whatsappTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    // Gallabox's approved template name.
    name: { type: String, required: true, trim: true },
    stage: { type: String, enum: TEMPLATE_STAGE_KEYS, default: 'other', index: true },
    body: { type: String, required: true },
    variables: [variableSchema],

    // Templates that reference a customer-facing document mint a public,
    // tokenised link for it when the agent opens the send modal. `as` is the
    // placeholder that link fills.
    needs: {
      kind: { type: String, enum: [...TEMPLATE_DOC_KINDS, null], default: null },
      as: { type: String, trim: true },
    },

    description: { type: String, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    // Seeded from the starter catalog. Editable and deletable like any other —
    // the flag only drives the "Default" chip and the re-seed skip.
    isSystem: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Placeholders actually present in the body, in order of first appearance.
whatsappTemplateSchema.virtual('placeholders').get(function () {
  const seen = [];
  for (const m of String(this.body || '').matchAll(/\{\{(\w+)\}\}/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
});

whatsappTemplateSchema.plugin(tenantPlugin);
whatsappTemplateSchema.index({ organization: 1, key: 1 }, { unique: true });

whatsappTemplateSchema.set('toJSON', { virtuals: true });
whatsappTemplateSchema.set('toObject', { virtuals: true });

export const WhatsappTemplate = mongoose.model('WhatsappTemplate', whatsappTemplateSchema);
