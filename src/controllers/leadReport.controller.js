import mongoose from 'mongoose';
import { Query } from '../models/Query.js';
import { Quote } from '../models/Quote.js';
import { AdSpend, monthStart } from '../models/AdSpend.js';
import { AssignmentLog } from '../models/AssignmentLog.js';
import { Visitor } from '../models/Visitor.js';
import { LeadSettings } from '../models/LeadSettings.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { ownScope, applyScope } from '../utils/ownScope.js';
import { env } from '../config/env.js';
import { LEAD_CHANNELS, channelMeta, isPaidChannel } from '../config/leadChannels.js';
import { CLASSIFICATION_ORDER } from '../utils/leadChannel.js';
import { technicalDetails } from '../utils/leadAttribution.js';
import { QUERY_STATUSES } from '../constants/queryStatus.js';

const STATUS_LABEL = Object.fromEntries(QUERY_STATUSES.map((s) => [s.value, s.label]));

// Same definition of a won sale the sales report uses, so the two pages cannot disagree about
// how many leads became customers.
const WON = ['converted', 'on_trip', 'past'];

const DAY = 86400000;
const round = (n) => Math.round(Number(n) || 0);
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/** Range from query params, defaulting to the last 30 days (what the page opens on). */
function rangeFrom(q) {
  const before = q.before ? new Date(new Date(q.before).setHours(23, 59, 59, 999)) : new Date();
  const days = Math.min(400, Math.max(1, Number(q.days) || 30));
  const after = q.after ? new Date(new Date(q.after).setHours(0, 0, 0, 0)) : new Date(before.getTime() - (days - 1) * DAY);
  if (after > before) throw ApiError.badRequest('The start of the range is after its end');
  return { after, before };
}

/** Which attribution field carries the credit, given the requested view. Stored at both ends,
 *  so switching between them is a change of field and not a re-ingest. */
const creditField = (credit) => (credit === 'first' ? 'attribution.firstChannel' : 'attribution.lastChannel');

/** A lead with no attribution at all (entered by an agent) still has to land somewhere, or the
 *  cards would not add up to the trips list. It counts as Direct / Unknown. */
const channelExpr = (credit) => ({
  $ifNull: ['$' + creditField(credit), { $ifNull: ['$attribution.channel', 'direct'] }],
});

function baseMatch(req, { after, before }) {
  return applyScope({ createdAt: { $gte: after, $lte: before } }, ownScope(req.user));
}

/** Spend recorded against the months the range touches, per channel. A range covering half a
 *  month still counts that month's whole spend — apportioning it by day would imply a
 *  precision the hand-entered figure does not have. */
