import XLSX from 'xlsx';
import { Query } from '../models/Query.js';
import { Destination } from '../models/Destination.js';
import { Comment } from '../models/Comment.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginate } from '../utils/apiResponse.js';
import { QUERY_STATUSES, QUERY_STATUS_VALUES } from '../constants/queryStatus.js';
import { Quote } from '../models/Quote.js';
import { User } from '../models/User.js';
import { logActivity } from './activity.controller.js';
import { sendWhatsAppTemplate, whatsappEnabled } from '../utils/whatsapp.js';
import { WhatsappTemplate } from '../models/WhatsappTemplate.js';
import { DEFAULT_WHATSAPP_TEMPLATES } from '../config/whatsappTemplates.js';
import { buildBodyValues, guestPhone, loadOrgProfile } from '../utils/templateContext.js';
import { resolveSessionId } from './whatsappConnection.controller.js';
import { assignLead } from './leadAssignment.controller.js';
import { env } from '../config/env.js';
import { ownScope, applyScope } from '../utils/ownScope.js';

const LABEL = Object.fromEntries(QUERY_STATUSES.map((s) => [s.value, s.label]));

// The starter catalog's enquiry acknowledgement. A tenant may edit its copy or switch it off,
// but the key is the stable handle the automatic send looks it up by.
const AUTO_ENQUIRY_KEY = 'enquiry_received';

const POPULATE = [
  { path: 'source', select: 'name' },
  { path: 'salesTeam', select: 'name' },
  { path: 'tags', select: 'name color' },
  { path: 'destinations', select: 'name country' },
  { path: 'owner', select: 'name email' },
];

function buildFilter(query, user) {
  const filter = {};

  // Status tab. 'all' (or missing) returns everything.
  if (query.status && query.status !== 'all') {
    if (!QUERY_STATUS_VALUES.includes(query.status)) {
      throw ApiError.badRequest(`Unknown status: ${query.status}`);
    }
    filter.status = query.status;
  }

  // Search by query number, guest name, or phone number.
  if (query.search) {
    const term = query.search.trim();
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const or = [{ 'guest.name': rx }, { 'guest.phones.number': rx }];
    const asNum = Number(term);
    if (!Number.isNaN(asNum)) or.push({ queryNumber: asNum });
    filter.$or = or;
  }

  // Comma-separated id lists → exact match (single) or $in (multiple).
  const idList = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const oneOrMany = (v) => { const ids = idList(v); return ids.length > 1 ? { $in: ids } : ids[0]; };
  const dateRange = (after, before) => {
    const r = {};
    if (after) r.$gte = new Date(after);
    if (before) r.$lte = new Date(new Date(before).setHours(23, 59, 59, 999));
    return r;
  };

  if (query.owner) filter.owner = oneOrMany(query.owner);
  if (query.salesTeam) filter.salesTeam = query.salesTeam;
  if (query.source) filter.source = oneOrMany(query.source);
  if (query.destination) filter.destinations = oneOrMany(query.destination);
  if (query.tags) filter.tags = { $in: idList(query.tags) };
  if (query.createdAfter || query.createdBefore) filter.createdAt = dateRange(query.createdAfter, query.createdBefore);
  if (query.startAfter || query.startBefore) filter.startDate = dateRange(query.startAfter, query.startBefore);

  // Sales reps only see their own queries unless they're managers/admins.
  if (user && ['sales', 'operations'].includes(user.role) && query.mine !== 'false') {
    // default scope: own queries
  }
  return filter;
}

/* ---- Automatic date-based stage rolling ----
   converted → on_trip once the start date arrives, and
   converted/on_trip → past once the trip has ended (start + nights).
   Runs lazily (throttled) whenever the trips list / stats are viewed. */
let lastRollAt = 0;
async function rollTripStatuses() {
  const now = Date.now();
  if (now - lastRollAt < 5 * 60 * 1000) return; // at most every 5 minutes
  lastRollAt = now;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Trip end = startDate + nights days (checkout day counts as still on trip).
  const endExpr = { $add: ['$startDate', { $multiply: [{ $ifNull: ['$nights', 0] }, 86400000] }] };
  try {
    await Query.updateMany(
      { status: { $in: ['converted', 'on_trip'] }, startDate: { $ne: null }, $expr: { $lt: [endExpr, today] } },
      { status: 'past' }
    );
    await Query.updateMany(
      { status: 'converted', startDate: { $ne: null, $lte: new Date() }, $expr: { $gte: [endExpr, today] } },
      { status: 'on_trip' }
    );
  } catch {
    /* non-fatal — the list still renders with current statuses */
  }
}

