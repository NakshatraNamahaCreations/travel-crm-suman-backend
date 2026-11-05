import mongoose from 'mongoose';
import { Query } from '../models/Query.js';
import { User } from '../models/User.js';
import { Team } from '../models/Team.js';
import { Tag } from '../models/Tag.js';
import { Destination } from '../models/Destination.js';
import { QuerySource } from '../models/QuerySource.js';
import { LeadSettings } from '../models/LeadSettings.js';
import { AssignmentRule } from '../models/AssignmentRule.js';
import { AssignmentLog } from '../models/AssignmentLog.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { createNotification } from './notification.controller.js';
import { logActivity } from './activity.controller.js';
import {
  decideAssignment, isAfterHours, describeCondition,
  CONDITION_FIELDS, CONDITION_OPS, ASSIGNMENT_METHODS, METHOD_KEYS,
} from '../utils/assignmentEngine.js';
import { LEAD_CHANNELS, channelMeta } from '../config/leadChannels.js';
import { ACTIVE_STATUSES } from '../constants/queryStatus.js';

const DAY = 86400000;
const WON = ['converted', 'on_trip', 'past'];
// Roles that work leads. An accountant holding an uncalled enquiry is the failure this list
// prevents; admins and managers are included because at small agencies they sell too.
const SALES_ROLES = ['admin', 'manager', 'sales'];

const str = (v) => (v === undefined || v === null ? '' : String(v));

/* ─────────────────────────── shared operations ───────────────────────────── */

/**
 * The team, with the live numbers the engine needs to choose between them.
 *
 * `openLeads` is counted rather than stored on the user: a denormalized counter drifts the
 * first time a query is deleted or reassigned outside this code path, and a drifted counter
 * silently starves whoever it over-counts.
 */
export async function loadReps() {
  const users = await User.find({ role: { $in: SALES_ROLES } })
    .select('name email role team leads')
    .lean();
  if (!users.length) return [];

  const ids = users.map((u) => u._id);
  const dayAgo = new Date(Date.now() - DAY);
  const [open, today, won, total] = await Promise.all([
    Query.aggregate([
      { $match: { owner: { $in: ids }, status: { $in: ACTIVE_STATUSES } } },
      { $group: { _id: '$owner', n: { $sum: 1 } } },
    ]),
    Query.aggregate([
      { $match: { owner: { $in: ids }, createdAt: { $gte: dayAgo } } },
      { $group: { _id: '$owner', n: { $sum: 1 } } },
    ]),
    Query.aggregate([
      { $match: { owner: { $in: ids }, status: { $in: WON } } },
      { $group: { _id: '$owner', n: { $sum: 1 } } },
    ]),
    Query.aggregate([{ $match: { owner: { $in: ids } } }, { $group: { _id: '$owner', n: { $sum: 1 } } }]),
  ]);
  const map = (rows) => new Map(rows.map((r) => [str(r._id), r.n]));
  const openBy = map(open);
  const todayBy = map(today);
  const wonBy = map(won);
  const totalBy = map(total);

  return users.map((u) => {
    const id = str(u._id);
    const t = totalBy.get(id) || 0;
    const l = u.leads || {};
    // An awayUntil in the past is simply over — nobody has to remember to switch the person
    // back on the morning they return.
    const away = l.awayUntil && new Date(l.awayUntil).getTime() > Date.now() ? l.awayUntil : null;
    return {
      _id: u._id,
      name: u.name,
      email: u.email,
      role: u.role,
      team: u.team || null,
      acceptsLeads: l.accepts !== false,
      capacity: l.capacity ?? 25,
      openLeads: openBy.get(id) || 0,
      today: todayBy.get(id) || 0,
      awayUntil: away,
      awayReason: away ? l.awayReason || null : null,
      nightShift: !!l.nightShift,
      conversionRate: t ? Math.round(((wonBy.get(id) || 0) / t) * 100) : 0,
    };
  });
}

/** Rules in evaluation order, with the fallback forced last whatever its stored order says. */
async function loadRules() {
  const rules = await AssignmentRule.find().sort('order').lean();
  return rules.sort((a, b) => (a.isFallback ? 1 : 0) - (b.isFallback ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0));
}

/** Display labels for the ids a rule compares against, so its reasons read as names. */
async function loadLabels() {
  const [sources, teams, dests, tags, users] = await Promise.all([
    QuerySource.find().select('name').lean(),
    Team.find().select('name').lean(),
    Destination.find().select('name').lean(),
    Tag.find().select('name').lean(),
    User.find({ role: { $in: SALES_ROLES } }).select('name').lean(),
  ]);
  const labels = {};
  for (const row of [...sources, ...teams, ...dests, ...tags, ...users]) labels[str(row._id)] = row.name;
  for (const c of LEAD_CHANNELS) labels[c.key] = c.label;
  return { labels, sources, teams, dests, tags, users };
}

/** The target group's name, for the rule sentence and the reasons. */
function targetLabel(rule, labels) {
  if (rule.targetType === 'user') {
    const names = (rule.targetUsers || []).map((u) => labels[str(u)] || 'someone').filter(Boolean);
    return names.length ? names.join(', ') : 'nobody';
  }
  if (rule.targetType === 'team') return labels[str(rule.targetTeam)] || 'a team';
  return 'all sales';
}

