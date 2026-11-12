import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Quote, pruneStaleAutoLines } from '../models/Quote.js';
import { Query } from '../models/Query.js';
import { InclusionExclusion } from '../models/InclusionExclusion.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { renderQuotation } from '../pdf/renderQuotation.js';
import { voucherHtml } from '../pdf/voucherHtml.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { htmlToPdf } from '../pdf/renderPdf.js';
import { sendMail, emailEnabled } from '../utils/mailer.js';
import { sendWhatsAppText, whatsappEnabled } from '../utils/whatsapp.js';
import { env } from '../config/env.js';
import { resolveSessionId } from './whatsappConnection.controller.js';
import { company } from '../config/company.js';
import { logActivity } from './activity.controller.js';
import { syncBookingFromQuote } from '../utils/bookingSync.js';
import { resyncServiceBookings } from './serviceBooking.controller.js';

// A converted quote is the contract behind its booking. After an in-place
// edit, push the change onto the booking, its unpaid instalments and the
// service booking lines, and note it in the trip's activity feed (in-place
// edits are otherwise invisible there).
async function afterConvertedEdit(quote, userId) {
  const sync = await syncBookingFromQuote(quote, userId);
  const inr = (n) => `${quote.currency || 'INR'} ${Math.round(n || 0).toLocaleString('en-IN')}`;
  let msg = `updated converted quote #${quote.quoteNumber} in place`;
  if (sync && sync.before.total !== sync.after.total) {
    msg += `: package price ${inr(sync.before.total)} → ${inr(sync.after.total)}; booking total and unpaid instalments adjusted`;
  } else if (sync) {
    msg += ` (package price unchanged at ${inr(sync.after.total)})`;
  }
  if (sync?.tripChanged && sync.basics?.startDate) {
    const when = new Date(sync.basics.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    msg += `; trip dates set to ${when}${sync.basics.nights != null ? `, ${sync.basics.nights}N` : ''}`;
  }
  if (sync) {
    // Service lines are derived from the quote too; keep them in step. A
    // failure here must not roll back the quote edit itself.
    const s = await resyncServiceBookings(quote.query, quote._id, userId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[quote] service booking re-sync failed for quote ${quote._id}:`, err);
      return null;
    });
    if (s && (s.added || s.updated || s.removed || s.flagged)) {
      const parts = [];
      if (s.updated) parts.push(`${s.updated} updated`);
      if (s.added) parts.push(`${s.added} added`);
      if (s.removed) parts.push(`${s.removed} removed`);
      if (s.flagged) parts.push(`${s.flagged} flagged for review`);
      msg += `; service bookings: ${parts.join(', ')}`;
    }
  }
  await logActivity(quote.query, userId, msg, 'quote');
}

const POPULATE = [
  { path: 'days.destination', select: 'name' },
  // The quotation prints whoever built it as the guest's holiday consultant, so their phone
  // is needed too — a consultant block with a name and no number is a dead end for the guest.
  { path: 'createdBy', select: 'name phone email' },
];

// Reflect a quote's value onto its parent query for the pipeline/reports.
async function syncQuery(queryId) {
  const latest = await Quote.findOne({ query: queryId }).sort('-createdAt');
  const accepted = await Quote.findOne({ query: queryId, status: 'accepted' }).sort('-updatedAt');
  await Query.findByIdAndUpdate(queryId, {
    quotedAmount: latest?.pricing?.total || 0,
    ...(accepted
      ? { bookedAmount: accepted.pricing.total, profit: accepted.pricing.markup || 0 }
      : { bookedAmount: 0, profit: 0 }),
  });
}

// GET /api/quotes?query=<id>
export const listQuotes = asyncHandler(async (req, res) => {
  if (!req.query.query) throw ApiError.badRequest('query id is required');
  const quotes = await Quote.find({ query: req.query.query }).sort('-createdAt');
  return ok(res, quotes);
});

// GET /api/quotes/suggestions?search=&exclude=<queryId>&limit=
// Recent quotes across all trips, used as starting points for a new quote.
// search matches trip number or guest name.
export const quoteSuggestions = asyncHandler(async (req, res) => {
  const { search, exclude } = req.query;
  const limit = Math.min(Number(req.query.limit) || 6, 20);

  const filter = {};
  if (exclude) filter.query = { $ne: exclude };
  // Suggest only quotes of the same trip duration; an explicit search overrides this.
  if (req.query.nights && !search?.trim()) filter.nights = Number(req.query.nights);
  if (search?.trim()) {
    const term = search.trim();
    const or = [{ 'guest.name': new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    const num = Number(term.replace(/\D/g, ''));
    if (num) or.push({ queryNumber: num });
    const matches = await Query.find({ $or: or }).select('_id').limit(100);
    filter.query = { ...(filter.query || {}), $in: matches.map((q) => q._id) };
  }

  const quotes = await Quote.find(filter)
    .sort('-createdAt')
    .limit(limit)
    .populate({ path: 'query', select: 'queryNumber guest destinations nights', populate: { path: 'destinations', select: 'name' } });
  return ok(res, quotes);
});

// POST /api/quotes/:id/clone  { query: <target trip id> }
// Copies an existing quote onto another trip as a fresh draft.
export const cloneQuote = asyncHandler(async (req, res) => {
  const source = await Quote.findById(req.params.id);
  if (!source) throw ApiError.notFound('Source quote not found');
  const target = await Query.findById(req.body.query);
  if (!target) throw ApiError.badRequest('Target trip not found');

  const src = source.toObject();
  // Drop subdocument _ids so Mongoose assigns fresh ones on the copy.
  const stripIds = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k === '_id' ? undefined : val)));

  const quote = await Quote.create({
    query: target._id,
    title: src.title,
    currency: src.currency || target.currency || 'INR',
    startDate: target.startDate || src.startDate,
    nights: target.nights ?? src.nights,
    pax: target.pax || src.pax,
    packages: stripIds(src.packages || []),
    pricingStrategy: src.pricingStrategy,
    totalFoc: src.totalFoc,
    selectedPackageIndex: src.selectedPackageIndex,
    inclusions: src.inclusions,
    exclusions: src.exclusions,
    terms: src.terms,
    createdBy: req.user._id,
  });
  await syncQuery(target._id);
  await logActivity(target._id, req.user._id, `created quote from suggestion #${src.quoteNumber}`, 'quote');
  if (target.status === 'new_query') {
    await Query.findByIdAndUpdate(target._id, { status: 'in_progress' });
    await logActivity(target._id, req.user._id, 'updated stage from New Query to In Progress', 'stage');
  }
  return created(res, quote);
});

// GET /api/quotes/:id
export const getQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id)
    .populate(POPULATE)
    .populate({ path: 'query', select: 'queryNumber guest destinations nights startDate pax', populate: { path: 'destinations', select: 'name' } });
  if (!quote) throw ApiError.notFound('Quote not found');
  return ok(res, quote);
});

