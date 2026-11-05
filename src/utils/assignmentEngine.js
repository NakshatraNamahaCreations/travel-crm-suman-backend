// Decides which salesperson a new lead goes to.
//
// Pure and side-effect free: it is handed the rules, the team's current load and the lead, and
// returns the chosen person together with the reasoning. The controller does the database work
// either side of it. That split exists so the "Try it" simulator on the Assignment page runs
// the real decision rather than an imitation of it — a preview that disagrees with production
// would be actively misleading, and this is the code path that decides who calls a customer.
//
// Every outcome carries `reasons`: an ordered list of plain sentences. They are stored on the
// assignment log, so months later it is still answerable why a particular lead went where it
// did, including the people who were skipped and why.

export const CONDITION_FIELDS = [
  { key: 'channel', label: 'Lead came from', type: 'channel' },
  { key: 'source', label: 'Query source', type: 'id' },
  { key: 'campaign', label: 'Campaign name', type: 'text' },
  { key: 'destination', label: 'Destination', type: 'id', array: true },
  { key: 'tag', label: 'Tag', type: 'id', array: true },
  { key: 'value', label: 'Expected value', type: 'number' },
  { key: 'nights', label: 'Nights', type: 'number' },
  { key: 'pax', label: 'Travellers', type: 'number' },
  { key: 'location', label: 'Guest city / state', type: 'text' },
  { key: 'nationality', label: 'Nationality', type: 'text' },
];

export const CONDITION_OPS = [
  { key: 'eq', label: 'is', types: ['channel', 'id', 'text', 'number'] },
  { key: 'neq', label: 'is not', types: ['channel', 'id', 'text', 'number'] },
  { key: 'in', label: 'is any of', types: ['channel', 'id', 'text'], multi: true },
  { key: 'contains', label: 'contains', types: ['text'] },
  { key: 'gt', label: 'is above', types: ['number'] },
  { key: 'gte', label: 'is at least', types: ['number'] },
  { key: 'lt', label: 'is below', types: ['number'] },
  { key: 'lte', label: 'is at most', types: ['number'] },
  { key: 'exists', label: 'is filled in', types: ['channel', 'id', 'text', 'number'] },
  { key: 'blank', label: 'is empty', types: ['channel', 'id', 'text', 'number'] },
];

export const ASSIGNMENT_METHODS = [
  { key: 'round_robin', label: 'Round robin', description: 'Take turns. Lead 1 to A, lead 2 to B, lead 3 to C, then repeat.' },
  { key: 'least_busy', label: 'Least busy first', description: 'Give the lead to whoever has the fewest open leads right now.' },
  { key: 'direct', label: 'Direct', description: 'Always the same person. Used by rules that name one owner.' },
  { key: 'top_closer', label: 'Best closer', description: 'High-value or urgent leads go to the people who convert most.' },
];

export const METHOD_KEYS = ASSIGNMENT_METHODS.map((m) => m.key);

const str = (v) => (v === undefined || v === null ? '' : String(v));
const idList = (v) => (Array.isArray(v) ? v.map(str) : [str(v)]).filter(Boolean);

/** Pulls the comparable value for a condition field off a normalized lead. */
function leadValue(lead, field) {
  switch (field) {
    case 'channel': return lead.channel ?? '';
    case 'source': return str(lead.source);
    case 'campaign': return lead.campaign ?? '';
    case 'destination': return idList(lead.destinations);
    case 'tag': return idList(lead.tags);
    case 'value': return Number(lead.value) || 0;
    case 'nights': return Number(lead.nights) || 0;
    case 'pax': return Number(lead.pax) || 0;
    case 'location': return lead.location ?? '';
    case 'nationality': return lead.nationality ?? '';
    default: return '';
  }
}

/** Evaluates one condition. Array-valued lead fields (destinations, tags) match when ANY
 *  element matches, which is what "destination is Maldives" means on a multi-destination
 *  query. */
export function matchCondition(lead, cond) {
  if (!cond || !cond.field || !cond.op) return false;
  const actual = leadValue(lead, cond.field);
  const expected = cond.value;

  if (cond.op === 'exists') return Array.isArray(actual) ? actual.length > 0 : str(actual) !== '' && actual !== 0;
  if (cond.op === 'blank') return Array.isArray(actual) ? actual.length === 0 : str(actual) === '' || actual === 0;

  if (Array.isArray(actual)) {
    const wanted = idList(expected);
    const hit = actual.some((a) => wanted.includes(a));
    return cond.op === 'neq' ? !hit : hit;
  }

  switch (cond.op) {
    case 'eq': return str(actual).toLowerCase() === str(expected).toLowerCase();
    case 'neq': return str(actual).toLowerCase() !== str(expected).toLowerCase();
    case 'in': return idList(expected).map((x) => x.toLowerCase()).includes(str(actual).toLowerCase());
    case 'contains': return str(actual).toLowerCase().includes(str(expected).toLowerCase());
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    default: return false;
  }
}