/** Normalizes a Query into the flat shape the engine compares against. */
export function leadFromQuery(query) {
  const a = query?.attribution || {};
  return {
    channel: a.channel || 'direct',
    campaign: a.last?.campaign || a.first?.campaign || '',
    source: str(query?.source?._id || query?.source),
    destinations: (query?.destinations || []).map((d) => str(d?._id || d)),
    tags: (query?.tags || []).map((t) => str(t?._id || t)),
    value: query?.quotedAmount || query?.bookedAmount || 0,
    nights: query?.nights || 0,
    pax: (query?.pax?.adults || 0) + (query?.pax?.children?.length || 0),
    location: query?.guest?.location || '',
    nationality: query?.guest?.nationality || '',
  };
}

/** The rep who handled this guest's previous enquiry, if there was one. Matched on phone,
 *  which is the only identifier a guest reliably repeats. */
async function previousOwnerFor(query, days) {
  if (!days) return null;
  const phone = query?.guest?.phones?.find((p) => p?.number)?.number;
  if (!phone) return null;
  const prior = await Query.findOne({
    _id: { $ne: query._id },
    'guest.phones.number': phone,
    createdAt: { $gte: new Date(Date.now() - days * DAY) },
    owner: { $ne: null },
  })
    .sort('-createdAt')
    .select('owner')
    .lean();
  return prior?.owner || null;
}

/**
 * Assigns a lead and records why. Shared by the public ingest, the create-query handler and
 * the manual reassign endpoint, so every route that can change a lead's owner writes the same
 * audit trail.
 *
 * Deliberately total: it never throws. An assignment problem must not fail the enquiry that
 * an agent just typed in or a guest just submitted — the lead is worth more than the routing,
 * so every failure comes back as a reason and the lead lands in the unassigned list.
 */
export async function assignLead(query, { actor = null, settings = null } = {}) {
  try {
    const cfg = settings || await LeadSettings.getFor();
    const asg = cfg.assignment || {};
    if (!asg.autoAssign) {
      return { assigned: false, reason: 'auto_off', reasons: ['Automatic assignment is switched off.'] };
    }

    const [reps, rules, { labels }] = await Promise.all([loadReps(), loadRules(), loadLabels()]);
    if (!reps.length) {
      return { assigned: false, reason: 'nobody_available', reasons: ['No sales users exist to assign leads to.'] };
    }

    const decorated = rules.map((r) => ({ ...r, targetLabel: targetLabel(r, labels) }));
    const cursors = cfg.assignment?.cursors instanceof Map
      ? Object.fromEntries(cfg.assignment.cursors)
      : { ...(cfg.assignment?.cursors || {}) };

    const previousOwner = asg.fairness?.repeatToSameRep
      ? await previousOwnerFor(query, asg.fairness?.mergeDuplicateDays ?? 30)
      : null;

    const result = decideAssignment({
      lead: leadFromQuery(query),
      rules: decorated,
      reps,
      settings: asg,
      now: new Date(),
      cursors,
      previousOwner,
      labels,
    });

    // Persist the round-robin position so turns survive a restart.
    if (result.assignee && JSON.stringify(result.cursors) !== JSON.stringify(cursors)) {
      cfg.assignment.cursors = result.cursors;
      cfg.markModified('assignment.cursors');
      await cfg.save().catch(() => {});
    }

    const log = {
      query: query._id,
      channel: query.attribution?.channel || 'direct',
      rule: result.rule?._id || null,
      ruleLabel: result.rule?.label || null,
      method: result.method || null,
      reasons: result.reasons,
      slaMinutes: result.slaMinutes || null,
      unassignedReason: result.unassignedReason || null,
      actor,
    };

    if (!result.assignee) {
      await AssignmentLog.create(log);
      // A lead nobody picked up is the one thing a manager must hear about immediately.
      await notifyManagers(query, result.unassignedReason).catch(() => {});
      return { assigned: false, reason: result.unassignedReason, reasons: result.reasons };
    }

    log.assignedTo = result.assignee._id;
    await Promise.all([
      Query.updateOne({ _id: query._id }, { owner: result.assignee._id }),
      AssignmentLog.create(log),
      bumpRuleHits(result.rule?._id),
      createNotification({
        recipient: result.assignee._id,
        type: 'lead_assigned',
        title: 'New lead: ' + (query.guest?.name || 'enquiry #' + query.queryNumber),
        body: result.reasons[result.reasons.length - 1] || 'Assigned to you.',
        link: '/trips/' + query._id,
        createdBy: actor,
      }).catch(() => {}),
      logActivity(query._id, actor, 'assigned to ' + result.assignee.name + ' automatically', 'note').catch(() => {}),
    ]);

    return {
      assigned: true,
      owner: result.assignee._id,
      ownerName: result.assignee.name,
      ruleLabel: result.rule?.label || null,
      method: result.method,
      slaMinutes: result.slaMinutes,
      reasons: result.reasons,
    };
  } catch (err) {
    return { assigned: false, reason: 'error', error: err.message, reasons: ['Assignment failed: ' + err.message] };
  }
}

/** "N leads today" on each rule. Reset lazily on the first hit of a new day rather than by a
 *  nightly job, so there is one less thing that can fail silently overnight. */