// POST /api/quotes
export const createQuote = asyncHandler(async (req, res) => {
  const query = await Query.findById(req.body.query);
  if (!query) throw ApiError.badRequest('Parent query not found');

  const quote = await Quote.create({
    ...req.body,
    createdBy: req.user._id,
    // Snapshot trip basics from the query if not supplied
    startDate: req.body.startDate || query.startDate,
    nights: req.body.nights ?? query.nights,
    pax: req.body.pax || query.pax,
    currency: req.body.currency || query.currency || 'INR',
  });
  await syncQuery(query._id);
  await logActivity(query._id, req.user._id, `gave quote with ${quote.currency} ${(quote.pricing?.total || 0).toLocaleString('en-IN')}`, 'quote');
  // Building the first quotation moves a brand-new lead into the In Progress stage.
  if (query.status === 'new_query') {
    await Query.findByIdAndUpdate(query._id, { status: 'in_progress' });
    await logActivity(query._id, req.user._id, 'updated stage from New Query to In Progress', 'stage');
  }
  warmQuotePdfCache(quote._id, req.organizationId);
  return created(res, quote);
});

// PUT /api/quotes/:id
// Package the itinerary is built from (the selected option).
const selPkg = (q) => (q?.packages || [])[q?.selectedPackageIndex || 0] || (q?.packages || [])[0] || null;
const plain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : v);