async function spendByChannel({ after, before }) {
  const rows = await AdSpend.aggregate([
    { $match: { month: { $gte: monthStart(after), $lte: monthStart(before) } } },
    { $group: { _id: '$channel', amount: { $sum: '$amount' } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.amount]));
}

/** leads / quotes / conversions / revenue per channel, in one pass each. */
async function channelRollup(req, range, credit) {
  const match = baseMatch(req, range);
  const [leadRows, quoteRows] = await Promise.all([
    Query.aggregate([
      { $match: match },
      { $addFields: { _ch: channelExpr(credit) } },
      {
        $group: {
          _id: '$_ch',
          leads: { $sum: 1 },
          conversion: { $sum: { $cond: [{ $in: ['$status', WON] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$status', 'dropped'] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $in: ['$status', WON] }, { $ifNull: ['$bookedAmount', 0] }, 0] } },
          profit: { $sum: { $cond: [{ $in: ['$status', WON] }, { $ifNull: ['$profit', 0] }, 0] } },
        },
      },
    ]),
    // Quotes are counted through the query they belong to, so "quotes" on a channel card means
    // "leads from this channel that reached a quote".
    Quote.aggregate([
      { $match: { createdAt: { $gte: range.after, $lte: range.before }, ...ownScope(req.user, ['createdBy']) } },
      { $lookup: { from: Query.collection.name, localField: 'query', foreignField: '_id', as: 'q' } },
      { $unwind: '$q' },
      { $addFields: { _ch: { $ifNull: ['$q.' + creditField(credit), { $ifNull: ['$q.attribution.channel', 'direct'] }] } } },
      { $group: { _id: '$_ch', quotes: { $sum: 1 } } },
    ]),
  ]);

  const byKey = new Map(leadRows.map((r) => [r._id || 'direct', r]));
  const quotesByKey = new Map(quoteRows.map((r) => [r._id || 'direct', r.quotes]));
  return { byKey, quotesByKey };
}

/** Up to ~8 weekly buckets spanning the range, newest last. */
function weekBuckets({ after, before }) {
  const span = Math.ceil((before - after) / DAY) || 1;
  const size = span <= 14 ? 1 : span <= 70 ? 7 : Math.ceil(span / 10);
  const buckets = [];
  for (let start = new Date(after); start <= before; start = new Date(start.getTime() + size * DAY)) {
    const end = new Date(Math.min(start.getTime() + (size - 1) * DAY + (DAY - 1), before.getTime()));
    buckets.push({ start: new Date(start), end, total: 0, byChannel: {} });
  }
  return { buckets, size };
}

const fmtDay = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const bucketLabel = (b, size) => (size === 1 ? fmtDay(b.start) : fmtDay(b.start) + ' to ' + fmtDay(b.end));

/** The plain-English takeaways panel. Derived, never hard-coded: an insight that stops being
 *  true has to stop being shown, or the panel becomes decoration nobody trusts. */
function buildInsights({ channels, summary, health, credit }) {
  const out = [];
  const money = (n) => '₹' + round(n).toLocaleString('en-IN');
  const withLeads = channels.filter((c) => c.leads > 0);
  const top = withLeads.slice().sort((a, b) => b.leads - a.leads)[0];

  if (credit === 'first') {
    const firstTop = top;
    if (firstTop) {
      out.push({
        tone: 'info', icon: '→',
        title: firstTop.label + ' starts the most journeys',
        body: firstTop.leads + ' people first heard of you through ' + firstTop.label
          + ', even when they enquired later through something else. Switch to Last source to see what closed them.',
      });
    }
  } else if (top) {
    out.push({
      tone: 'good', icon: '↑',
      title: top.label + ' is your biggest source',
      body: top.leads + ' leads' + (top.costPerLead ? ' at ' + money(top.costPerLead) + ' each' : '')
        + '. ' + top.conversion + ' became customers (' + top.conversionPct + '%).',
    });
  }

  // Cheapest real cost per lead, among channels you actually pay for.
  const paid = channels.filter((c) => c.spend > 0 && c.leads > 0);
  const cheapest = paid.slice().sort((a, b) => a.costPerLead - b.costPerLead)[0];
  const dearest = paid.slice().sort((a, b) => b.costPerLead - a.costPerLead)[0];
  if (cheapest && dearest && cheapest.key !== dearest.key) {
    out.push({
      tone: 'good', icon: '★',
      title: cheapest.label + ' gives you the cheapest leads',
      body: money(cheapest.costPerLead) + ' per lead against ' + money(dearest.costPerLead) + ' on '
        + dearest.label + '. ' + (cheapest.conversionPct >= dearest.conversionPct
          ? 'It also converts better, so this is where more budget belongs.'
          : 'It converts worse though (' + cheapest.conversionPct + '% against ' + dearest.conversionPct + '%), so cheap is not automatically better here.'),
    });
  }

  // A channel bringing volume but converting badly is the most actionable thing on the page.
  const busy = withLeads.filter((c) => c.leads >= 10);
  const avgConv = busy.length ? busy.reduce((s, c) => s + c.conversionPct, 0) / busy.length : 0;
  const weak = busy.filter((c) => c.conversionPct < avgConv / 2).sort((a, b) => b.leads - a.leads)[0];
  if (weak) {
    out.push({
      tone: 'warn', icon: '!',
      title: weak.label + ' leads are not converting',
      body: 'Only ' + weak.conversionPct + '% become customers against ' + Math.round(avgConv)
        + '% across your other sources. Most drop before the first call — a tighter SLA on this channel is the usual fix.',
    });
  }

  if (health?.missing > 0) {
    out.push({
      tone: health.pct < 85 ? 'bad' : 'warn', icon: '!',
      title: health.missing + ' lead' + (health.missing === 1 ? '' : 's') + ' lost their source',
      body: health.worstPoint
        ? health.worstPoint.count + ' of them came from "' + health.worstPoint.formName
          + '", which is not sending tracking data. Fixing that one form takes you to ' + health.projectedPct + '%.'
        : 'They arrived with no tracking information at all. Check the Setup page for untracked capture points.',
    });
  }

  if (!out.length) {
    out.push({
      tone: 'info', icon: 'i',
      title: 'Not enough data yet',
      body: 'Once leads start arriving with tracking, this panel explains what is working and what is not.',
    });
  }
  return out;
}

/** Tracking health: how many leads know where they came from, and what is losing the rest. */
async function trackingHealth(req, range) {
  const match = baseMatch(req, range);
  const [agg] = await Query.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        tracked: { $sum: { $cond: [{ $eq: ['$attribution.tracked', true] }, 1, 0] } },
      },
    },
  ]);
  const total = agg?.total || 0;
  const withSource = agg?.tracked || 0;
  const missing = total - withSource;

  // Group the untracked ones by the form they came through, so the answer is a form to fix
  // rather than a percentage to worry about.
  const byForm = await Query.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$attribution.formName', 'Entered by an agent'] },
        count: { $sum: 1 },
        untracked: { $sum: { $cond: [{ $eq: ['$attribution.tracked', true] }, 0, 1] } },
      },
    },
    { $sort: { untracked: -1, count: -1 } },
    { $limit: 15 },
  ]);

  const worst = byForm.find((f) => f.untracked > 0 && f._id !== 'Entered by an agent');
  return {
    total,
    withSource,
    pct: pct(withSource, total),
    missing,
    worstPoint: worst ? { formName: worst._id, count: worst.untracked } : null,
    projectedPct: worst ? pct(withSource + worst.untracked, total) : pct(withSource, total),
    byForm: byForm.map((f) => ({
      formName: f._id,
      count: f.count,
      tracked: f.count - f.untracked,
      untracked: f.untracked,
    })),
  };
}