async function bumpRuleHits(ruleId) {
  if (!ruleId) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rule = await AssignmentRule.findById(ruleId).select('hitsToday hitsOn');
  if (!rule) return;
  const stale = !rule.hitsOn || new Date(rule.hitsOn) < today;
  rule.hitsToday = (stale ? 0 : rule.hitsToday || 0) + 1;
  rule.hitsOn = new Date();
  await rule.save().catch(() => {});
}

async function notifyManagers(query, reason) {
  const managers = await User.find({ role: { $in: ['admin', 'manager'] } }).select('_id').lean();
  const why = {
    auto_off: 'automatic assignment is off',
    held_after_hours: 'it arrived after hours',
    no_night_shift: 'nobody is on the night shift',
    nobody_available: 'nobody was available',
    no_rule: 'no rule matched it',
  }[reason] || 'it could not be routed';
  await Promise.all(managers.map((m) => createNotification({
    recipient: m._id,
    type: 'lead_unassigned',
    title: 'Lead #' + query.queryNumber + ' needs an owner',
    body: (query.guest?.name || 'An enquiry') + ' is unassigned because ' + why + '.',
    link: '/trips/' + query._id,
  }).catch(() => {})));
}

/* ──────────────────────────── SLA escalation ─────────────────────────────── */

let lastSweepAt = 0;

/**
 * Moves on leads nobody has touched inside the SLA, and tells a manager about the ones still
 * untouched after the longer window.
 *
 * Throttled and triggered by page views, following `rollTripStatuses` in query.controller.js
 * — the same trade the codebase already makes. A real scheduler would be more punctual, but
 * it would also be a second process to deploy and monitor, and a sweep that silently stops
 * running is worse than one that runs a few minutes late.
 */
export async function sweepSla({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSweepAt < 60 * 1000) return { skipped: true };
  lastSweepAt = now;

  const cfg = await LeadSettings.getFor();
  const sla = cfg.assignment?.sla || {};
  const reassignAfter = Number(sla.reassignMinutes) || 0;
  const managerAfter = Number(sla.managerMinutes) || 0;
  if (!reassignAfter && !managerAfter) return { reassigned: 0, escalated: 0 };

  const oldest = Math.min(...[reassignAfter, managerAfter].filter(Boolean));
  const pending = await AssignmentLog.find({
    slaSettledAt: null,
    firstTouchAt: null,
    assignedTo: { $ne: null },
    createdAt: { $lte: new Date(now - oldest * 60000) },
  })
    .sort('createdAt')
    .limit(100)
    .lean();
  if (!pending.length) return { reassigned: 0, escalated: 0 };

  // A lead counts as touched the moment its owner logs anything against it.
  const Comment = mongoose.model('Comment');
  const queryIds = pending.map((p) => p.query);
  const touched = await Comment.aggregate([
    { $match: { query: { $in: queryIds } } },
    { $group: { _id: '$query', at: { $min: '$createdAt' } } },
  ]);
  const touchedBy = new Map(touched.map((t) => [str(t._id), t.at]));

  let reassigned = 0;
  let escalated = 0;
  const reps = await loadReps();

  for (const log of pending) {
    const firstTouch = touchedBy.get(str(log.query));
    if (firstTouch && new Date(firstTouch) > new Date(log.createdAt)) {
      await AssignmentLog.updateOne({ _id: log._id }, { firstTouchAt: firstTouch, slaSettledAt: new Date() });
      continue;
    }
    const ageMin = (now - new Date(log.createdAt).getTime()) / 60000;
    const query = await Query.findById(log.query).select('queryNumber guest owner status attribution').lean();
    // A lead that has already moved on, or been reassigned by hand, is not owed an escalation.
    if (!query || !ACTIVE_STATUSES.includes(query.status) || str(query.owner) !== str(log.assignedTo)) {
      await AssignmentLog.updateOne({ _id: log._id }, { slaSettledAt: new Date() });
      continue;
    }

    if (reassignAfter && ageMin >= reassignAfter) {
      // Hand it to the least busy available person who is not the one sitting on it.
      const pool = reps
        .filter((r) => str(r._id) !== str(log.assignedTo) && r.acceptsLeads && !r.awayUntil
          && (!r.capacity || r.openLeads < r.capacity))
        .sort((a, b) => a.openLeads / (a.capacity || 1) - b.openLeads / (b.capacity || 1));
      const next = pool[0];
      if (next) {
        await Promise.all([
          Query.updateOne({ _id: query._id }, { owner: next._id }),
          AssignmentLog.updateOne({ _id: log._id }, {
            $push: {
              escalations: {
                at: new Date(), kind: 'reassigned', from: log.assignedTo, to: next._id,
                note: 'Not called within ' + reassignAfter + ' minutes',
              },
            },
            $set: { assignedTo: next._id },
          }),
          createNotification({
            recipient: next._id,
            type: 'lead_assigned',
            title: 'Reassigned lead: ' + (query.guest?.name || '#' + query.queryNumber),
            body: 'The previous owner did not call within ' + reassignAfter + ' minutes.',
            link: '/trips/' + query._id,
          }).catch(() => {}),
          logActivity(query._id, null, 'reassigned automatically: not called within ' + reassignAfter + ' minutes', 'note').catch(() => {}),
        ]);
        reassigned++;
        continue;
      }
    }

    if (managerAfter && ageMin >= managerAfter) {
      await Promise.all([
        AssignmentLog.updateOne({ _id: log._id }, {
          $push: { escalations: { at: new Date(), kind: 'manager_alerted', from: log.assignedTo, note: 'Untouched after ' + Math.round(ageMin) + ' minutes' } },
          $set: { slaSettledAt: new Date() },
        }),
        notifyManagers(query, 'nobody_available').catch(() => {}),
      ]);
      escalated++;
    }
  }
  return { reassigned, escalated, checked: pending.length };
}