// Assign edited fields; when services change on a hand-customised itinerary,
// drop the day lines auto-written from services that are no longer there.
function applyQuoteEdits(quote, body, fields) {
  const prevPkg = quote.daysCustomized ? plain(selPkg(quote)) : null;
  for (const f of fields) if (body[f] !== undefined) quote[f] = body[f];
  if (prevPkg && body.days === undefined && (body.packages !== undefined || body.selectedPackageIndex !== undefined)) {
    const days = (quote.days || []).map((d) => ({ ...plain(d) }));
    quote.days = pruneStaleAutoLines(days, prevPkg, plain(selPkg(quote)));
  }
}

export const updateQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) throw ApiError.notFound('Quote not found');

  // Assign fields then save() so pre-validate pricing hook runs.
  const fields = [
    'title', 'currency', 'startDate', 'nights', 'pax', 'days', 'costItems',
    'markupType', 'markupValue', 'taxPercent', 'inclusions', 'exclusions', 'terms', 'status',
    'packages', 'pricingStrategy', 'totalFoc', 'selectedPackageIndex', 'daysCustomized',
  ];
  applyQuoteEdits(quote, req.body, fields);
  await quote.save();
  await syncQuery(quote.query);
  if (quote.status === 'accepted') await afterConvertedEdit(quote, req.user._id);
  warmQuotePdfCache(quote._id, req.organizationId);
  return ok(res, quote);
});

// POST /api/quotes/:id/revise — editing a quotation saves it as a NEW
// quotation (Sembark behaviour): the original stays in All Quotes as
// history and the revision becomes the trip's latest quote.
export const reviseQuote = asyncHandler(async (req, res) => {
  const source = await Quote.findById(req.params.id);
  if (!source) throw ApiError.notFound('Quote not found');

  // A converted (accepted) quote is bound to the live booking — it updates
  // in place no matter which endpoint the client called, so a stale bundle
  // can never spawn a duplicate of a sold quote.
  if (source.status === 'accepted') {
    const fields = [
      'title', 'currency', 'startDate', 'nights', 'pax', 'days', 'costItems',
      'markupType', 'markupValue', 'taxPercent', 'inclusions', 'exclusions', 'terms',
      'packages', 'pricingStrategy', 'totalFoc', 'selectedPackageIndex', 'daysCustomized',
    ];
    applyQuoteEdits(source, req.body, fields);
    await source.save();
    await syncQuery(source.query);
    await afterConvertedEdit(source, req.user._id);
    warmQuotePdfCache(source._id, req.organizationId);
    return ok(res, source);
  }

  const src = source.toObject();
  // Drop subdocument _ids so Mongoose assigns fresh ones on the copy.
  const stripIds = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k === '_id' ? undefined : val)));
  // The builder sends freshly-picked refs as FULL master documents (a hotel/
  // activity object, not an id). stripIds would delete their _id too, leaving
  // an uncastable object — collapse every ref to its id first.
  const refId = (v) => (v && typeof v === 'object' ? v._id || v.id || undefined : v);
  const normalizePackages = (pkgs) => (pkgs || []).map((p) => ({
    ...p,
    hotels: (p.hotels || []).map((h) => ({ ...h, hotel: refId(h.hotel) })),
    transports: (p.transports || []).map((t) => ({ ...t, service: refId(t.service) })),
    activities: (p.activities || []).map((a) => ({ ...a, activity: refId(a.activity) })),
  }));

  const quote = await Quote.create({
    query: src.query,
    title: req.body.title ?? src.title,
    currency: req.body.currency || src.currency || 'INR',
    startDate: req.body.startDate ?? src.startDate,
    nights: req.body.nights ?? src.nights,
    pax: req.body.pax || src.pax,
    packages: stripIds(normalizePackages(req.body.packages ?? src.packages ?? [])),
    pricingStrategy: req.body.pricingStrategy ?? src.pricingStrategy,
    totalFoc: req.body.totalFoc ?? src.totalFoc,
    selectedPackageIndex: req.body.selectedPackageIndex ?? src.selectedPackageIndex,
    inclusions: req.body.inclusions ?? src.inclusions,
    exclusions: req.body.exclusions ?? src.exclusions,
    terms: req.body.terms ?? src.terms,
    // A hand-customized itinerary survives the revision.
    ...(src.daysCustomized ? { days: pruneStaleAutoLines(stripIds(src.days || []), selPkg(src), selPkg({ packages: req.body.packages ?? src.packages, selectedPackageIndex: req.body.selectedPackageIndex ?? src.selectedPackageIndex })), daysCustomized: true } : {}),
    createdBy: req.user._id,
  });
  await syncQuery(src.query);
  await logActivity(src.query, req.user._id, `revised quote #${src.quoteNumber} into new quote #${quote.quoteNumber} with ${quote.currency} ${(quote.pricing?.total || 0).toLocaleString('en-IN')}`, 'quote');
  warmQuotePdfCache(quote._id, req.organizationId);
  return created(res, quote);
});

