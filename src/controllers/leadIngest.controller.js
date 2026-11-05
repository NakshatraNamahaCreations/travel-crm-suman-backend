import { LeadSettings } from '../models/LeadSettings.js';
import { Visitor } from '../models/Visitor.js';
import { Query } from '../models/Query.js';
import { QuerySource } from '../models/QuerySource.js';
import { Destination } from '../models/Destination.js';
import { TrackingLink } from '../models/TrackingLink.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { runWithTenant } from '../tenant/context.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { channelMeta } from '../config/leadChannels.js';
import { captureConfig, buildTouch, shouldAppendTouch, buildAttribution } from '../utils/leadAttribution.js';
import { buildTrackingScript } from '../utils/trackingScript.js';
import { assignLead } from './leadAssignment.controller.js';
import { logActivity } from './activity.controller.js';

/* These routes are mounted OUTSIDE the auth and tenant wall: a visitor's browser calls them
 * with no account. The ingest token in the URL IS the credential — it is looked up globally
 * (no tenant context, so tenantPlugin is a deliberate no-op), and everything after that runs
 * inside the organization it belongs to.
 *
 * Because anyone on the internet can reach these, every handler below assumes the body is
 * hostile: sizes are capped, ids are sanitized, and a visit is never allowed to create
 * anything other than a visitor row or a query. */

const DAY = 86400000;
const MAX_URL = 2048;
const MAX_TEXT = 2000;
const VISITOR_ID_RX = /^[A-Za-z0-9_-]{8,64}$/;

/** Resolves the token to its organization. Short tokens are rejected before the lookup so a
 *  blank or truncated value cannot match a row whose token was never set. */
async function tenantFor(token) {
  const t = String(token || '');
  if (t.length < 32 || !/^[a-f0-9]+$/i.test(t)) throw ApiError.notFound('Unknown tracking token');
  const settings = await LeadSettings.findOne({ ingestToken: t }).select('_id organization capture campaignPrefix ingestToken assignment');
  if (!settings) throw ApiError.notFound('Unknown tracking token');
  return settings;
}

const clip = (v, n = MAX_TEXT) => String(v ?? '').slice(0, n).trim();

/** The caller's address, honouring one proxy hop. Used only for the ignore list and for
 *  rate-limit keying — never stored, because an IP is personal data we have no use for. */
function callerIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || '';
}

/** Office and team traffic the tenant asked to exclude. Prefix match, so "49.207." covers a
 *  whole range without needing CIDR parsing. */
function isIgnoredIp(ip, list) {
  if (!ip || !list?.length) return false;
  const clean = ip.replace(/^::ffff:/, '');
  return list.some((p) => {
    const pat = String(p || '').trim();
    return pat && (clean === pat || clean.startsWith(pat.endsWith('.') ? pat : pat + '.'));
  });
}

/** Resolves the tracking link a visit came through, so a saved link can report its own leads. */
async function linkForTouch(touch) {
  if (!touch?.campaign) return null;
  const link = await TrackingLink.findOne({ campaign: touch.campaign }).select('_id').lean();
  return link?._id || null;
}

// POST /api/public/track/:token — one page view.
export const trackVisit = asyncHandler(async (req, res) => {
  const settings = await tenantFor(req.params.token);
  if (settings.capture?.enabled === false) return ok(res, { ignored: 'capture_off' });

  const ip = callerIp(req);
  if (isIgnoredIp(ip, settings.capture?.ignoreIps)) return ok(res, { ignored: 'ignored_ip' });

  const visitorId = clip(req.body?.visitorId, 64);
  if (!VISITOR_ID_RX.test(visitorId)) throw ApiError.badRequest('Missing or malformed visitor id');

  const url = clip(req.body?.url, MAX_URL);
  if (!url) throw ApiError.badRequest('A visit needs the page address');

  return runWithTenant(settings.organization, async () => {
    const config = captureConfig(settings);
    const { touch, channel } = buildTouch({
      url,
      referrer: clip(req.body?.referrer, MAX_URL),
      derived: {
        device: clip(req.body?.device, 80),
        ga_client_id: clip(req.body?.gaClientId, 80),
      },
      config,
    });
    touch.trackingLink = await linkForTouch(touch);

    const expiresAt = new Date(Date.now() + config.retentionDays * DAY);
    // Upsert first so a brand-new visitor and a returning one take the same path, then decide
    // whether this visit is a touch worth keeping.
    const visitor = await Visitor.findOneAndUpdate(
      { visitorId },
      {
        $setOnInsert: { visitorId, firstSeenAt: new Date(), touches: [] },
        $set: {
          lastSeenAt: new Date(),
          // Rolling expiry: a visitor who keeps coming back keeps their history, and one who
          // never returns is forgotten on the schedule the tenant chose.
          expiresAt,
          ...(req.body?.device ? { device: clip(req.body.device, 80) } : {}),
          ...(req.body?.gaClientId ? { gaClientId: clip(req.body.gaClientId, 80) } : {}),
        },
        $inc: { visitCount: 1 },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (shouldAppendTouch(visitor.touches, touch, { protectAdTouch: config.protectAdTouch })) {
      // Capped so a scripted visitor cannot grow one document without limit; the earliest
      // touch is the one worth protecting, so the cap drops from the middle.
      const next = [...visitor.touches, touch];
      const trimmed = next.length > 30 ? [next[0], ...next.slice(-29)] : next;
      await Visitor.updateOne({ _id: visitor._id }, { touches: trimmed });
    }

    return ok(res, { visitorId, channel, visitCount: visitor.visitCount });
  });
});

/** Splits a submitted phone into the country code and number the guest schema expects. */
function splitPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > 10 && digits.length <= 15) {
    // Longest-first so a 12-digit +91 number is not read as a 1-digit code.
    for (const cc of ['91', '971', '44', '1', '65', '60', '94', '977']) {
      if (digits.startsWith(cc) && digits.length - cc.length >= 7) {
        return { countryCode: cc, number: digits.slice(cc.length), isPrimary: true };
      }
    }
  }
  return { countryCode: '91', number: digits.slice(-12), isPrimary: true };
}