/* ───────────────────────────── route handlers ────────────────────────────── */

function shapeSettingsOut(cfg, stats, ackTemplate) {
  const a = cfg.assignment || {};
  return {
    autoAssign: !!a.autoAssign,
    defaultMethod: a.defaultMethod || 'least_busy',
    hours: { start: a.hours?.start || '09:00', end: a.hours?.end || '20:00' },
    afterHours: { mode: a.afterHours?.mode || 'hold' },
    sla: {
      firstCallMinutes: a.sla?.firstCallMinutes ?? 15,
      reassignMinutes: a.sla?.reassignMinutes ?? 15,
      managerMinutes: a.sla?.managerMinutes ?? 30,
      notifyApp: a.sla?.notifyApp !== false,
      notifyWhatsapp: a.sla?.notifyWhatsapp === true,
    },
    fairness: {
      repeatToSameRep: a.fairness?.repeatToSameRep !== false,
      mergeDuplicateDays: a.fairness?.mergeDuplicateDays ?? 30,
      allowManualOverride: a.fairness?.allowManualOverride !== false,
      explainSkips: a.fairness?.explainSkips !== false,
    },
    ackEnabled: !!a.ackEnabled,
    ackTemplateKey: a.ackTemplateKey || 'enquiry_received',
    ackTemplate,
    methods: ASSIGNMENT_METHODS,
    stats,
  };
}

/** Today's headline numbers for the status strip. */
async function todayStats() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const logs = await AssignmentLog.find({ createdAt: { $gte: since } })
    .select('assignedTo unassignedReason createdAt firstTouchAt slaMinutes')
    .lean();
  const assigned = logs.filter((l) => l.assignedTo);
  const called = assigned.filter((l) => l.firstTouchAt);
  const totalMin = called.reduce((s, l) => s + (new Date(l.firstTouchAt) - new Date(l.createdAt)) / 60000, 0);
  const overdue = assigned.filter((l) => !l.firstTouchAt && l.slaMinutes
    && Date.now() - new Date(l.createdAt).getTime() > l.slaMinutes * 60000);
  return {
    autoAssignedToday: assigned.length,
    totalToday: logs.length,
    avgFirstCallMinutes: called.length ? Math.round((totalMin / called.length) * 10) / 10 : null,
    awaitingPerson: logs.length - assigned.length,
    overdue: overdue.length,
  };
}