/** A rule matches when ALL (default) or ANY of its conditions do. A rule with no conditions
 *  is the catch-all and always matches, which is how the last rule in the list behaves. */
export function matchRule(lead, rule) {
  const conds = rule?.conditions || [];
  if (!conds.length) return true;
  return rule.match === 'any' ? conds.some((c) => matchCondition(lead, c)) : conds.every((c) => matchCondition(lead, c));
}

/** Human phrase for one condition, used in the rule sentence and the reasons list. */
export function describeCondition(cond, labels = {}) {
  const f = CONDITION_FIELDS.find((x) => x.key === cond.field);
  const o = CONDITION_OPS.find((x) => x.key === cond.op);
  const name = (v) => labels[str(v)] || str(v);
  const value = Array.isArray(cond.value) ? cond.value.map(name).join(' or ') : name(cond.value);
  if (cond.op === 'exists' || cond.op === 'blank') return (f?.label || cond.field) + ' ' + (o?.label || cond.op);
  return [f?.label || cond.field, o?.label || cond.op, value].filter(Boolean).join(' ');
}

/** Minutes since midnight, in whatever zone the caller already shifted `now` into. */
const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();

function parseHhMm(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(v));
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

/** True when `now` falls outside the configured working window. Windows that wrap past
 *  midnight (22:00–06:00) are supported, which is why this is not a plain >= && <=. */
export function isAfterHours(now, hours = {}) {
  const start = parseHhMm(hours.start, 9 * 60);
  const end = parseHhMm(hours.end, 20 * 60);
  const t = minutesOfDay(now);
  if (start === end) return false;
  return start < end ? t < start || t >= end : t < start && t >= end;
}

/** A rep can take this lead right now. Returns the blocking reason instead of a bare false so
 *  the decision can explain itself. */
function availability(rep, { afterHours }) {
  if (rep.acceptsLeads === false) return 'is switched off for new leads';
  if (rep.awayUntil && new Date(rep.awayUntil).getTime() > Date.now()) {
    return rep.awayReason ? 'is away (' + rep.awayReason + ')' : 'is away';
  }
  // A night-shift rep is held back during office hours so the day team keeps its turn order,
  // and is the only pool considered once the office has closed.
  if (!afterHours && rep.nightShift) return 'is on the night shift';
  if (afterHours && !rep.nightShift) return 'does not work after hours';
  const cap = Number(rep.capacity) || 0;
  if (cap > 0 && (Number(rep.openLeads) || 0) >= cap) {
    return 'has reached the daily limit (' + rep.openLeads + ' of ' + cap + ')';
  }
  return null;
}

function pickByMethod(method, pool, { cursor = 0 }) {
  if (!pool.length) return { rep: null, nextCursor: cursor };
  if (method === 'least_busy') {
    const sorted = [...pool].sort((a, b) => {
      const la = (Number(a.openLeads) || 0) / (Number(a.capacity) || 1);
      const lb = (Number(b.openLeads) || 0) / (Number(b.capacity) || 1);
      if (la !== lb) return la - lb;
      return str(a.name).localeCompare(str(b.name));
    });
    return { rep: sorted[0], nextCursor: cursor, why: 'fewest open leads' };
  }
  if (method === 'top_closer') {
    const sorted = [...pool].sort((a, b) => (Number(b.conversionRate) || 0) - (Number(a.conversionRate) || 0)
      || str(a.name).localeCompare(str(b.name)));
    return { rep: sorted[0], nextCursor: cursor, why: 'highest conversion rate' };
  }
  if (method === 'direct') return { rep: pool[0], nextCursor: cursor, why: 'named on the rule' };
  // round_robin — cursor is kept per rule by the caller, so each rule takes its own turns.
  const ordered = [...pool].sort((a, b) => str(a._id).localeCompare(str(b._id)));
  const idx = ((Number(cursor) || 0) % ordered.length + ordered.length) % ordered.length;
  return { rep: ordered[idx], nextCursor: idx + 1, why: 'next in turn' };
}

/**
 * Runs the whole decision.
 *
 * @param {object}   input.lead       normalized lead (see leadValue for the fields read)
 * @param {object[]} input.rules      ordered, active rules
 * @param {object[]} input.reps       candidate users with their current load
 * @param {object}   input.settings   assignment settings (autoAssign, hours, afterHours, …)
 * @param {Date}     input.now
 * @param {object}   input.cursors    { [ruleId]: number } round-robin positions
 * @param {string}   input.previousOwner  rep who handled this guest before, if any
 * @param {object}   input.labels     id → display name, for readable reasons
 * @returns {{assignee, rule, ruleId, method, slaMinutes, reasons, cursors, unassignedReason}}
 */
