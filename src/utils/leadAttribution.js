// Turns a raw visit into the touch we store, and a visitor's history into the attribution
// block on a lead.
//
// Both the public ingest and the live tester on the UTM Capture page go through here. That is
// the point: the tester's whole value is telling an agent what a link WILL record, and a
// tester with its own copy of this logic would eventually reassure them about a link the
// ingest then files somewhere else.

import { CAPTURE_PARAMS, captureParam } from '../config/captureParams.js';
import { channelMeta } from '../config/leadChannels.js';
import { classifyTouch, isTracked, cleanValue, referrerHost, parseTrackingUrl } from './leadChannel.js';

/**
 * Flattens a tenant's stored capture settings into a lookup keyed by catalog parameter.
 * Parameters the tenant has never seen (added to the catalog in a later release) fall back to
 * their recommended state, so a new capture does not silently stay off until someone opens
 * the settings page.
 */
export function captureConfig(settings) {
  const stored = new Map((settings?.capture?.params || []).map((p) => [p.key, p]));
  const params = CAPTURE_PARAMS.map((cat) => {
    const row = stored.get(cat.key);
    return {
      ...cat,
      field: row?.field || cat.field,
      enabled: row ? row.enabled !== false : cat.on,
    };
  });
  const custom = (settings?.capture?.params || [])
    .filter((p) => p.custom)
    .map((p) => ({ key: p.key, label: p.label || p.key, field: p.field, enabled: p.enabled !== false, custom: true }));
  return {
    params,
    custom,
    byKey: new Map([...params, ...custom].map((p) => [p.key, p])),
    enabledCount: [...params, ...custom].filter((p) => p.enabled).length,
    touchMode: settings?.capture?.touchMode || 'both',
    clean: settings?.capture?.cleanValues !== false,
    siteHosts: settings?.capture?.siteHosts || [],
    blogParam: settings?.capture?.blogParam || 'ref',
    protectAdTouch: settings?.capture?.protectAdTouch !== false,
    retentionDays: settings?.capture?.retentionDays || 90,
  };
}

/** Reads a catalog parameter's value out of a query string, trying its aliases in turn. */
function readParam(params, cat) {
  for (const key of [cat.key, ...(cat.aliases || [])]) {
    const v = params?.[key];
    if (v !== undefined && v !== null && String(v) !== '') return { value: String(v), from: key };
  }
  return null;
}