// GET /api/leads/assignment/settings
export const getAssignmentSettings = asyncHandler(async (req, res) => {
  const cfg = await LeadSettings.getFor();
  const [stats, tpl] = await Promise.all([
    todayStats(),
    mongoose.model('WhatsappTemplate')
      .findOne({ key: cfg.assignment?.ackTemplateKey || 'enquiry_received' })
      .select('key name label body isActive')
      .lean(),
  ]);
  return ok(res, shapeSettingsOut(cfg, stats, tpl || null));
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// PATCH /api/leads/assignment/settings
export const updateAssignmentSettings = asyncHandler(async (req, res) => {
  const cfg = await LeadSettings.getFor();
  const a = cfg.assignment || {};
  const b = req.body || {};

  if (b.autoAssign !== undefined) a.autoAssign = !!b.autoAssign;
  if (b.defaultMethod !== undefined) {
    if (!METHOD_KEYS.includes(b.defaultMethod)) throw ApiError.badRequest('Unknown method: ' + b.defaultMethod);
    a.defaultMethod = b.defaultMethod;
  }
  if (b.hours) {
    for (const k of ['start', 'end']) {
      if (b.hours[k] === undefined) continue;
      if (!HHMM.test(b.hours[k])) throw ApiError.badRequest('Office hours must look like 09:00');
      a.hours = { ...(a.hours || {}), [k]: b.hours[k] };
    }
  }
  if (b.afterHours?.mode !== undefined) {
    if (!['night_shift', 'hold', 'assign_now'].includes(b.afterHours.mode)) {
      throw ApiError.badRequest('Unknown after-hours mode: ' + b.afterHours.mode);
    }
    a.afterHours = { mode: b.afterHours.mode };
  }
  if (b.sla) {
    const sla = { ...(a.sla || {}) };
    for (const k of ['firstCallMinutes', 'reassignMinutes', 'managerMinutes']) {
      if (b.sla[k] === undefined) continue;
      const n = Number(b.sla[k]);
      if (!Number.isFinite(n) || n < 0 || n > 10080) throw ApiError.badRequest(k + ' must be between 0 and 10080 minutes');
      sla[k] = Math.round(n);
    }
    if (b.sla.notifyApp !== undefined) sla.notifyApp = !!b.sla.notifyApp;
    if (b.sla.notifyWhatsapp !== undefined) sla.notifyWhatsapp = !!b.sla.notifyWhatsapp;
    // Escalating to a manager before the lead has even been handed on would alarm them about
    // a lead the system is still dealing with.
    if (sla.managerMinutes && sla.reassignMinutes && sla.managerMinutes < sla.reassignMinutes) {
      throw ApiError.badRequest('The manager alert has to come after the reassignment, not before it');
    }
    a.sla = sla;
  }
  if (b.fairness) {
    const f = { ...(a.fairness || {}) };
    if (b.fairness.repeatToSameRep !== undefined) f.repeatToSameRep = !!b.fairness.repeatToSameRep;
    if (b.fairness.allowManualOverride !== undefined) f.allowManualOverride = !!b.fairness.allowManualOverride;
    if (b.fairness.explainSkips !== undefined) f.explainSkips = !!b.fairness.explainSkips;
    if (b.fairness.mergeDuplicateDays !== undefined) {
      const n = Number(b.fairness.mergeDuplicateDays);
      if (!Number.isFinite(n) || n < 0 || n > 365) throw ApiError.badRequest('Duplicate window must be 0 to 365 days');
      f.mergeDuplicateDays = Math.round(n);
    }
    a.fairness = f;
  }
  if (b.ackEnabled !== undefined) a.ackEnabled = !!b.ackEnabled;
  if (b.ackTemplateKey !== undefined) a.ackTemplateKey = String(b.ackTemplateKey || '').trim() || 'enquiry_received';

  cfg.assignment = a;
  cfg.markModified('assignment');
  await cfg.save();

  const [stats, tpl] = await Promise.all([
    todayStats(),
    mongoose.model('WhatsappTemplate').findOne({ key: a.ackTemplateKey }).select('key name label body isActive').lean(),
  ]);
  return ok(res, shapeSettingsOut(cfg, stats, tpl || null));
});

/** The rule as one readable sentence, so a manager can audit the list without opening each. */
function ruleSentence(rule, labels) {
  const target = targetLabel(rule, labels);
  const method = ASSIGNMENT_METHODS.find((m) => m.key === rule.method)?.label || rule.method;
  if (!rule.conditions?.length) return 'OTHERWISE give to ' + target + ' by ' + method;
  const joiner = rule.match === 'any' ? ' OR ' : ' AND ';
  const when = rule.conditions.map((c) => describeCondition(c, labels)).join(joiner);
  return 'IF ' + when + ' GIVE TO ' + target + ' BY ' + method;
}

async function shapeRules() {
  const [rules, { labels }] = await Promise.all([loadRules(), loadLabels()]);
  return rules.map((r) => ({
    ...r,
    targetLabel: targetLabel(r, labels),
    targetUsers: (r.targetUsers || []).map((id) => ({ _id: id, name: labels[str(id)] || 'Deleted user' })),
    targetTeam: r.targetTeam ? { _id: r.targetTeam, name: labels[str(r.targetTeam)] || 'Deleted team' } : null,
    conditions: (r.conditions || []).map((c) => ({ ...c, text: describeCondition(c, labels) })),
    sentence: ruleSentence(r, labels),
    hitsToday: isToday(r.hitsOn) ? r.hitsToday || 0 : 0,
  }));
}

function isToday(d) {
  if (!d) return false;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return new Date(d) >= t;
}

// GET /api/leads/assignment/rules
export const listRules = asyncHandler(async (req, res) => ok(res, await shapeRules()));

const FIELD_KEYS = CONDITION_FIELDS.map((f) => f.key);
const OP_KEYS = CONDITION_OPS.map((o) => o.key);

/** Validates a rule body. Conditions are checked field-by-field because a typo here does not
 *  error at runtime — it silently never matches, and the lead goes somewhere else forever. */
function validateRuleBody(b, { partial = false } = {}) {
  const out = {};
  if (b.label !== undefined || !partial) {
    const label = String(b.label || '').trim();
    if (!label) throw ApiError.badRequest('Give the rule a name so the log is readable');
    out.label = label.slice(0, 120);
  }
  if (b.match !== undefined) {
    if (!['all', 'any'].includes(b.match)) throw ApiError.badRequest('match must be "all" or "any"');
    out.match = b.match;
  }
  if (b.conditions !== undefined) {
    if (!Array.isArray(b.conditions)) throw ApiError.badRequest('conditions must be a list');
    out.conditions = b.conditions.slice(0, 12).map((c, i) => {
      if (!FIELD_KEYS.includes(c.field)) throw ApiError.badRequest('Condition ' + (i + 1) + ': unknown field "' + c.field + '"');
      if (!OP_KEYS.includes(c.op)) throw ApiError.badRequest('Condition ' + (i + 1) + ': unknown operator "' + c.op + '"');
      const spec = CONDITION_FIELDS.find((f) => f.key === c.field);
      const op = CONDITION_OPS.find((o) => o.key === c.op);
      if (!op.types.includes(spec.type)) {
        throw ApiError.badRequest('Condition ' + (i + 1) + ': "' + op.label + '" cannot be used with ' + spec.label);
      }
      if (!['exists', 'blank'].includes(c.op)) {
        if (c.value === undefined || c.value === null || c.value === '') {
          throw ApiError.badRequest('Condition ' + (i + 1) + ' (' + spec.label + ') needs a value');
        }
        if (spec.type === 'number' && !Number.isFinite(Number(c.value))) {
          throw ApiError.badRequest('Condition ' + (i + 1) + ': ' + spec.label + ' must be a number');
        }
      }
      return { field: c.field, op: c.op, value: ['exists', 'blank'].includes(c.op) ? undefined : c.value };
    });
  }
  if (b.targetType !== undefined) {
    if (!['user', 'team', 'any'].includes(b.targetType)) throw ApiError.badRequest('Unknown target type');
    out.targetType = b.targetType;
  }
  if (b.targetUsers !== undefined) {
    if (!Array.isArray(b.targetUsers)) throw ApiError.badRequest('targetUsers must be a list');
    out.targetUsers = b.targetUsers.map((u) => str(u?._id || u)).filter((id) => mongoose.isValidObjectId(id));
  }
  if (b.targetTeam !== undefined) {
    const id = str(b.targetTeam?._id || b.targetTeam);
    out.targetTeam = id && mongoose.isValidObjectId(id) ? id : null;
  }
  if (b.method !== undefined) {
    if (!METHOD_KEYS.includes(b.method)) throw ApiError.badRequest('Unknown method: ' + b.method);
    out.method = b.method;
  }
  if (b.slaMinutes !== undefined) {
    if (b.slaMinutes === null || b.slaMinutes === '') out.slaMinutes = undefined;
    else {
      const n = Number(b.slaMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 10080) throw ApiError.badRequest('SLA must be 1 to 10080 minutes');
      out.slaMinutes = Math.round(n);
    }
  }
  if (b.isActive !== undefined) out.isActive = !!b.isActive;

  const type = out.targetType ?? (partial ? undefined : 'any');
  if (type === 'user' && out.targetUsers !== undefined && !out.targetUsers.length) {
    throw ApiError.badRequest('Pick at least one person for a rule that targets people');
  }
  if (type === 'team' && out.targetTeam === null) throw ApiError.badRequest('Pick a team for a rule that targets a team');
  return out;
}

// POST /api/leads/assignment/rules
export const createRule = asyncHandler(async (req, res) => {
  const patch = validateRuleBody(req.body || {});
  // New rules land above the fallback, which always stays last.
  const last = await AssignmentRule.findOne({ isFallback: { $ne: true } }).sort('-order').select('order').lean();
  const rule = await AssignmentRule.create({
    ...patch,
    order: (last?.order ?? 0) + 1,
    createdBy: req.user._id,
  });
  const all = await shapeRules();
  return created(res, all.find((r) => str(r._id) === str(rule._id)) || rule.toJSON());
});

// PATCH /api/leads/assignment/rules/:id
export const updateRule = asyncHandler(async (req, res) => {
  const rule = await AssignmentRule.findById(req.params.id);
  if (!rule) throw ApiError.notFound('Rule not found');
  const patch = validateRuleBody(req.body || {}, { partial: true });

  // The catch-all is what guarantees every lead has somewhere to go. Letting it be switched
  // off or re-pointed at nobody would lose leads silently, which is the one failure this
  // module exists to prevent.
  if (rule.isFallback) {
    if (patch.isActive === false) throw ApiError.conflict('The catch-all rule cannot be switched off — every lead needs somewhere to go');
    if (patch.conditions?.length) throw ApiError.conflict('The catch-all rule cannot have conditions');
  }
  Object.assign(rule, patch);
  await rule.save();
  const all = await shapeRules();
  return ok(res, all.find((r) => str(r._id) === str(rule._id)));
});

// DELETE /api/leads/assignment/rules/:id
export const removeRule = asyncHandler(async (req, res) => {
  const rule = await AssignmentRule.findById(req.params.id);
  if (!rule) throw ApiError.notFound('Rule not found');
  if (rule.isFallback) throw ApiError.conflict('The catch-all rule cannot be deleted — every lead needs somewhere to go');
  await rule.deleteOne();
  return ok(res, await shapeRules());
});

// PATCH /api/leads/assignment/rules/reorder  { ids: [...] }
export const reorderRules = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(str) : null;
  if (!ids?.length) throw ApiError.badRequest('Send the rule ids in their new order');
  const rules = await AssignmentRule.find().select('_id isFallback').lean();
  const known = new Set(rules.map((r) => str(r._id)));
  if (ids.some((id) => !known.has(id)) || ids.length !== rules.length) {
    throw ApiError.badRequest('The order must list every rule exactly once');
  }
  await AssignmentRule.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { order: i + 1 } } })));
  return ok(res, await shapeRules());
});