// GET /api/leads/report?after=&before=&days=&credit=last|first
export const leadReport = asyncHandler(async (req, res) => {
  const range = rangeFrom(req.query);
  const credit = req.query.credit === 'first' ? 'first' : 'last';

  // The window immediately before this one, same length, for the "vs last month" deltas.
  const span = range.before - range.after;
  const prevRange = { after: new Date(range.after.getTime() - span - 1), before: new Date(range.after.getTime() - 1) };

  const [{ byKey, quotesByKey }, spend, health, prevByChannel, prevSpend, weeklyRows] = await Promise.all([
    channelRollup(req, range, credit),
    spendByChannel(range),
    trackingHealth(req, range),
    Query.aggregate([
      { $match: baseMatch(req, prevRange) },
      { $addFields: { _ch: channelExpr(credit) } },
      { $group: { _id: '$_ch', leads: { $sum: 1 } } },
    ]),
    spendByChannel(prevRange),
    Query.aggregate([
      { $match: baseMatch(req, range) },
      { $addFields: { _ch: channelExpr(credit) } },
      { $group: { _id: { ch: '$_ch', day: { $dateTrunc: { date: '$createdAt', unit: 'day' } } }, n: { $sum: 1 } } },
    ]),
  ]);

  const totalSpend = [...spend.values()].reduce((s, v) => s + v, 0);

  const channels = LEAD_CHANNELS.map((meta) => {
    const row = byKey.get(meta.key) || {};
    const leads = row.leads || 0;
    const s = spend.get(meta.key) || 0;
    const revenue = round(row.revenue);
    const conversion = row.conversion || 0;
    return {
      key: meta.key,
      label: meta.label,
      description: meta.description,
      icon: meta.icon,
      color: meta.color,
      paid: !!meta.paid,
      leads,
      quotes: quotesByKey.get(meta.key) || 0,
      conversion,
      conversionPct: pct(conversion, leads),
      dropped: row.dropped || 0,
      revenue,
      profit: round(row.profit),
      spend: s,
      // null, not 0 — "free" and "we have not entered the spend yet" are different facts and
      // the card renders them differently.
      costPerLead: s > 0 && leads > 0 ? Math.round(s / leads) : null,
      avgDeal: conversion ? Math.round(revenue / conversion) : 0,
      roas: s > 0 ? Math.round((revenue / s) * 10) / 10 : null,
    };
  });

  const totalLeads = channels.reduce((s, c) => s + c.leads, 0);
  channels.forEach((c) => { c.sharePct = pct(c.leads, totalLeads); });

  // Weekly stacked series.
  const { buckets, size } = weekBuckets(range);
  for (const r of weeklyRows) {
    const day = new Date(r._id.day).getTime();
    const b = buckets.find((x) => day >= x.start.getTime() && day <= x.end.getTime());
    if (!b) continue;
    const key = r._id.ch || 'direct';
    b.byChannel[key] = (b.byChannel[key] || 0) + r.n;
    b.total += r.n;
  }

  const won = channels.reduce((s, c) => s + c.conversion, 0);
  const revenue = channels.reduce((s, c) => s + c.revenue, 0);
  const withSpend = channels.filter((c) => c.costPerLead !== null);
  const paidLeads = channels.filter((c) => c.spend > 0).reduce((s, c) => s + c.leads, 0);

  // Previous window, same length, measured exactly the same way — a delta computed two
  // different ways is a delta that lies.
  const prevLeads = prevByChannel.reduce((s, r) => s + r.leads, 0);
  const prevTotalSpend = [...prevSpend.values()].reduce((s, v) => s + v, 0);
  const prevPaidLeads = prevByChannel
    .filter((r) => (prevSpend.get(r._id) || 0) > 0)
    .reduce((s, r) => s + r.leads, 0);
  const prevCpl = prevTotalSpend > 0 && prevPaidLeads > 0 ? Math.round(prevTotalSpend / prevPaidLeads) : null;
  const cpl = totalSpend > 0 && paidLeads > 0 ? Math.round(totalSpend / paidLeads) : null;

  const summary = {
    leads: totalLeads,
    quotes: channels.reduce((s, c) => s + c.quotes, 0),
    conversion: won,
    conversionPct: pct(won, totalLeads),
    dropped: channels.reduce((s, c) => s + c.dropped, 0),
    revenue,
    profit: channels.reduce((s, c) => s + c.profit, 0),
    spend: totalSpend,
    // Cost per lead counts only the leads the spend could have bought: dividing by organic and
    // walk-in leads too would flatter every paid channel.
    costPerLead: cpl,
    topChannel: channels.slice().sort((a, b) => b.leads - a.leads)[0]?.key || null,
    cheapestChannel: withSpend.slice().sort((a, b) => a.costPerLead - b.costPerLead)[0]?.key || null,
    bestConvertingChannel: channels.filter((c) => c.leads >= 5).sort((a, b) => b.conversionPct - a.conversionPct)[0]?.key || null,
    prev: { leads: prevLeads, costPerLead: prevCpl },
    leadsDeltaPct: prevLeads ? Math.round(((totalLeads - prevLeads) / prevLeads) * 100) : null,
    costPerLeadDeltaPct: prevCpl && cpl ? Math.round(((cpl - prevCpl) / prevCpl) * 100) : null,
  };

  return ok(res, {
    range,
    credit,
    currency: 'INR',
    summary,
    channels,
    weekly: {
      buckets: buckets.map((b) => ({ label: bucketLabel(b, size), start: b.start, end: b.end, total: b.total, byChannel: b.byChannel })),
      max: Math.max(1, ...buckets.map((b) => b.total)),
    },
    insights: buildInsights({ channels, summary, health, credit }),
  });
});