/** Writes a dotted path onto a plain object, creating the intermediate objects. */
function setPath(target, path, value) {
  const parts = String(path).split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Builds one touch from a visit, honouring which parameters the tenant has switched on.
 *
 * @returns {{touch, channel, because, tracked, stored, skipped}}
 *   stored/skipped are the per-field breakdown the tester renders; the ingest ignores them.
 */
export function buildTouch({ url, referrer = '', derived = {}, config }) {
  const { params, path } = parseTrackingUrl(url);
  const cfg = config;

  const { channel, because } = classifyTouch({
    params,
    referrer,
    path,
    siteHosts: cfg.siteHosts,
    blogParam: cfg.blogParam,
  });
  const tracked = isTracked({ params, referrer });

  const touch = { at: new Date(), channel, because, clickIds: {}, custom: {} };
  const stored = [];
  const skipped = [];

  for (const cat of [...cfg.params, ...cfg.custom]) {
    const target = cat.field;
    // Values the script observes rather than reads off the URL (device, city, visit count).
    if (cat.derived) {
      const v = derived[cat.key];
      if (!cat.enabled) { skipped.push({ field: target, from: cat.key, why: 'switched off' }); continue; }
      if (v === undefined || v === null || v === '') { skipped.push({ field: target, from: cat.key, why: 'not available on this visit' }); continue; }
      stored.push({ field: target, value: String(v), from: cat.key });
      continue;
    }
    const hit = readParam(params, cat);
    if (!cat.enabled) {
      if (hit) skipped.push({ field: target, from: hit.from, why: 'switched off' });
      else skipped.push({ field: target, from: cat.key, why: 'switched off' });
      continue;
    }
    if (!hit) { skipped.push({ field: target, from: cat.key, why: 'not in this link' }); continue; }
    // Click ids keep their exact case; only campaign tags are normalized.
    const value = cfg.clean && cat.group === 'utm' ? cleanValue(hit.value) : hit.value.trim();
    if (cat.custom) touch.custom[cat.key] = value;
    else setPath(touch, target, value);
    stored.push({ field: target, value, from: hit.from });
  }

  // Facts about the visit that are not configurable parameters but belong on the touch.
  touch.landingPage = path;
  touch.referrer = referrerHost(referrer);
  if (!Object.keys(touch.clickIds).length) delete touch.clickIds;
  if (!Object.keys(touch.custom).length) delete touch.custom;

  return { touch, channel, because, tracked, stored, skipped, params, path };
}

/**
 * Should this new touch be appended to a visitor's history?
 *
 * An untracked return visit is dropped when `protectAdTouch` is on: somebody clicks an ad,
 * then types the URL two days later, and without this the ad that paid for the lead loses the
 * credit to a "direct" visit it caused itself. Repeat visits from the SAME source are also
 * folded together so a person refreshing a page six times does not look like six touches.
 */
export function shouldAppendTouch(existing, next, { protectAdTouch = true } = {}) {
  if (!existing?.length) return true;
  const prev = existing[existing.length - 1];
  if (protectAdTouch && next.channel === 'direct' && prev.channel !== 'direct') return false;
  const same = prev.channel === next.channel
    && (prev.campaign || '') === (next.campaign || '')
    && (prev.content || '') === (next.content || '');
  if (!same) return true;
  // Same source again — only a genuinely new session counts.
  const gapMs = new Date(next.at).getTime() - new Date(prev.at).getTime();
  return gapMs > 30 * 60 * 1000;
}

/** Which channel gets the credit, given the tenant's first/last setting. */
export function creditedChannel(touches, touchMode = 'both') {
  if (!touches?.length) return 'direct';
  const first = touches[0]?.channel || 'direct';
  const last = touches[touches.length - 1]?.channel || 'direct';
  // 'both' stores each end and credits the last — the enquiry is what the sales team acts on,
  // and the Lead Sources page can flip to first-touch without re-reading anything.
  return touchMode === 'first' ? first : last;
}

/**
 * Assembles the attribution block saved on a Query from a visitor's accumulated history.
 * `extra` carries the form-submission facts (which page, which form) that only exist at the
 * moment of enquiry.
 */
export function buildAttribution({ visitor, touches, config, extra = {}, raw }) {
  const list = (touches || []).slice();
  const first = list[0];
  const last = list[list.length - 1];
  const mode = config?.touchMode || 'both';

  const block = {
    channel: creditedChannel(list, mode),
    firstChannel: first?.channel,
    lastChannel: last?.channel,
    touches: list,
    tracked: list.some((t) => t.channel && t.channel !== 'direct') || !!extra.tracked,
    visitorId: visitor?.visitorId || extra.visitorId,
    visitCount: visitor?.visitCount,
    firstSeenAt: visitor?.firstSeenAt,
    device: visitor?.device || extra.device,
    visitorCity: visitor?.city || extra.visitorCity,
    gaClientId: visitor?.gaClientId || extra.gaClientId,
    conversionPage: extra.conversionPage,
    formName: extra.formName,
    trackingLink: last?.trackingLink || first?.trackingLink,
    raw,
  };
  // 'both' keeps each end; a tenant who asked for one end only gets that one, so the stored
  // record matches what they were told would be stored.
  if (mode !== 'last') block.first = first;
  if (mode !== 'first') block.last = last;
  return block;
}

/** Flat key/value view of a lead's attribution, for the drawer's "technical details" panel. */
export function technicalDetails(attribution) {
  const a = attribution || {};
  const t = a.last || a.first || {};
  const out = {};
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') out[k] = String(v); };
  put('channel', channelMeta(a.channel).label);
  put('source', t.source);
  put('medium', t.medium);
  put('campaign', t.campaign);
  put('ad / creative', t.content);
  put('keyword', t.term);
  put('campaign_id', t.campaignId);
  const clicks = t.clickIds instanceof Map ? Object.fromEntries(t.clickIds) : t.clickIds || {};
  for (const [k, v] of Object.entries(clicks)) put(k + '_click_id', v);
  put('landing_page', t.landingPage);
  put('referrer', t.referrer);
  put('conversion_page', a.conversionPage);
  put('form', a.formName);
  if (a.firstChannel && a.firstChannel !== a.lastChannel) {
    put('first_source', channelMeta(a.firstChannel).label);
  }
  put('visits_before_enquiry', a.visitCount);
  put('device', a.device);
  put('visitor_city', a.visitorCity);
  put('ga_client_id', a.gaClientId);
  const custom = t.custom instanceof Map ? Object.fromEntries(t.custom) : t.custom || {};
  for (const [k, v] of Object.entries(custom)) put(k, v);
  return out;
}

export { captureParam };