// GET /api/queries
export const listQueries = asyncHandler(async (req, res) => {
  await rollTripStatuses();
  // Non-admin/manager users see only trips they own or created.
  const filter = applyScope(buildFilter(req.query, req.user), ownScope(req.user));
  const sortParam = req.query.sort || '-createdAt';

  let items;
  let meta;
  if (sortParam === 'followupAsc' || sortParam === 'followupDesc') {
    // Follow-up date lives on Comment, not Query, so a field sort can't do it.
    // Rank all matching ids by their latest comment (no comment = oldest),
    // paginate the ranked ids, then fetch just that page.
    const allIds = (await Query.find(filter).select('_id')).map((d) => d._id);
    const rows = allIds.length
      ? await Comment.aggregate([
          { $match: { query: { $in: allIds } } },
          { $sort: { createdAt: -1 } },
          { $group: { _id: '$query', createdAt: { $first: '$createdAt' } } },
        ])
      : [];
    const at = Object.fromEntries(rows.map((r) => [String(r._id), new Date(r.createdAt).getTime()]));
    const dir = sortParam === 'followupAsc' ? 1 : -1;
    allIds.sort((a, b) => ((at[String(a)] || 0) - (at[String(b)] || 0)) * dir);
    meta = paginate(req.query, allIds.length);
    const pageIds = allIds.slice(meta.skip, meta.skip + meta.limit);
    const order = new Map(pageIds.map((id, i) => [String(id), i]));
    items = await Query.find({ _id: { $in: pageIds } }).populate(POPULATE);
    items.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
  } else {
    const total = await Query.countDocuments(filter);
    meta = paginate(req.query, total);
    items = await Query.find(filter)
      .populate(POPULATE)
      .sort(sortParam)
      .skip(meta.skip)
      .limit(meta.limit);
  }

  // Latest comment per query, for the list's Follow-up column.
  const ids = items.map((i) => i._id);
  let lastByQuery = {};
  const quoteByQuery = {};
  if (ids.length) {
    const rows = await Comment.aggregate([
      { $match: { query: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$query', body: { $first: '$body' }, createdAt: { $first: '$createdAt' }, createdBy: { $first: '$createdBy' } } },
    ]);
    const userIds = [...new Set(rows.map((r) => String(r.createdBy)).filter((v) => v && v !== 'undefined'))];
    const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('name') : [];
    const nameOf = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
    lastByQuery = Object.fromEntries(rows.map((r) => [String(r._id), { body: r.body, createdAt: r.createdAt, by: nameOf[String(r.createdBy)] || '' }]));

    // Latest quote per query — amount, author and time for the list cards.
    const quotes = await Quote.find({ query: { $in: ids } })
      .select('query pricing.total createdAt createdBy')
      .sort('-createdAt')
      .populate('createdBy', 'name');
    for (const qt of quotes) {
      const k = String(qt.query);
      if (!quoteByQuery[k]) quoteByQuery[k] = { total: qt.pricing?.total || 0, createdAt: qt.createdAt, by: qt.createdBy?.name || '' };
    }
  }
  const out = items.map((i) => {
    const o = i.toObject({ virtuals: true });
    o.lastComment = lastByQuery[String(i._id)] || null;
    o.latestQuote = quoteByQuery[String(i._id)] || null;
    return o;
  });
  return ok(res, out, meta);
});

// GET /api/queries/stats  — counts per pipeline status (for the sidebar tabs)
export const queryStats = asyncHandler(async (req, res) => {
  await rollTripStatuses();
  const scope = ownScope(req.user);
  const rows = await Query.aggregate([
    ...(Object.keys(scope).length ? [{ $match: scope }] : []),
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const counts = QUERY_STATUSES.map((s) => ({
    ...s,
    count: byStatus[s.value] || 0,
  }));
  const all = rows.reduce((sum, r) => sum + r.count, 0);
  return ok(res, { counts, all });
});

// GET /api/queries/:id
export const getQuery = asyncHandler(async (req, res) => {
  const item = await Query.findById(req.params.id)
    .populate(POPULATE)
    .populate('createdBy', 'name');
  if (!item) throw ApiError.notFound('Query not found');
  return ok(res, item);
});

// POST /api/queries
// Fires the enquiry acknowledgement for a freshly created query.
//
// Deliberately total: a WhatsApp problem must never fail the enquiry the agent just entered,
// so every outcome — off, not configured, no template, no phone, Gallabox refusing — is
// reported back as a reason instead of thrown. The reason rides along in the create response
// so the agent is told the guest was NOT messaged, rather than assuming they were.
async function autoAcknowledgeEnquiry(query, userId) {
  if (!env.whatsapp.autoEnquiry) return { sent: false, reason: 'disabled' };
  if (!whatsappEnabled()) return { sent: false, reason: 'not_configured' };

  // A tenant's own copy wins when it exists, including the decision to switch it off — so the
  // row is read regardless of isActive and only then judged. An organization that simply never
  // seeded this template (every org created before it was added to the catalog) falls back to
  // the starter copy, rather than silently never acknowledging an enquiry until someone presses
  // "Restore defaults".
  const stored = await WhatsappTemplate.findOne({ key: AUTO_ENQUIRY_KEY }).lean();
  if (stored && !stored.isActive) return { sent: false, reason: 'switched_off' };
  const template = stored || DEFAULT_WHATSAPP_TEMPLATES.find((t) => t.key === AUTO_ENQUIRY_KEY);
  if (!template) return { sent: false, reason: 'no_template' };
  // A template that mints a customer document link needs the agent-driven flow; the
  // acknowledgement is not supposed to carry one, but a tenant may have edited it to.
  if (template.needs?.kind) return { sent: false, reason: 'needs_document_link' };

  const phone = guestPhone(query);
  if (!phone) return { sent: false, reason: 'no_phone' };

  // Which number the guest hears from: this organization's own linked handset. Reported rather
  // than substituted when none is linked — messaging a guest from another company's number
  // would be worse than not messaging them.
  const sessionId = env.whatsapp.provider === 'openwa' ? await resolveSessionId() : undefined;
  if (env.whatsapp.provider === 'openwa' && !sessionId) return { sent: false, reason: 'not_linked' };

  const org = await loadOrgProfile();
  const { bodyValues, unresolved } = buildBodyValues(template, { query, org });
  // Gallabox rejects a template whose placeholders are not all supplied, and a first-contact
  // message with holes in it is worse than none — so report rather than send a partial.
  if (unresolved.length) return { sent: false, reason: 'unresolved', unresolved };

  try {
    const result = await sendWhatsAppTemplate({
      phone,
      name: [query.guest?.salutation, query.guest?.name].filter(Boolean).join(' ') || 'Guest',
      templateName: template.name,
      bodyValues,
      // Carried for the OpenWA transport, which sends the finished text rather than naming an
      // approved template. Gallabox ignores it and uses the copy approved on its side.
      body: template.body,
      sessionId,
    });
    await logActivity(query._id, userId, `sent WhatsApp template "${template.name}" automatically`, 'note');
    return { sent: true, ...result };
  } catch (err) {
    // Logged on the trip too: an acknowledgement that silently never went is the failure
    // mode an agent would otherwise discover from the guest.
    await logActivity(query._id, userId, `automatic WhatsApp acknowledgement failed: ${err.message}`, 'note');
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

export const createQuery = asyncHandler(async (req, res) => {
  if (!req.body.startDate) throw ApiError.badRequest('Start Date is required');
  // Whether the agent picked an owner matters to routing: an explicit choice is a decision and
  // must not be overridden, while the default (whoever typed it in) is just a placeholder that
  // the assignment rules are allowed to replace.
  const ownerChosen = !!req.body.owner;
  const payload = {
    ...req.body,
    createdBy: req.user._id,
    owner: req.body.owner || req.user._id,
  };
  const item = await Query.create(payload);
  await logActivity(item._id, req.user._id, 'created the query', 'created');
  let populated = await item.populate(POPULATE);

  // Route it, unless the agent named an owner themselves. Total by design — a routing problem
  // reports back as a reason and never fails the enquiry that was just typed in.
  let assignment = null;
  if (!ownerChosen) {
    assignment = await assignLead(populated, { actor: req.user._id });
    if (assignment.assigned) populated = await Query.findById(item._id).populate(POPULATE);
  } else {
    assignment = { assigned: false, reason: 'owner_chosen', reasons: ['Owner was chosen by hand on the form.'] };
  }

  // Populated first: the acknowledgement names the destination, which is a ref.
  const whatsapp = await autoAcknowledgeEnquiry(populated, req.user._id);
  return created(res, { ...populated.toObject(), whatsapp, assignment });
});

// --- CSV bulk upload ---
// Hand-rolled CSV parser (RFC-4180-ish) — avoids xlsx coercing values like
// a "6,8" children cell into the number 68.
function parseCsvText(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
function rowMap(row) {
  const o = {};
  for (const k of Object.keys(row)) o[normKey(k)] = row[k];
  return o;
}
function parseCsvDate(s) {
  if (s == null || s === '') return undefined;
  const str = String(s).trim();
  const m = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/); // DD-MM-YYYY
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    return Number.isNaN(dt.getTime()) ? undefined : dt;
  }
  const dt = new Date(str);
  return Number.isNaN(dt.getTime()) ? undefined : dt;
}
async function resolveDestinations(namesStr, cache) {
  const names = String(namesStr || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const ids = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (cache.has(key)) { ids.push(cache.get(key)); continue; }
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let d = await Destination.findOne({ name: new RegExp(`^${esc}$`, 'i') });
    if (!d) d = await Destination.create({ name, region: 'Imported' });
    cache.set(key, d._id);
    ids.push(d._id);
  }
  return ids;
}

// POST /api/queries/upload-csv  (multipart: file, optional source, owner)
export const uploadQueriesCsv = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('File field is required');
  let rows;
  try {
    const name = req.file.originalname || '';
    if (/\.(xlsx|xls)$/i.test(name)) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
    } else {
      const matrix = parseCsvText(req.file.buffer.toString('utf8')).filter((r) => r.some((c) => String(c).trim() !== ''));
      const headers = (matrix[0] || []).map((h) => String(h).trim());
      rows = matrix.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ''])));
    }
  } catch {
    throw ApiError.badRequest('Could not read the CSV file');
  }
  if (!rows.length) throw ApiError.badRequest('The file has no data rows');

  const destCache = new Map();
  const createdNumbers = [];
  const errors = [];
  let rowNum = 1; // header = row 1

  for (const raw of rows) {
    rowNum += 1;
    const r = rowMap(raw);
    if (!r.destination && !r.guestname && !r.phonenumber && !r.tripid) continue; // blank row
    try {
      const destinations = await resolveDestinations(r.destination, destCache);
      const children = String(r.children || '')
        .split(/[,;]/).map((s) => s.trim()).filter(Boolean)
        .map((a) => ({ age: Number(a) || 0 }));
      const phones = r.phonenumber
        ? [{ countryCode: '91', number: String(r.phonenumber).trim(), isPrimary: true }]
        : [];
      const q = await Query.create({
        source: req.body.source || undefined,
        owner: req.body.owner || req.user._id,
        createdBy: req.user._id,
        referenceId: r.tripid ? String(r.tripid).trim() : undefined,
        destinations,
        startDate: parseCsvDate(r.startdate),
        nights: Number(r.noofnights) || 0,
        pax: { adults: Number(r.noofadults) || 1, children },
        guest: {
          name: r.guestname ? String(r.guestname).trim() : undefined,
          email: r.email ? String(r.email).trim() : undefined,
          phones,
        },
        comments: r.comments ? String(r.comments).trim() : undefined,
      });
      createdNumbers.push(q.queryNumber);
    } catch (e) {
      errors.push({ row: rowNum, error: e.message });
    }
  }

  return ok(res, { created: createdNumbers.length, queryNumbers: createdNumbers, errors, totalRows: rows.length });
});