// GET /api/leads/assignment/meta
export const assignmentMeta = asyncHandler(async (req, res) => {
  const { sources, teams, dests, tags, users } = await loadLabels();
  const all = await loadReps();
  const byId = new Map(all.map((r) => [str(r._id), r]));
  return ok(res, {
    fields: CONDITION_FIELDS,
    ops: CONDITION_OPS,
    methods: ASSIGNMENT_METHODS,
    channels: LEAD_CHANNELS.map((c) => ({ key: c.key, label: c.label, icon: c.icon, color: c.color })),
    sources,
    teams,
    destinations: dests,
    tags,
    users: users.map((u) => ({ ...u, role: byId.get(str(u._id))?.role })),
  });
});

// POST /api/leads/assignment/simulate
//
// Runs the real engine. Nothing is written and the round-robin cursor is not advanced, so
// previewing a lead cannot change who the next real one goes to.
export const simulateAssignment = asyncHandler(async (req, res) => {
  const cfg = await LeadSettings.getFor();
  const [reps, rules, { labels }] = await Promise.all([loadReps(), loadRules(), loadLabels()]);
  const b = req.body || {};

  const at = b.at ? new Date(b.at) : new Date();
  if (Number.isNaN(at.getTime())) throw ApiError.badRequest('That is not a valid date and time');

  const lead = {
    channel: b.channel || 'direct',
    campaign: b.campaign || '',
    source: str(b.source),
    destinations: [b.destination].flat().filter(Boolean).map(str),
    tags: [b.tag].flat().filter(Boolean).map(str),
    value: Number(b.value) || 0,
    nights: Number(b.nights) || 0,
    pax: Number(b.pax) || 0,
    location: b.location || '',
    nationality: b.nationality || '',
  };

  const decorated = rules.map((r) => ({ ...r, targetLabel: targetLabel(r, labels) }));
  const cursors = cfg.assignment?.cursors instanceof Map ? Object.fromEntries(cfg.assignment.cursors) : {};
  const result = decideAssignment({
    lead,
    rules: decorated,
    reps,
    settings: cfg.assignment || {},
    now: at,
    cursors,
    previousOwner: b.previousOwner || null,
    labels,
  });

  return ok(res, {
    assignee: result.assignee
      ? {
        _id: result.assignee._id,
        name: result.assignee.name,
        role: result.assignee.role,
        openLeads: result.assignee.openLeads,
        capacity: result.assignee.capacity,
      }
      : null,
    ruleId: result.ruleId,
    ruleLabel: result.rule?.label || null,
    method: result.method,
    methodLabel: ASSIGNMENT_METHODS.find((m) => m.key === result.method)?.label || null,
    slaMinutes: result.slaMinutes,
    reasons: result.reasons,
    unassignedReason: result.unassignedReason,
    afterHours: isAfterHours(at, cfg.assignment?.hours),
  });
});