export function decideAssignment({
  lead = {},
  rules = [],
  reps = [],
  settings = {},
  now = new Date(),
  cursors = {},
  previousOwner = null,
  labels = {},
} = {}) {
  const reasons = [];
  const out = (extra) => ({
    assignee: null, rule: null, ruleId: null, method: null, slaMinutes: null,
    reasons, cursors, unassignedReason: null, ...extra,
  });

  if (settings.autoAssign === false) {
    reasons.push('Automatic assignment is switched off, so the lead waits in the unassigned list.');
    return out({ unassignedReason: 'auto_off' });
  }

  const afterHours = isAfterHours(now, settings.hours);
  const afterHoursMode = settings.afterHours?.mode || 'night_shift';
  if (afterHours) {
    if (afterHoursMode === 'hold') {
      reasons.push('Arrived outside office hours; held for assignment when the office opens.');
      return out({ unassignedReason: 'held_after_hours' });
    }
    reasons.push('Arrived outside office hours (' + (settings.hours?.start || '09:00') + '–' + (settings.hours?.end || '20:00') + ').');
  }
  // 'assign_now' treats an after-hours lead as an ordinary one, so the day team keeps it and
  // calls in the morning rather than it sitting with nobody.
  const nightPool = afterHours && afterHoursMode === 'night_shift';

  // A guest who has enquired before goes back to the person who already knows them, ahead of
  // any rule: continuity is worth more than an even spread.
  if (settings.fairness?.repeatToSameRep && previousOwner) {
    const prev = reps.find((r) => str(r._id) === str(previousOwner));
    if (prev) {
      const blocked = availability(prev, { afterHours: nightPool });
      if (!blocked) {
        reasons.push('Returning guest — back to ' + prev.name + ', who handled them before.');
        return out({ assignee: prev, method: 'direct', slaMinutes: settings.sla?.firstCallMinutes ?? null });
      }
      reasons.push('Returning guest, but ' + prev.name + ' ' + blocked + '.');
    }
  }

  const ordered = [...rules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const matched = ordered.find((r) => r.isActive !== false && matchRule(lead, r));
  if (!matched) {
    reasons.push('No rule matched this lead and there is no catch-all rule.');
    return out({ unassignedReason: 'no_rule' });
  }

  const conds = matched.conditions || [];
  reasons.push(conds.length
    ? 'Matched "' + (matched.label || 'rule') + '": ' + conds.map((c) => describeCondition(c, labels)).join(matched.match === 'any' ? ' or ' : ' and ') + '.'
    : 'Fell through to "' + (matched.label || 'everything else') + '".');

  // Pool the rule points at: a named person, a team's members, or the whole sales floor.
  //
  // Out of hours the night roster REPLACES that target rather than being intersected with it.
  // A rule like "Meta leads to the calling team" describes who works those leads during the
  // day; at 22:15 the calling team is at home, and intersecting the two sets would leave the
  // lead unassigned with its SLA clock already running.
  let pool;
  if (nightPool) {
    pool = reps.filter((r) => r.nightShift);
    if (!pool.length) {
      // Falling back to the day team here would assign a lead to someone asleep and then
      // escalate it against them, so it waits instead.
      reasons.push('Nobody is on the night shift, so the lead waits for the morning.');
      return out({ unassignedReason: 'no_night_shift', rule: matched, ruleId: str(matched._id) });
    }
    reasons.push('Out of hours, so the night shift takes it instead of ' + (matched.targetLabel || 'the usual group') + '.');
  } else if (matched.targetType === 'user' && matched.targetUsers?.length) {
    const wanted = idList(matched.targetUsers);
    pool = reps.filter((r) => wanted.includes(str(r._id)));
  } else if (matched.targetType === 'team' && matched.targetTeam) {
    pool = reps.filter((r) => str(r.team) === str(matched.targetTeam));
  } else {
    pool = reps;
  }

  const available = [];
  for (const rep of pool) {
    const blocked = availability(rep, { afterHours: nightPool });
    if (blocked) {
      if (settings.fairness?.explainSkips !== false) reasons.push('Skipped ' + rep.name + ': ' + blocked + '.');
    } else {
      available.push(rep);
    }
  }

  const poolLabel = nightPool ? 'the night shift' : matched.targetLabel || 'the target group';
  if (!available.length) {
    reasons.push('Nobody in ' + poolLabel + ' is available, so the manager is alerted.');
    return out({ unassignedReason: 'nobody_available', rule: matched, ruleId: str(matched._id) });
  }

  const method = METHOD_KEYS.includes(matched.method) ? matched.method : (settings.defaultMethod || 'least_busy');
  const ruleKey = str(matched._id) || 'rule-' + (matched.order ?? 0);
  const { rep, nextCursor, why } = pickByMethod(method, available, { cursor: cursors[ruleKey] });

  const methodLabel = ASSIGNMENT_METHODS.find((m) => m.key === method)?.label || method;
  reasons.push(methodLabel + ' in ' + poolLabel + ': ' + rep.name + (why ? ' (' + why + ')' : '') + '.');

  const slaMinutes = matched.slaMinutes ?? settings.sla?.firstCallMinutes ?? null;
  return out({
    assignee: rep,
    rule: matched,
    ruleId: str(matched._id) || null,
    method,
    slaMinutes,
    cursors: { ...cursors, [ruleKey]: nextCursor },
  });
}