// PATCH /api/quotes/:id/status
export const updateQuoteStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['draft', 'sent', 'accepted', 'rejected'].includes(status)) {
    throw ApiError.badRequest('Invalid status');
  }
  const quote = await Quote.findById(req.params.id);
  if (!quote) throw ApiError.notFound('Quote not found');
  quote.status = status;
  await quote.save();

  // Accepting a quote converts the query. Only one quote per trip can be
  // accepted — demote any previously accepted quote back to 'sent'.
  if (status === 'accepted') {
    await Quote.updateMany({ query: quote.query, _id: { $ne: quote._id }, status: 'accepted' }, { status: 'sent' });
    await Query.findByIdAndUpdate(quote.query, { status: 'converted' });
  }
  await syncQuery(quote.query);
  warmQuotePdfCache(quote._id, req.organizationId);
  return ok(res, quote);
});

// Load a quote fully populated for the PDF / email.
export async function loadFullQuote(id) {
  const quote = await Quote.findById(id)
    .populate(POPULATE)
    .populate({ path: 'query', select: 'queryNumber guest destinations nights startDate pax', populate: { path: 'destinations', select: 'name' } })
    .populate({ path: 'packages.hotels.hotel', select: 'name imageUrl detailsLink address notes stars' })
    .populate({ path: 'packages.transports.service', select: 'startCity endCity imageUrl items.name items.description items.imageUrl' })
    // ticketTypes.imageUrl matters: each ferry operator/class carries its own
    // boat photo, which the itinerary prefers over the activity-level image.
    .populate({ path: 'packages.activities.activity', select: 'name imageUrl details ticketTypes.name ticketTypes.details ticketTypes.imageUrl ticketTypes.forService' });
  if (!quote) throw ApiError.notFound('Quote not found');
  // Fill dynamic defaults from the Inclusions/Exclusions master when the quote
  // has no lists of its own (config defaults remain the last-resort fallback).
  if (!quote.inclusions?.length || !quote.exclusions?.length) {
    const items = await InclusionExclusion.find({ isActive: { $ne: false } }).sort('order createdAt').lean();
    if (items.length) {
      if (!quote.inclusions?.length) quote.inclusions = items.filter((i) => i.type === 'inclusion').map((i) => i.text);
      if (!quote.exclusions?.length) quote.exclusions = items.filter((i) => i.type === 'exclusion').map((i) => i.text);
    }
  }
  return quote;
}

