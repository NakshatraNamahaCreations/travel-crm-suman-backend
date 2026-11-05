import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { LEAD_CHANNEL_KEYS } from '../config/leadChannels.js';

// One routing rule. Checked in `order`, and the first rule that matches decides the lead —
// so order is meaningful data, not presentation, and the UI lets managers drag it.
//
// The evaluation itself lives in utils/assignmentEngine.js, not here: it has to run against
// unsaved input for the "Try it" simulator, so it cannot depend on documents.

const conditionSchema = new mongoose.Schema(
  {
    field: { type: String, required: true, trim: true }, // see CONDITION_FIELDS
    op: { type: String, required: true, trim: true }, // see CONDITION_OPS
    // Scalar for eq/gt/contains, array for `in`. Mixed because the field it compares against
    // may be an id, a number or free text.
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const assignmentRuleSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    order: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true },

    match: { type: String, enum: ['all', 'any'], default: 'all' },
    conditions: { type: [conditionSchema], default: [] },

    targetType: { type: String, enum: ['user', 'team', 'any'], default: 'any' },
    targetUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    targetTeam: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },

    method: { type: String, enum: ['round_robin', 'least_busy', 'direct', 'top_closer'], default: 'least_busy' },
    // Overrides the global first-call SLA for leads this rule catches — a paid-ad lead going
    // cold costs money the organic one did not.
    slaMinutes: { type: Number, min: 1 },

    // The catch-all. Exactly one rule should carry it, it sorts last, and the API refuses to
    // deactivate or delete it: without a final rule a lead that matches nothing is simply lost.
    isFallback: { type: Boolean, default: false },

    // Rolling count, bumped by the assignment hook. Shown as "N leads today" on each rule so a
    // rule that never fires is visible as dead weight.
    hitsToday: { type: Number, default: 0 },
    hitsOn: { type: Date },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

assignmentRuleSchema.plugin(tenantPlugin);
assignmentRuleSchema.index({ organization: 1, order: 1 });
assignmentRuleSchema.set('toJSON', { virtuals: true });

export const AssignmentRule = mongoose.model('AssignmentRule', assignmentRuleSchema);