// GET /api/leads/recent?channel=&limit=&credit=
export const recentLeads = asyncHandler(async (req, res) => {
  const range = rangeFrom(req.query);
  const credit = req.query.credit === 'first' ? 'first' : 'last';
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));

  const match = baseMatch(req, range);
  const pipeline = [
    { $match: match },
    { $addFields: { _ch: channelExpr(credit) } },
  ];
  if (req.query.channel) pipeline.push({ $match: { _ch: req.query.channel } });
  const countPipe = [...pipeline, { $count: 'n' }];
  pipeline.push({ $sort: { createdAt: -1 } }, { $limit: limit });

  const [rows, countRows] = await Promise.all([Query.aggregate(pipeline), Query.aggregate(countPipe)]);
  const ids = rows.map((r) => r._id);

  const [populated, logs] = await Promise.all([
    Query.find({ _id: { $in: ids } })
      .select('queryNumber guest destinations nights startDate status owner bookedAmount quotedAmount currency createdAt attribution')
      .populate('destinations', 'name')
      .populate('owner', 'name')
      .lean(),
    AssignmentLog.find({ query: { $in: ids } }).sort('-createdAt').lean(),
  ]);
  const byId = new Map(populated.map((q) => [String(q._id), q]));
  const logById = new Map();
  for (const l of logs) if (!logById.has(String(l.query))) logById.set(String(l.query), l);

  const firstCallLabel = (log) => {
    if (!log) return null;
    if (!log.firstTouchAt) {
      const mins = Math.round((Date.now() - new Date(log.createdAt).getTime()) / 60000);
      return 'Not called, ' + mins + ' min';
    }
    const mins = Math.round((new Date(log.firstTouchAt) - new Date(log.createdAt)) / 60000);
    return mins <= 0 ? 'Called immediately' : 'Called in ' + mins + ' min';
  };

  const items = rows.map((r) => {
    const q = byId.get(String(r._id)) || {};
    const log = logById.get(String(r._id));
    const a = q.attribution || {};
    const touch = (credit === 'first' ? a.first : a.last) || a.last || a.first || {};
    const late = !!log && !log.firstTouchAt && log.slaMinutes
      && Date.now() - new Date(log.createdAt).getTime() > log.slaMinutes * 60000;
    return {
      _id: q._id,
      queryNumber: q.queryNumber,
      guest: q.guest,
      destinations: q.destinations || [],
      nights: q.nights,
      startDate: q.startDate,
      status: q.status,
      statusLabel: STATUS_LABEL[q.status] || q.status,
      channel: r._ch,
      campaign: touch.campaign || null,
      tracked: a.tracked !== false && !!a.tracked,
      untracked: !a.tracked,
      owner: q.owner || null,
      assignment: log
        ? {
          ruleLabel: log.ruleLabel || null,
          method: log.method || null,
          slaMinutes: log.slaMinutes || null,
          firstCallLabel: firstCallLabel(log),
          late,
          unassignedReason: log.unassignedReason || null,
        }
        : null,
      amount: q.bookedAmount || q.quotedAmount || 0,
      currency: q.currency || 'INR',
      createdAt: q.createdAt,
    };
  });

  const total = countRows[0]?.n || 0;
  return ok(res, { items, total, truncated: total > items.length });
});

