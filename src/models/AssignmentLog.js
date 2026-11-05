import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { LEAD_CHANNEL_KEYS } from '../config/leadChannels.js';

// Why each lead went where it went, and what happened next.
//
// This is an audit trail, not a cache: when a salesperson asks why they got a lead, or a
// manager asks why a lead sat uncalled for forty minutes, the answer has to still be there
// months later. The reasons are stored as finished sentences because the rule that produced
// them may since have been edited or deleted, and re-deriving the explanation from today's
// rules would produce a confident lie.
const assignmentLogSchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    channel: { type: String, enum: LEAD_CHANNEL_KEYS },

    rule: { type: mongoose.Schema.Types.ObjectId, ref: 'AssignmentRule' },
    ruleLabel: { type: String, trim: true }, // kept verbatim: the rule may be renamed or deleted
    method: { type: String, trim: true },
    reasons: [{ type: String, trim: true }],

    // Why nobody got it, when nobody did: auto_off, held_after_hours, no_night_shift,
    // nobody_available, no_rule. An empty value means the lead was assigned.
    unassignedReason: { type: String, trim: true, index: true },

    // Manual assignment by a manager, rather than the engine's decision.
    manual: { type: Boolean, default: false },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    slaMinutes: { type: Number },
    // When the assignee first did something about it (logged a call or a comment). The gap
    // between createdAt and this is the "first call" column.
    firstTouchAt: { type: Date },
    // Escalation trail: reassigned past an unresponsive rep, or raised to a manager.
    escalations: [
      new mongoose.Schema(
        {
          at: { type: Date, default: Date.now },
          kind: { type: String, enum: ['reassigned', 'manager_alerted'] },
          from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          to: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          note: { type: String, trim: true },
        },
        { _id: false }
      ),
    ],
    // Set once the SLA sweep has dealt with this row, so a lead is not escalated twice.
    slaSettledAt: { type: Date },
  },
  { timestamps: true }
);

assignmentLogSchema.plugin(tenantPlugin);
assignmentLogSchema.index({ organization: 1, createdAt: -1 });
// The sweep looks for rows still owing an escalation; this keeps that scan off a full
// collection walk once the log has years of history in it.
assignmentLogSchema.index({ organization: 1, slaSettledAt: 1, firstTouchAt: 1 });
assignmentLogSchema.set('toJSON', { virtuals: true });

export const AssignmentLog = mongoose.model('AssignmentLog', assignmentLogSchema);