// GET /api/quotes/:id/voucher?type=trip|hotels|activity&format=html|pdf
// Booking vouchers for the Docs tab. `format=html` returns the document HTML
// for the on-screen preview; default renders the PDF.
export const quoteVoucher = asyncHandler(async (req, res) => {
  const quote = await loadFullQuote(req.params.id);
  const org = await OrgProfile.getFor(req.organizationId).catch(() => null);
  const on = (v) => v === '1' || v === 'true';
  const html = voucherHtml(quote.toObject(), {
    org: org?.toObject(),
    type: ['trip', 'hotels', 'activity'].includes(req.query.type) ? req.query.type : 'trip',
    options: {
      prices: on(req.query.prices),
      removeBranding: on(req.query.removeBranding),
      removeItinerary: on(req.query.removeItinerary),
      bankAccount: on(req.query.bankAccount),
      tnc: req.query.tnc == null ? true : on(req.query.tnc),
    },
  });
  if (req.query.format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }
  const pdf = await htmlToPdf(html);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="TRIP-ID-${quote.query?.queryNumber || quote.quoteNumber}-VOUCHER.pdf"`);
  return res.send(pdf);
});

/* ---- rendered-PDF cache ----
   The quotation only changes when the quote (or the org branding) changes, so
   the finished PDF is cached on disk keyed by both timestamps. A repeat
   download skips image fetching AND Chrome entirely and streams the file —
   the difference between ~5s and instant. Same directory as the image cache,
   so PDF_CACHE_DIR governs persistence for both. */
const pdfCacheDir = process.env.PDF_CACHE_DIR || path.join(os.tmpdir(), 'tcrm-img-cache');

function quotePdfCacheFile(quote, org) {
  // Bump RENDER_VERSION when the template or bundled assets change, so cached
  // PDFs from the older look are re-rendered.
  // v20: the document became per-organization (palette, destination cover banner, Terms).
  const RENDER_VERSION = 'v20';
  const stamp = crypto.createHash('sha1')
    .update(RENDER_VERSION)
    .update(String(quote._id))
    .update(String(new Date(quote.updatedAt || 0).getTime()))
    .update(String(new Date(org?.updatedAt || 0).getTime()))
    .digest('hex').slice(0, 16);
  return path.join(pdfCacheDir, `quote-${quote._id}-${stamp}.pdf`);
}

function writeQuotePdfCache(cacheFile, quoteId, pdf) {
  try {
    fs.mkdirSync(pdfCacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, pdf);
    // Drop renders of older versions of this quote.
    const prefix = `quote-${quoteId}-`;
    for (const f of fs.readdirSync(pdfCacheDir)) {
      if (f.startsWith(prefix) && path.join(pdfCacheDir, f) !== cacheFile) {
        fs.unlinkSync(path.join(pdfCacheDir, f));
      }
    }
  } catch { /* cache is best-effort */ }
}

/* Pre-warm: build the quotation PDF in the background right after a quote is
   saved, so the first download after an edit is served from cache like a
   static file instead of waiting ~5s for Chrome. Debounced per quote so a
   burst of consecutive saves renders once. Failures only cost the warm-up —
   the download endpoint still renders on demand. */
const warmTimers = new Map();
export function warmQuotePdfCache(quoteId, organizationId) {
  const key = String(quoteId);
  clearTimeout(warmTimers.get(key));
  warmTimers.set(key, setTimeout(async () => {
    warmTimers.delete(key);
    try {
      const quote = await loadFullQuote(key);
      const org = await OrgProfile.getFor(organizationId).catch(() => null);
      const cacheFile = quotePdfCacheFile(quote, org);
      if (fs.existsSync(cacheFile)) return;
      const t0 = Date.now();
      const pdf = await htmlToPdf(renderQuotation(quote.toObject(), org?.toObject()));
      writeQuotePdfCache(cacheFile, quote._id, pdf);
      console.log(`[pdf] pre-warmed quote #${quote.quoteNumber} in ${Date.now() - t0}ms`);
    } catch (e) {
      console.warn(`[pdf] pre-warm failed for quote ${key}:`, e.message);
    }
  }, 2000));
}

// GET /api/quotes/:id/pdf — server-rendered PDF (inline download).
// `?format=html` returns the document HTML instead, so the on-screen
// quotation preview shows EXACTLY what the PDF will look like.
export const quotePdf = asyncHandler(async (req, res) => {
  const quote = await loadFullQuote(req.params.id);
  const org = await OrgProfile.getFor(req.organizationId).catch(() => null);
  if (req.query.format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderQuotation(quote.toObject(), org?.toObject()));
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Quotation-${quote.quoteNumber}.pdf"`);

  const cacheFile = quotePdfCacheFile(quote, org);
  try {
    if (fs.existsSync(cacheFile)) return res.send(fs.readFileSync(cacheFile));
  } catch { /* fall through to a fresh render */ }

  const pdf = await htmlToPdf(renderQuotation(quote.toObject(), org?.toObject()));
  writeQuotePdfCache(cacheFile, quote._id, pdf);
  return res.send(pdf);
});

// GET /api/quotes/email-status — whether SMTP is configured
export const emailStatus = asyncHandler(async (req, res) => ok(res, { enabled: emailEnabled() }));