// GET /api/leads/campaigns?channel=&credit=
export const leadCampaigns = asyncHandler(async (req, res) => {
  const range = rangeFrom(req.query);
  const credit = req.query.credit === 'first' ? 'first' : 'last';
  const touchPath = credit === 'first' ? 'attribution.first' : 'attribution.last';

  const pipeline = [
    { $match: baseMatch(req, range) },
    { $addFields: { _ch: channelExpr(credit), _camp: '$' + touchPath + '.campaign', _term: '$' + touchPath + '.term', _ad: '$' + touchPath + '.content' } },
    { $match: { _camp: { $nin: [null, ''] } } },
  ];
  if (req.query.channel) pipeline.push({ $match: { _ch: req.query.channel } });
  pipeline.push(
    {
      $group: {
        _id: { campaign: '$_camp', channel: '$_ch' },
        leads: { $sum: 1 },
        conversion: { $sum: { $cond: [{ $in: ['$status', WON] }, 1, 0] } },
        revenue: { $sum: { $cond: [{ $in: ['$status', WON] }, { $ifNull: ['$bookedAmount', 0] }, 0] } },
        ads: { $addToSet: '$_ad' },
        keywords: { $addToSet: '$_term' },
      },
    },
    { $sort: { leads: -1 } },
    { $limit: 100 }
  );

  const rows = await Query.aggregate(pipeline);
  return ok(res, {
    range,
    credit,
    rows: rows.map((r) => ({
      campaign: r._id.campaign,
      channel: r._id.channel,
      channelLabel: channelMeta(r._id.channel).label,
      leads: r.leads,
      conversion: r.conversion,
      conversionPct: pct(r.conversion, r.leads),
      revenue: round(r.revenue),
      avgDeal: r.conversion ? Math.round(r.revenue / r.conversion) : 0,
      ads: (r.ads || []).filter(Boolean).slice(0, 6),
      keywords: (r.keywords || []).filter(Boolean).slice(0, 6),
    })),
  });
});