// GET /api/leads/assignment/team
export const listTeamLoad = asyncHandler(async (req, res) => {
  const [reps, cfg] = await Promise.all([loadReps(), LeadSettings.getFor()]);
  const teams = await Team.find().select('name').lean();
  const teamById = new Map(teams.map((t) => [str(t._id), t]));
  const afterHours = isAfterHours(new Date(), cfg.assignment?.hours);

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const calls = await AssignmentLog.aggregate([
    { $match: { createdAt: { $gte: since }, firstTouchAt: { $ne: null } } },
    { $group: { _id: '$assignedTo', total: { $sum: { $divide: [{ $subtract: ['$firstTouchAt', '$createdAt'] }, 60000] } }, n: { $sum: 1 } } },
  ]);
  const callBy = new Map(calls.map((c) => [str(c._id), Math.round((c.total / c.n) * 10) / 10]));

  return ok(res, reps.map((r) => {
    const blocked = r.acceptsLeads === false ? 'is switched off for new leads'
      : r.awayUntil ? (r.awayReason ? 'is away (' + r.awayReason + ')' : 'is away')
        : !afterHours && r.nightShift ? 'is on the night shift'
          : afterHours && !r.nightShift ? 'does not work after hours'
            : r.capacity > 0 && r.openLeads >= r.capacity ? 'has reached the daily limit (' + r.openLeads + ' of ' + r.capacity + ')'
              : null;
    return {
      _id: r._id,
      name: r.name,
      email: r.email,
      role: r.role,
      team: r.team ? teamById.get(str(r.team)) || null : null,
      accepts: r.acceptsLeads,
      capacity: r.capacity,
      openLeads: r.openLeads,
      loadPct: r.capacity ? Math.min(100, Math.round((r.openLeads / r.capacity) * 100)) : 0,
      awayUntil: r.awayUntil,
      awayReason: r.awayReason,
      nightShift: r.nightShift,
      available: !blocked,
      blockedReason: blocked,
      today: r.today,
      avgFirstCallMinutes: callBy.get(str(r._id)) ?? null,
      conversionRate: r.conversionRate,
    };
  }));
});

// PATCH /api/leads/assignment/team/:userId
export const updateRepAvailability = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId).select('name role leads');
  if (!user) throw ApiError.notFound('User not found');
  if (!SALES_ROLES.includes(user.role)) throw ApiError.badRequest(user.name + ' is not in a role that works leads');

  const b = req.body || {};
  const leads = { ...(user.leads?.toObject?.() || user.leads || {}) };
  if (b.accepts !== undefined) leads.accepts = !!b.accepts;
  if (b.nightShift !== undefined) leads.nightShift = !!b.nightShift;
  if (b.capacity !== undefined) {
    const n = Number(b.capacity);
    if (!Number.isFinite(n) || n < 0 || n > 500) throw ApiError.badRequest('Capacity must be between 0 and 500');
    leads.capacity = Math.round(n);
  }
  if (b.awayUntil !== undefined) {
    if (!b.awayUntil) { leads.awayUntil = undefined; leads.awayReason = undefined; } else {
      const d = new Date(b.awayUntil);
      if (Number.isNaN(d.getTime())) throw ApiError.badRequest('That is not a valid date');
      leads.awayUntil = d;
    }
  }
  if (b.awayReason !== undefined) leads.awayReason = String(b.awayReason || '').trim().slice(0, 120) || undefined;

  user.leads = leads;
  user.markModified('leads');
  await user.save();
  return ok(res, { _id: user._id, name: user.name, leads: user.leads });
});

