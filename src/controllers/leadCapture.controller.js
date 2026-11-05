import { LeadSettings } from '../models/LeadSettings.js';
import { Query } from '../models/Query.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import {
  CAPTURE_GROUPS, CAPTURE_PARAMS, RESERVED_FIELDS, TOUCH_MODES, RETENTION_CHOICES,
} from '../config/captureParams.js';
import { channelMeta } from '../config/leadChannels.js';
import { captureConfig, buildTouch } from '../utils/leadAttribution.js';
import { installSnippets, hiddenFieldsSnippet } from '../utils/trackingScript.js';

const DAY = 86400000;

/** Capture points the CRM has actually seen leads arrive through, plus their health.
 *
 *  Derived from the leads themselves rather than from a list someone maintained by hand: a
 *  configured list of forms goes stale the first time the website is redesigned, and then the
 *  page reassures you about a form that no longer exists while saying nothing about the new
 *  one quietly losing every source. */
async function capturePoints() {
  const since = new Date(Date.now() - 30 * DAY);
  const rows = await Query.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          form: { $ifNull: ['$attribution.formName', null] },
          page: { $ifNull: ['$attribution.conversionPage', null] },
        },
        leads: { $sum: 1 },
        tracked: { $sum: { $cond: [{ $eq: ['$attribution.tracked', true] }, 1, 0] } },
      },
    },
    { $sort: { leads: -1 } },
    { $limit: 30 },
  ]);

  // Several pages can host the same form; the form is the thing you fix, so group by it.
  const byForm = new Map();
  for (const r of rows) {
    const key = r._id.form || '__manual__';
    const cur = byForm.get(key) || { formName: r._id.form, pages: new Set(), leads: 0, tracked: 0 };
    if (r._id.page) cur.pages.add(r._id.page);
    cur.leads += r.leads;
    cur.tracked += r.tracked;
    byForm.set(key, cur);
  }

  return [...byForm.entries()].map(([key, v]) => {
    const manual = key === '__manual__';
    const untracked = v.leads - v.tracked;
    return {
      formName: manual ? 'Entered by an agent' : v.formName,
      pages: manual ? 'Inside the CRM' : [...v.pages].join(', ') || 'Unknown page',
      type: manual ? 'Manual' : 'Website form',
      // A manually keyed enquiry has no website visit to track, so it is excluded rather than
      // counted as a failure — otherwise a busy walk-in month looks like a broken website.
      status: manual ? 'excluded' : untracked === 0 ? 'ok' : v.tracked === 0 ? 'missing' : 'partial',
      leads30d: v.leads,
      tracked: v.tracked,
      untracked,
    };
  }).sort((a, b) => b.leads30d - a.leads30d);
}

/** Joins the catalog to this tenant's on/off state and field mapping. */
function shapeSettings(settings, points) {
  const cfg = captureConfig(settings);
  const byKey = new Map(cfg.params.map((p) => [p.key, p]));
  const cap = settings.capture || {};

  // The headline the status strip shows, computed from the capture points already loaded so
  // the page does not need a second request to the health endpoint for one number.
  const counted = points.filter((p) => p.status !== 'excluded');
  const leads = counted.reduce((s, p) => s + p.leads30d, 0);
  const tracked = counted.reduce((s, p) => s + p.tracked, 0);

  return {
    withSourcePct: leads ? Math.round((tracked / leads) * 100) : null,
    // The recommended baseline for the scalar settings, same reason as `recommended` below.
    recommended: {
      touchMode: 'both',
      retentionDays: 90,
      protectAdTouch: true,
      cleanValues: true,
      trackSubdomains: true,
      requireConsent: false,
      blogParam: 'ref',
    },
    ingestToken: settings.ingestToken,
    enabled: cap.enabled !== false,
    siteHosts: cap.siteHosts || [],
    touchMode: cfg.touchMode,
    retentionDays: cap.retentionDays || 90,
    protectAdTouch: cap.protectAdTouch !== false,
    cleanValues: cap.cleanValues !== false,
    trackSubdomains: cap.trackSubdomains !== false,
    requireConsent: cap.requireConsent === true,
    blogParam: cap.blogParam || 'ref',
    ignoreIps: cap.ignoreIps || [],
    campaignPrefix: settings.campaignPrefix || 'crm',
    groups: CAPTURE_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      note: g.note,
      params: g.params.map((p) => {
        const row = byKey.get(p.key);
        return {
          key: p.key,
          aliases: p.aliases || [],
          label: p.label,
          field: row?.field || p.field,
          example: p.example,
          enabled: row ? row.enabled : p.on,
          derived: !!p.derived,
          // The catalog's own default, so "Reset to recommended" is driven by the server
          // rather than by a second copy of these defaults living in the UI.
          recommended: p.on,
          defaultField: p.field,
        };
      }),
    })),
    custom: cfg.custom,
    enabledCount: cfg.enabledCount,
    capturePoints: points,
    touchModes: TOUCH_MODES,
    retentionChoices: RETENTION_CHOICES,
  };
}