// POST /api/public/leads/:token — a website form submission becomes a query.
export const submitLead = asyncHandler(async (req, res) => {
  const settings = await tenantFor(req.params.token);
  const ip = callerIp(req);
  if (isIgnoredIp(ip, settings.capture?.ignoreIps)) return ok(res, { ignored: 'ignored_ip' });

  const b = req.body || {};
  const phone = splitPhone(b.phone || b.mobile || b.nnc_phone);
  const name = clip(b.name || b.fullName || b.guestName, 120);
  if (!phone) throw ApiError.badRequest('A phone number is required');
  if (!name) throw ApiError.badRequest('A name is required');

  return runWithTenant(settings.organization, async () => {
    const config = captureConfig(settings);
    const url = clip(b.url || b.nnc_url, MAX_URL);
    const referrer = clip(b.referrer || b.nnc_referrer, MAX_URL);
    const visitorId = clip(b.visitorId || b.nnc_visitor_id, 64);

    // The journey so far. A form posted without the script having ever run (a hand-built
    // integration, or a visitor with storage blocked) still produces one touch from the
    // submitted URL, so the lead is attributed rather than dropped into Direct.
    let visitor = null;
    if (VISITOR_ID_RX.test(visitorId)) {
      visitor = await Visitor.findOne({ visitorId });
    }
    const submitTouch = buildTouch({
      url: url || '/',
      referrer,
      derived: {
        device: clip(b.device || b.nnc_device, 80),
        ga_client_id: clip(b.gaClientId || b.nnc_ga_client_id, 80),
      },
      config,
    });
    submitTouch.touch.trackingLink = await linkForTouch(submitTouch.touch);

    let touches = visitor?.touches?.length ? [...visitor.touches.map((t) => (t.toObject ? t.toObject() : t))] : [];
    if (!touches.length) touches = [submitTouch.touch];
    else if (shouldAppendTouch(touches, submitTouch.touch, { protectAdTouch: config.protectAdTouch })) {
      touches.push(submitTouch.touch);
    }

    const attribution = buildAttribution({
      visitor,
      touches,
      config,
      extra: {
        visitorId,
        conversionPage: clip(b.conversionPage || b.nnc_form_page, 500),
        formName: clip(b.formName || b.form || 'Website form', 120),
        tracked: submitTouch.tracked,
        device: clip(b.device || b.nnc_device, 80),
        gaClientId: clip(b.gaClientId || b.nnc_ga_client_id, 80),
      },
      // Everything submitted, including parameters this tenant has not switched on. Switching
      // one on next month should not mean this month's data was thrown away.
      raw: Object.fromEntries(Object.entries(b).slice(0, 80).map(([k, v]) => [k, clip(v, 500)])),
    });

    // Duplicate guard: the same phone enquiring twice in a short window is one person, and a
    // second query would also mean a second acknowledgement message to them.
    const dupDays = settings.assignment?.fairness?.mergeDuplicateDays ?? 30;
    if (dupDays > 0) {
      const existing = await Query.findOne({
        'guest.phones.number': phone.number,
        createdAt: { $gte: new Date(Date.now() - dupDays * DAY) },
      }).sort('-createdAt').select('queryNumber owner attribution');
      if (existing) {
        // Keep the newer journey on the existing lead — it is the same person, now with more
        // history — but do not re-route or re-acknowledge it.
        existing.attribution = { ...(existing.attribution?.toObject?.() || existing.attribution || {}), ...attribution };
        await existing.save();
        await logActivity(existing._id, null, 'enquired again from the website (' + channelMeta(attribution.channel).label + ')', 'note').catch(() => {});
        return ok(res, { queryNumber: existing.queryNumber, merged: true, assigned: !!existing.owner });
      }
    }

    // `source` is set alongside the channel so the existing sales report, which breaks down by
    // QuerySource, counts these leads without any change to it.
    const sourceName = channelMeta(attribution.channel).source;
    const source = await QuerySource.findOneAndUpdate(
      { name: sourceName },
      { $setOnInsert: { name: sourceName, isActive: true } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // A named destination is matched, never created: letting a public form invent master data
    // would hand anyone on the internet a write into this tenant's destination list.
    const destinations = [];
    const wanted = clip(b.destination || b.destinations, 120);
    if (wanted) {
      const dest = await Destination.findOne({ name: new RegExp('^' + wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).select('_id').lean();
      if (dest) destinations.push(dest._id);
    }

    const start = b.startDate ? new Date(b.startDate) : null;
    const query = await Query.create({
      source: source._id,
      destinations,
      startDate: start && !Number.isNaN(start.getTime()) ? start : new Date(Date.now() + 30 * DAY),
      nights: Math.min(60, Math.max(0, Number(b.nights) || 1)),
      pax: { adults: Math.min(50, Math.max(1, Number(b.adults) || Number(b.pax) || 1)), children: [] },
      guest: {
        name,
        email: clip(b.email, 160).toLowerCase() || undefined,
        location: clip(b.city || b.location, 120) || undefined,
        phones: [phone],
      },
      comments: clip(b.message || b.comments || b.notes, MAX_TEXT) || undefined,
      status: 'new_query',
      attribution,
    });

    await logActivity(query._id, null, 'created from the website (' + channelMeta(attribution.channel).label + ')', 'created').catch(() => {});
    const assignment = await assignLead(query, { settings: null });

    return created(res, {
      queryNumber: query.queryNumber,
      assigned: assignment.assigned,
      // The assignee's name is deliberately NOT returned: this response goes to a public
      // browser, and who works a lead is internal.
      channel: attribution.channel,
    });
  });
});

// GET /api/public/track/:token/t.js — the tracking script, built for this organization.
export const serveScript = asyncHandler(async (req, res) => {
  const settings = await tenantFor(req.params.token);
  const script = await runWithTenant(settings.organization, async () => {
    const config = captureConfig(settings);
    return buildTrackingScript({
      token: settings.ingestToken,
      baseUrl: env.publicBaseUrl,
      config,
      settings,
    });
  });
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  // Short cache: a settings change should reach the website in minutes, not after someone
  // remembers to purge a CDN.
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Access-Control-Allow-Origin', '*');
  return res.send(script);
});

// GET /api/public/r/:code — short link, counts the click and forwards.
export const redirectLink = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!/^[a-z0-9]{4,16}$/i.test(code)) throw ApiError.notFound('Unknown link');
  // Resolved globally: the code is the credential, and this route has no tenant context.
  const link = await TrackingLink.findOne({ code }).select('url targetUrl organization isActive');
  if (!link || link.isActive === false) throw ApiError.notFound('This link is no longer active');

  // Counted without blocking the redirect: a slow write must not become a slow landing page.
  TrackingLink.updateOne({ _id: link._id }, { $inc: { clicks: 1 }, $set: { lastClickAt: new Date() } })
    .catch(() => {});

  res.set('Cache-Control', 'no-store');
  return res.redirect(302, link.url || link.targetUrl);
});

// GET /api/public/form/:token — what the hosted enquiry form needs to render itself.
//
// Exists because most small agencies do not have a website form to post from: they have an
// Instagram bio, a WhatsApp number and a printed flyer. Without a form of their own there is
// nothing for the ingest to receive, so the CRM hosts one and hands them a link.
//
// Returns only what a stranger may see — the company's public identity and its destination
// list. Deliberately NOT the staff, the pricing, the lead counts or anything else a token in a
// shared link should never unlock.
export const formConfig = asyncHandler(async (req, res) => {
  const settings = await tenantFor(req.params.token);
  return runWithTenant(settings.organization, async () => {
    const [profile, destinations] = await Promise.all([
      OrgProfile.getFor(settings.organization).catch(() => null),
      Destination.find({ isActive: { $ne: false } }).select('name').sort('name').limit(60).lean(),
    ]);
    return ok(res, {
      company: profile?.brandName || profile?.officialName || 'Travel enquiries',
      logo: profile?.images?.logo || null,
      color: profile?.colorTheme || '#1e56d6',
      phone: profile?.supportPhones?.[0] || null,
      email: profile?.emails?.[0] || null,
      website: profile?.website || null,
      destinations: destinations.map((d) => d.name),
      accepting: settings.capture?.enabled !== false,
    });
  });
});

// GET /api/public/track/:token/ping — lets the Setup page confirm a token is live.
export const pingToken = asyncHandler(async (req, res) => {
  const settings = await tenantFor(req.params.token);
  const seen = await runWithTenant(settings.organization, () => Visitor.countDocuments({}));
  return ok(res, { ok: true, captureEnabled: settings.capture?.enabled !== false, visitorsKnown: seen });
});