// GET /api/leads/:id/journey
export const leadJourney = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.badRequest('Not a valid lead id');
  const q = await Query.findOne(applyScope({ _id: req.params.id }, ownScope(req.user)))
    .select('queryNumber guest destinations status attribution owner createdAt')
    .populate('destinations', 'name')
    .populate('owner', 'name')
    .lean();
  if (!q) throw ApiError.notFound('Lead not found');

  const a = q.attribution || {};
  const log = await AssignmentLog.findOne({ query: q._id })
    .sort('-createdAt')
    .populate('assignedTo', 'name')
    .populate('escalations.from escalations.to', 'name')
    .lean();

  // The visitor row may already have expired; the touches copied onto the lead are the record
  // that must survive, and this is only used to top up the live visit count.
  const visitor = a.visitorId
    ? await Visitor.findOne({ visitorId: a.visitorId }).select('visitCount firstSeenAt').lean()
    : null;

  return ok(res, {
    query: {
      _id: q._id,
      queryNumber: q.queryNumber,
      guest: q.guest,
      destinations: q.destinations || [],
      status: q.status,
      statusLabel: STATUS_LABEL[q.status] || q.status,
      owner: q.owner || null,
      createdAt: q.createdAt,
    },
    channel: a.channel || 'direct',
    firstChannel: a.firstChannel || null,
    lastChannel: a.lastChannel || null,
    tracked: !!a.tracked,
    touches: (a.touches || []).map((t) => ({
      ...t,
      channelLabel: channelMeta(t.channel).label,
      clickIds: t.clickIds || {},
      custom: t.custom || {},
    })),
    assignment: log
      ? {
        assignedTo: log.assignedTo || null,
        ruleLabel: log.ruleLabel || null,
        method: log.method || null,
        reasons: log.reasons || [],
        slaMinutes: log.slaMinutes || null,
        firstTouchAt: log.firstTouchAt || null,
        escalations: log.escalations || [],
        unassignedReason: log.unassignedReason || null,
        manual: !!log.manual,
        at: log.createdAt,
      }
      : null,
    technical: technicalDetails(a),
    visitCount: a.visitCount || visitor?.visitCount || null,
    firstSeenAt: a.firstSeenAt || visitor?.firstSeenAt || null,
    device: a.device || null,
    visitorCity: a.visitorCity || null,
    conversionPage: a.conversionPage || null,
    formName: a.formName || null,
  });
});

// GET /api/leads/health
export const leadHealth = asyncHandler(async (req, res) => ok(res, await trackingHealth(req, rangeFrom(req.query))));