// GET /api/leads/capture
export const getCapture = asyncHandler(async (req, res) => {
  const [settings, points] = await Promise.all([LeadSettings.getFor(), capturePoints()]);
  return ok(res, shapeSettings(settings, points));
});

const CATALOG_KEYS = new Set(CAPTURE_PARAMS.map((p) => p.key));
const FIELD_RX = /^[a-zA-Z][\w.]{0,48}$/;
const HOST_RX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Validates one row of the parameter mapping. A field name that collides with the
 *  attribution block's own structure would quietly shadow the data the reports read. */
function cleanField(field, what) {
  const v = String(field || '').trim();
  if (!FIELD_RX.test(v)) throw ApiError.badRequest('"' + v + '" is not a usable field name for ' + what);
  if (RESERVED_FIELDS.includes(v.split('.')[0])) {
    throw ApiError.badRequest('"' + v + '" is reserved by the CRM and cannot be used as a field name');
  }
  return v;
}

// PATCH /api/leads/capture
export const updateCapture = asyncHandler(async (req, res) => {
  const settings = await LeadSettings.getFor();
  const b = req.body || {};
  const cap = settings.capture || {};

  if (b.enabled !== undefined) cap.enabled = !!b.enabled;
  if (b.touchMode !== undefined) {
    if (!TOUCH_MODES.some((m) => m.key === b.touchMode)) throw ApiError.badRequest('Unknown touch mode: ' + b.touchMode);
    cap.touchMode = b.touchMode;
  }
  if (b.retentionDays !== undefined) {
    const n = Number(b.retentionDays);
    if (!Number.isFinite(n) || n < 1 || n > 730) throw ApiError.badRequest('Retention must be between 1 and 730 days');
    cap.retentionDays = Math.round(n);
  }
  if (b.protectAdTouch !== undefined) cap.protectAdTouch = !!b.protectAdTouch;
  if (b.cleanValues !== undefined) cap.cleanValues = !!b.cleanValues;
  if (b.trackSubdomains !== undefined) cap.trackSubdomains = !!b.trackSubdomains;
  if (b.requireConsent !== undefined) cap.requireConsent = !!b.requireConsent;
  if (b.blogParam !== undefined) {
    const v = String(b.blogParam || '').trim();
    if (v && !/^[\w-]{1,32}$/.test(v)) throw ApiError.badRequest('The blog parameter must be a single query-string name');
    cap.blogParam = v || 'ref';
  }
  if (b.siteHosts !== undefined) {
    if (!Array.isArray(b.siteHosts)) throw ApiError.badRequest('siteHosts must be a list');
    const hosts = b.siteHosts
      .map((h) => String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))
      .filter(Boolean);
    for (const h of hosts) if (!HOST_RX.test(h)) throw ApiError.badRequest('"' + h + '" is not a valid website address');
    cap.siteHosts = [...new Set(hosts)];
  }
  if (b.ignoreIps !== undefined) {
    if (!Array.isArray(b.ignoreIps)) throw ApiError.badRequest('ignoreIps must be a list');
    cap.ignoreIps = [...new Set(b.ignoreIps.map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 50);
  }
  if (b.campaignPrefix !== undefined) {
    const v = String(b.campaignPrefix || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!v) throw ApiError.badRequest('The campaign prefix cannot be empty');
    settings.campaignPrefix = v.slice(0, 12);
  }

  // Parameter mapping. Catalog rows and custom rows arrive in two lists but are stored in one,
  // with `custom` marking which is which.
  if (b.params !== undefined || b.custom !== undefined) {
    const next = [];
    const seenFields = new Map();
    const claim = (field, label) => {
      const prior = seenFields.get(field);
      if (prior) throw ApiError.badRequest('Both ' + prior + ' and ' + label + ' are pointed at "' + field + '"');
      seenFields.set(field, label);
    };

    const incomingCatalog = new Map((Array.isArray(b.params) ? b.params : []).map((p) => [p.key, p]));
    for (const cat of CAPTURE_PARAMS) {
      const sent = incomingCatalog.get(cat.key);
      const existing = (cap.params || []).find((p) => p.key === cat.key && !p.custom);
      const field = cleanField(sent?.field ?? existing?.field ?? cat.field, cat.key);
      const enabled = sent?.enabled !== undefined ? !!sent.enabled : existing ? existing.enabled !== false : cat.on;
      if (enabled) claim(field, cat.key);
      next.push({ key: cat.key, field, enabled, custom: false });
    }

    if (Array.isArray(b.custom)) {
      for (const row of b.custom.slice(0, 40)) {
        const key = String(row.key || '').trim();
        if (!key) continue;
        if (!/^[\w-]{1,48}$/.test(key)) throw ApiError.badRequest('"' + key + '" is not a valid query-string name');
        if (CATALOG_KEYS.has(key)) throw ApiError.badRequest('"' + key + '" is already a standard parameter');
        if (next.some((p) => p.custom && p.key === key)) throw ApiError.badRequest('"' + key + '" is listed twice');
        const field = cleanField(row.field || key, key);
        const enabled = row.enabled !== false;
        if (enabled) claim(field, key);
        next.push({ key, field, enabled, custom: true, label: String(row.label || key).trim().slice(0, 80) });
      }
    } else {
      next.push(...(cap.params || []).filter((p) => p.custom));
    }
    cap.params = next;
  }

  settings.capture = cap;
  settings.markModified('capture');
  await settings.save();

  const points = await capturePoints();
  return ok(res, shapeSettings(settings, points));
});