// GET /api/leads/assignment/log
export const assignmentLog = asyncHandler(async (req, res) => {
  await sweepSla().catch(() => {});
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const filter = {};
  if (req.query.date) {
    const d = new Date(req.query.date);
    if (Number.isNaN(d.getTime())) throw ApiError.badRequest('That is not a valid date');
    filter.createdAt = { $gte: new Date(d.setHours(0, 0, 0, 0)), $lte: new Date(new Date(d).setHours(23, 59, 59, 999)) };
  }

  const logs = await AssignmentLog.find(filter)
    .sort('-createdAt')
    .limit(limit)
    .populate('assignedTo', 'name')
    .populate({ path: 'query', select: 'queryNumber guest status' })
    .populate('escalations.from escalations.to', 'name')
    .lean();

  const items = logs.map((l) => {
    const mins = l.firstTouchAt
      ? Math.round((new Date(l.firstTouchAt) - new Date(l.createdAt)) / 60000)
      : Math.round((Date.now() - new Date(l.createdAt).getTime()) / 60000);
    const overdue = !l.firstTouchAt && l.slaMinutes && mins > l.slaMinutes;
    return {
      _id: l._id,
      at: l.createdAt,
      query: l.query || null,
      channel: l.channel || 'direct',
      channelLabel: channelMeta(l.channel).label,
      assignedTo: l.assignedTo || null,
      ruleLabel: l.ruleLabel || null,
      method: l.method || null,
      reasons: l.reasons || [],
      firstCallLabel: l.firstTouchAt
        ? (mins <= 0 ? 'Called immediately' : 'Called in ' + mins + ' min')
        : l.assignedTo ? 'Not called, ' + mins + ' min' : null,
      late: !!overdue,
      overdue: !!overdue,
      manual: !!l.manual,
      unassignedReason: l.unassignedReason || null,
      escalations: l.escalations || [],
    };
  });

  return ok(res, {
    items,
    stats: {
      assigned: items.filter((i) => i.assignedTo).length,
      unassigned: items.filter((i) => !i.assignedTo).length,
      escalated: items.filter((i) => i.escalations.length).length,
    },
  });
});

// POST /api/leads/assignment/reassign/:queryId  { owner, note }
export const reassignLead = asyncHandler(async (req, res) => {
  const query = await Query.findById(req.params.queryId).select('queryNumber guest owner attribution');
  if (!query) throw ApiError.notFound('Lead not found');

  // `auto` re-runs the engine; otherwise a named owner is taken as a manual override.
  if (req.body?.auto) {
    const cfg = await LeadSettings.getFor();
    if (!cfg.assignment?.autoAssign) throw ApiError.badRequest('Automatic assignment is switched off');
    const result = await assignLead(query, { actor: req.user._id, settings: cfg });
    return ok(res, result);
  }

  const ownerId = str(req.body?.owner);
  if (!mongoose.isValidObjectId(ownerId)) throw ApiError.badRequest('Pick who the lead should go to');
  const owner = await User.findById(ownerId).select('name role');
  if (!owner) throw ApiError.notFound('That user does not exist');
  if (!SALES_ROLES.includes(owner.role)) throw ApiError.badRequest(owner.name + ' is not in a role that works leads');

  const previous = query.owner;
  query.owner = owner._id;
  await query.save();

  const note = String(req.body?.note || '').trim().slice(0, 300);
  await Promise.all([
    AssignmentLog.create({
      query: query._id,
      assignedTo: owner._id,
      channel: query.attribution?.channel || 'direct',
      method: 'direct',
      manual: true,
      actor: req.user._id,
      reasons: ['Assigned by hand by ' + req.user.name + (note ? ': ' + note : '') + '.'],
    }),
    // Settle any SLA clock still running against the previous owner — they no longer hold it.
    AssignmentLog.updateMany(
      { query: query._id, assignedTo: previous, slaSettledAt: null },
      { slaSettledAt: new Date() }
    ),
    createNotification({
      recipient: owner._id,
      type: 'lead_assigned',
      title: 'Lead given to you: ' + (query.guest?.name || '#' + query.queryNumber),
      body: req.user.name + ' assigned this lead to you' + (note ? ': ' + note : '') + '.',
      link: '/trips/' + query._id,
      createdBy: req.user._id,
    }).catch(() => {}),
    logActivity(query._id, req.user._id, 'reassigned the lead to ' + owner.name, 'note').catch(() => {}),
  ]);

  return ok(res, { assigned: true, owner: owner._id, ownerName: owner.name, manual: true });
});

// POST /api/leads/assignment/sweep — run the SLA sweep now (used by the page's refresh).
export const runSweep = asyncHandler(async (req, res) => ok(res, await sweepSla({ force: true })));