// GET /api/leads/setup — the checklist, assembled from what is actually configured.
export const leadSetup = asyncHandler(async (req, res) => {
  const settings = await LeadSettings.getFor();
  const range = rangeFrom({ days: 30 });
  const [health, trackedCount, linkCount, spendCount, ruleCount] = await Promise.all([
    trackingHealth(req, range),
    Query.countDocuments({ 'attribution.tracked': true }),
    mongoose.model('TrackingLink').countDocuments({}),
    AdSpend.countDocuments({}),
    mongoose.model('AssignmentRule').countDocuments({ isActive: true }),
  ]);

  const base = env.publicBaseUrl;
  const scriptTag = '<script src="' + base + '/api/public/track/' + settings.ingestToken
    + '/t.js" async></script>';
  // The hosted form lives on the CRM's own front end, not on the API, so it is built from
  // CLIENT_URL rather than PUBLIC_BASE_URL.
  //
  // Which front end, though, depends on where the page asking is: CLIENT_URL commonly lists
  // the deployed site AND localhost, and handing a developer on localhost:5173 a production
  // link is a link they cannot open. The request's own origin wins when it is one we already
  // trust, which keeps this from becoming a way to have the server echo any URL back.
  const askedFrom = String(req.headers.origin || '').replace(/\/+$/, '');
  const clientBase = env.clientUrls.includes(askedFrom) ? askedFrom : env.clientUrl;
  const formUrl = (clientBase || '').replace(/\/+$/, '') + '/enquiry/' + settings.ingestToken;
  const formLeads = await Query.countDocuments({ 'attribution.formName': 'Enquiry form' });

  const hosts = settings.capture?.siteHosts || [];
  const cap = settings.capture || {};
  const asg = settings.assignment || {};

  const items = [
    {
      key: 'script',
      title: 'Add the tracking code to the website',
      body: hosts.length
        ? 'Paste this before </head> on every page of ' + hosts.join(', ') + '. It remembers where each visitor came from for ' + (cap.retentionDays || 90) + ' days.'
        : 'Nobody has told the CRM which website to track yet. Add your domain on the UTM Capture page first.',
      status: hosts.length && trackedCount > 0 ? 'ok' : hosts.length ? 'warn' : 'todo',
      action: { label: 'Open UTM Capture', to: '/leads/capture' },
      code: scriptTag,
    },
    {
      key: 'form',
      title: 'Share your enquiry form link',
      body: formLeads > 0
        ? formLeads + ' enquir' + (formLeads === 1 ? 'y has' : 'ies have') + ' come through this form so far.'
        : 'No website form of your own? Use this one. Put the link in your Instagram bio, send it on '
          + 'WhatsApp, or print it as a QR code — every enquiry arrives here already knowing which '
          + 'ad or post it came from.',
      status: formLeads > 0 ? 'ok' : 'todo',
      action: null,
      code: formUrl,
    },
    {
      key: 'capture',
      title: 'Switch capture on and track every form',
      body: cap.enabled === false
        ? 'Capture is switched off, so nothing is being recorded.'
        : health.missing > 0 && health.worstPoint
          ? health.worstPoint.count + ' recent leads came through "' + health.worstPoint.formName + '" with no tracking data.'
          : 'Every capture point the CRM has seen is sending its tracking data.',
      status: cap.enabled === false ? 'todo' : health.missing > 0 ? 'warn' : 'ok',
      action: { label: 'Open UTM Capture', to: '/leads/capture' },
      code: null,
    },
    {
      key: 'templates',
      title: 'Paste the ad templates in Meta and Google',
      body: 'Done once per ad account. The platforms then fill in the campaign and ad names themselves, so you do not build a link per ad.',
      status: linkCount > 0 ? 'ok' : 'todo',
      action: { label: 'Open Tracking Links', to: '/leads/tracking-links' },
      code: null,
    },
    {
      key: 'links',
      title: 'Create tracking links for everything else',
      body: linkCount > 0
        ? linkCount + ' link' + (linkCount === 1 ? '' : 's') + ' saved and being measured.'
        : 'WhatsApp broadcasts, flyers, QR codes and partner listings need a link each, or their leads arrive as Direct.',
      status: linkCount > 0 ? 'ok' : 'todo',
      action: { label: 'Open Tracking Links', to: '/leads/tracking-links' },
      code: null,
    },
    {
      key: 'spend',
      title: 'Enter what you spend on ads',
      body: spendCount > 0
        ? 'Cost per lead and return on ad spend are being calculated.'
        : 'Without spend the page can tell you which channel is loudest, but not which is worth the money.',
      status: spendCount > 0 ? 'ok' : 'todo',
      action: { label: 'Enter ad spend', to: '/leads/tracking-links' },
      code: null,
    },
    {
      key: 'rules',
      title: 'Set up the assignment rules',
      body: ruleCount > 0
        ? ruleCount + ' active rule' + (ruleCount === 1 ? '' : 's') + ' decide who gets each lead.'
        : 'No rules yet, so every lead would fall to the same default.',
      status: ruleCount > 1 ? 'ok' : ruleCount === 1 ? 'warn' : 'todo',
      action: { label: 'Open Auto Assignment', to: '/leads/assignment' },
      code: null,
    },
    {
      key: 'auto',
      title: 'Switch automatic assignment on',
      body: asg.autoAssign
        ? 'New leads are assigned within seconds of arriving, with a ' + (asg.sla?.firstCallMinutes || 15) + ' minute first-call target.'
        : 'Assignment is off, so every new lead waits in the unassigned list for somebody to notice it.',
      status: asg.autoAssign ? 'ok' : 'todo',
      action: { label: 'Open Auto Assignment', to: '/leads/assignment' },
      code: null,
    },
    {
      key: 'ack',
      title: 'Acknowledge the guest automatically',
      body: asg.ackEnabled
        ? 'Every assigned lead gets a WhatsApp confirmation naming the person who will call.'
        : 'A guest who hears nothing for an hour assumes nobody saw their enquiry. This sends the confirmation the moment the lead is assigned.',
      status: asg.ackEnabled ? 'ok' : 'todo',
      action: { label: 'Open Auto Assignment', to: '/leads/assignment' },
      code: null,
    },
  ];

  const done = items.filter((i) => i.status === 'ok').length;
  return ok(res, {
    progress: { done, total: items.length, pct: pct(done, items.length) },
    items,
    order: CLASSIFICATION_ORDER.map((o) => ({ ...o, label: channelMeta(o.channel).label, icon: channelMeta(o.channel).icon, color: channelMeta(o.channel).color })),
    health,
  });
});