const CONVERTED_STATUSES = ['converted', 'on_trip', 'past'];
const sameDay = (a, b) => (a ? new Date(a).toISOString().slice(0, 10) : '') === (b ? new Date(b).toISOString().slice(0, 10) : '');
const samePax = (a, b) => (a?.adults || 0) === (b?.adults || 0)
  && JSON.stringify((a?.children || []).map((c) => Number(c.age) || 0)) === JSON.stringify((b?.children || []).map((c) => Number(c.age) || 0));

// PUT /api/queries/:id
export const updateQuery = asyncHandler(async (req, res) => {
  // Once a trip is converted, its dates / nights / pax are owned by the
  // converted quote (the booking, instalments and hotel lines all follow
  // it). Editing them here would put the trip out of step again, so those
  // changes are refused with a pointer to the right place.
  const current = await Query.findById(req.params.id).select('status startDate nights pax');
  if (!current) throw ApiError.notFound('Query not found');
  if (CONVERTED_STATUSES.includes(current.status)) {
    const wantsStart = req.body.startDate !== undefined && !sameDay(req.body.startDate, current.startDate);
    const wantsNights = req.body.nights !== undefined && Number(req.body.nights) !== current.nights;
    const wantsPax = req.body.pax !== undefined && !samePax(req.body.pax, current.pax);
    if (wantsStart || wantsNights || wantsPax) {
      throw ApiError.badRequest('This trip is converted: change its dates, nights or pax on the converted quote (All Quotes → Edit Quote). The trip, booking and hotel lines follow that quote.');
    }
    delete req.body.startDate;
    delete req.body.nights;
    delete req.body.pax;
  }

  const item = await Query.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  }).populate(POPULATE);
  if (!item) throw ApiError.notFound('Query not found');
  // Keep open quotes in step with the trip's edited basics — start date,
  // duration and traveller count flow into draft/sent quotes (via save() so
  // pricing recomputes and the itinerary tops up new days). Accepted
  // (converted) quotes keep the configuration they were sold with.
  if (req.body.pax || req.body.nights !== undefined || req.body.startDate !== undefined) {
    const openQuotes = await Quote.find({ query: item._id, status: { $in: ['draft', 'sent'] } });
    for (const qt of openQuotes) {
      if (req.body.pax) qt.pax = item.pax;
      if (req.body.nights !== undefined) qt.nights = item.nights;
      if (req.body.startDate !== undefined) qt.startDate = item.startDate;
      await qt.save();
    }
  }
  return ok(res, item);
});