// POST /api/leads/capture/test  { url, referrer }
//
// Runs the real ingest path against a sample link. Read-only — nothing is stored — but the
// classification and the field mapping are the same code the website hits, so what this shows
// is what would actually be recorded.
export const testCapture = asyncHandler(async (req, res) => {
  const settings = await LeadSettings.getFor();
  const config = captureConfig(settings);
  const url = String(req.body?.url || '').trim();
  if (!url) throw ApiError.badRequest('Paste a link to test');

  const derived = {
    landing_page: null, // filled from the parsed path below
    referrer: req.body?.referrer || '',
    form_page: null,
    device: 'Mobile, Android',
    city: 'Chennai',
    visits: 1,
    first_seen: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    ga_client_id: 'GA1.1.2041183077.1762000000',
  };

  const r = buildTouch({ url, referrer: req.body?.referrer || '', derived, config });
  // The two page fields are known only after parsing, so they are stamped afterwards rather
  // than being guessed before.
  const withPages = r.stored.map((s) => {
    if (s.from === 'landing_page' || s.from === 'form_page') return { ...s, value: r.path };
    if (s.from === 'referrer') return { ...s, value: r.touch.referrer || '(none)' };
    return s;
  });

  const meta = channelMeta(r.channel);
  const prefix = config.touchMode === 'both' ? ['first.', 'last.'] : [''];
  // Visit facts are stored once on the lead, not once per end of the journey.
  const VISIT_FIELDS = new Set(['device', 'visitorCity', 'visitCount', 'firstSeenAt', 'gaClientId', 'conversionPage']);

  return ok(res, {
    channel: r.channel,
    label: meta.label,
    icon: meta.icon,
    color: meta.color,
    because: r.because,
    tracked: r.tracked,
    touchMode: config.touchMode,
    stored: withPages.flatMap((s) => (VISIT_FIELDS.has(s.field)
      ? [{ field: s.field, value: s.value, from: s.from }]
      : prefix.map((p) => ({ field: p + s.field, value: s.value, from: s.from })))),
    skipped: r.skipped,
  });
});

// GET /api/leads/capture/install
export const getInstall = asyncHandler(async (req, res) => {
  const settings = await LeadSettings.getFor();
  const base = env.publicBaseUrl;
  const scriptUrl = base + '/api/public/track/' + settings.ingestToken + '/t.js';
  const leadEndpoint = base + '/api/public/leads/' + settings.ingestToken;
  return ok(res, {
    ingestToken: settings.ingestToken,
    scriptUrl,
    leadEndpoint,
    // Flagged so the page can warn rather than hand out a localhost URL that will never work
    // on a real website.
    publicReachable: !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(base),
    stacks: installSnippets({ scriptUrl, leadEndpoint, token: settings.ingestToken }),
    hiddenFields: hiddenFieldsSnippet(),
  });
});

// POST /api/leads/capture/rotate-token
export const rotateIngestToken = asyncHandler(async (req, res) => {
  const settings = await LeadSettings.rotateToken();
  const base = env.publicBaseUrl;
  return ok(res, {
    ingestToken: settings.ingestToken,
    scriptUrl: base + '/api/public/track/' + settings.ingestToken + '/t.js',
  });
});

export { capturePoints };