// POST /api/quotes/:id/email — email the quotation PDF to the guest
export const emailQuote = asyncHandler(async (req, res) => {
  const quote = await loadFullQuote(req.params.id);
  const obj = quote.toObject();
  const to = req.body.email || obj.query?.guest?.email;
  if (!to) throw ApiError.badRequest('No recipient — guest has no email on file and none was provided');

  const org = await OrgProfile.getFor(req.organizationId).catch(() => null);
  const pdf = await htmlToPdf(renderQuotation(obj, org?.toObject()));
  const guestName = [obj.query?.guest?.salutation, obj.query?.guest?.name].filter(Boolean).join(' ') || 'Guest';
  await sendMail({
    to,
    subject: `Your Maldives Tour Quotation #${quote.quoteNumber} — ${company.name}`,
    html: `<p>Dear ${guestName},</p>
      <p>Thank you for your interest! Please find attached your tour quotation <b>#${quote.quoteNumber}</b>${obj.title ? ` (${obj.title})` : ''} totalling <b>₹${(obj.pricing?.total || 0).toLocaleString('en-IN')}</b>.</p>
      <p>To confirm your booking, a ${company.advancePercent}% advance is payable. We'd love to host you in the Maldives!</p>
      <p>Warm regards,<br/>${company.name}<br/>${company.phones[0]} · ${company.emails[0]}</p>`,
    attachments: [{ filename: `Quotation-${quote.quoteNumber}.pdf`, content: pdf }],
  });

  quote.status = 'sent';
  await quote.save();
  return ok(res, { sent: true, to, quoteNumber: quote.quoteNumber });
});

// POST /api/quotes/:id/share-email — email the composed Share Package summary
// (the HTML built in the share modal), optionally attaching the quotation PDF.
export const shareEmail = asyncHandler(async (req, res) => {
  const quote = await loadFullQuote(req.params.id);
  const obj = quote.toObject();
  const to = req.body.email || obj.query?.guest?.email;
  if (!to) throw ApiError.badRequest('No recipient — guest has no email on file and none was provided');
  const html = String(req.body.html || '').trim();
  if (!html) throw ApiError.badRequest('Nothing to send');

  const attachments = [];
  if (req.body.attachPdf) {
    const org = await OrgProfile.getFor(req.organizationId).catch(() => null);
    const pdf = await htmlToPdf(renderQuotation(obj, org?.toObject()));
    attachments.push({ filename: `Package-${quote.quoteNumber}.pdf`, content: pdf });
  }

  await sendMail({
    to,
    subject: req.body.subject || `Your Maldives Package #${quote.quoteNumber} — ${company.name}`,
    html,
    attachments,
  });

  if (quote.status === 'draft') {
    quote.status = 'sent';
    await quote.save();
  }
  return ok(res, { sent: true, to, quoteNumber: quote.quoteNumber });
});

// GET /api/quotes/whatsapp-status — whether the Gallabox WhatsApp API is configured
export const whatsappStatus = asyncHandler(async (req, res) => ok(res, { enabled: whatsappEnabled() }));

// POST /api/quotes/:id/whatsapp-share — send the composed Share Package text
// (built in the share modal) via the Gallabox WhatsApp Business API.
export const shareWhatsApp = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id)
    .populate({ path: 'query', select: 'queryNumber guest' });
  if (!quote) throw ApiError.notFound('Quote not found');

  const guest = quote.query?.guest || {};
  const phone = req.body.phone || (guest.phones?.[0] && `${guest.phones[0].countryCode || '91'}${guest.phones[0].number || ''}`);
  const text = String(req.body.text || '').trim();
  if (!text) throw ApiError.badRequest('Nothing to send');

  const result = await sendWhatsAppText({
    phone,
    name: guest.name,
    text,
    // This organization's own linked number, so the guest hears from the company they enquired with.
    sessionId: env.whatsapp.provider === 'openwa' ? await resolveSessionId() : undefined,
  });

  if (quote.status === 'draft') {
    quote.status = 'sent';
    await quote.save();
  }
  return ok(res, { sent: true, ...result });
});

// DELETE /api/quotes/:id
export const deleteQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findByIdAndDelete(req.params.id);
  if (!quote) throw ApiError.notFound('Quote not found');
  await syncQuery(quote.query);
  return ok(res, { id: req.params.id });
});