// PATCH /api/queries/:id/status
// Lifecycle rules: a query is dropped only *before* conversion; cancelled only *after*.
const BEFORE_CONVERT = ['new_query', 'in_progress'];
const AFTER_CONVERT = ['converted', 'on_trip'];

export const updateStatus = asyncHandler(async (req, res) => {
  const { status, lostReason, reminderOn } = req.body;
  if (!QUERY_STATUS_VALUES.includes(status)) {
    throw ApiError.badRequest(`Unknown status: ${status}`);
  }

  const current = await Query.findById(req.params.id);
  if (!current) throw ApiError.notFound('Query not found');

  if (status === 'dropped' && !BEFORE_CONVERT.includes(current.status)) {
    throw ApiError.badRequest('A query can only be dropped before it is converted.');
  }
  if (status === 'canceled' && !AFTER_CONVERT.includes(current.status)) {
    throw ApiError.badRequest('A trip can only be cancelled after it is converted.');
  }

  const update = { status };
  if (['canceled', 'dropped'].includes(status) && lostReason) update.lostReason = lostReason;
  if (reminderOn !== undefined) update.reminderOn = reminderOn || undefined;
  const item = await Query.findByIdAndUpdate(req.params.id, update, { new: true }).populate(
    POPULATE
  );
  if (current.status !== status) {
    await logActivity(item._id, req.user._id, `updated stage from ${LABEL[current.status] || current.status} to ${LABEL[status] || status}`, 'stage');
  }
  return ok(res, item);
});

// DELETE /api/queries/:id  (admin/manager)
export const deleteQuery = asyncHandler(async (req, res) => {
  const item = await Query.findByIdAndDelete(req.params.id);
  if (!item) throw ApiError.notFound('Query not found');
  return ok(res, { id: req.params.id });
});

// POST /api/queries/:id/whatsapp-template  { templateName, bodyValues }
// Sends any approved Gallabox template to the trip's guest. Trip-scoped
// (rather than per-instalment) so every stage template — quotation,
// follow-up, confirmation, travel documents, review — sends the same way.
export const sendQueryWhatsAppTemplate = asyncHandler(async (req, res) => {
  const query = await Query.findById(req.params.id).select('guest queryNumber');
  if (!query) throw ApiError.notFound('Query not found');

  const { templateName, bodyValues } = req.body;
  if (!String(templateName || '').trim()) throw ApiError.badRequest('Template name is required');

  const phone0 = (query.guest?.phones || []).find((p) => p.isPrimary) || query.guest?.phones?.[0];
  const phone = phone0 ? `${phone0.countryCode || '91'}${phone0.number || ''}` : '';
  if (!phone) throw ApiError.badRequest('This trip has no guest phone number to message');
  const guestName = [query.guest?.salutation, query.guest?.name].filter(Boolean).join(' ') || 'Guest';

  // The OpenWA transport sends finished text, so it needs the copy this name refers to. Looked
  // up server-side rather than trusted from the client: the body that reaches a guest must be
  // the tenant's stored template, not whatever a request body happened to carry. Falls back to
  // the starter catalog for a template the organization never seeded.
  const stored = await WhatsappTemplate.findOne({ name: templateName }).select('body').lean();
  const body = stored?.body || DEFAULT_WHATSAPP_TEMPLATES.find((t) => t.name === templateName)?.body;

  const result = await sendWhatsAppTemplate({
    phone,
    name: guestName,
    templateName,
    bodyValues,
    body,
    sessionId: env.whatsapp.provider === 'openwa' ? await resolveSessionId() : undefined,
  });
  await logActivity(query._id, req.user._id, `sent WhatsApp template "${templateName}"`, 'note');
  return ok(res, { sent: true, ...result });
});
