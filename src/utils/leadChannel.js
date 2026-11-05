// Decides which acquisition channel a visit belongs to, from its tracking parameters and
// referrer. Pure and synchronous so the live tester on the UTM Capture page and the real
// ingest endpoint cannot disagree — a tester that reassures you about a link the ingest then
// classifies differently is worse than no tester at all.
//
// The order below IS the rule: the first test that matches wins, strongest evidence first.
// A click id is strongest (the platform itself stamped it, and it survives a link whose utm
// tags were stripped), then the campaign tags the link carried, then the referrer, which is
// only a hint.

import { DEFAULT_CHANNEL } from '../config/leadChannels.js';

// Source values that mean the same platform under different spellings. Meta's own
// {{site_source_name}} macro emits 'fb', 'ig', 'an' (Audience Network) and 'msg' (Messenger),
// so those four arrive in real traffic and have to be folded in.
const SOURCE_ALIASES = {
  fb: 'facebook', facebook: 'facebook', 'facebook.com': 'facebook',
  ig: 'instagram', insta: 'instagram', instagram: 'instagram', 'instagram.com': 'instagram',
  an: 'audience-network', msg: 'messenger', meta: 'meta',
  google: 'google', 'google.com': 'google', adwords: 'google', googleads: 'google',
  wa: 'whatsapp', whatsapp: 'whatsapp',
};

const META_SOURCES = ['facebook', 'instagram', 'meta', 'audience-network', 'messenger'];
const GOOGLE_PAID_MEDIUM = /^(cpc|ppc|paid|paid_search|paidsearch)$/;
const OFFLINE_MEDIUM = /^(email|e-mail|sms|broadcast|offline|whatsapp|print|qr)$/;
const PARTNER_MEDIUM = /^(partner|affiliate|influencer)$/;
const SEARCH_ENGINE_HOST = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave)\./i;

/**
 * Lowercase, trim and hyphenate a captured value. Applied to UTM tags only: a click id is
 * case-sensitive and must survive untouched or the ad platform will not recognise it when we
 * report the sale back.
 */
export function cleanValue(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

/** Resolves a raw utm_source to its canonical platform name, so 'FB' and 'facebook' are one. */
export function canonicalSource(v) {
  const s = cleanValue(v);
  return SOURCE_ALIASES[s] || s;
}

/** Hostname of a referrer without the leading www. Returns '' when there is nothing to read. */
export function referrerHost(referrer) {
  const raw = String(referrer || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    return new URL(withScheme).hostname.replace(/^www\./i, '');
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }
}

/**
 * Splits a URL into its query parameters, path and host. Falls back to manual parsing so a
 * half-typed URL in the tester still yields something useful instead of throwing.
 */
export function parseTrackingUrl(url) {
  const raw = String(url || '').trim();
  const params = {};
  let path = '/';
  let host = '';
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    path = u.pathname || '/';
    host = u.hostname.replace(/^www\./i, '');
    u.searchParams.forEach((v, k) => { params[k] = v; });
  } catch {
    const [before, after] = raw.split('?');
    path = (before || '').replace(/^https?:\/\/[^/]+/i, '') || '/';
    (after || '').split('&').forEach((kv) => {
      const [k, ...rest] = kv.split('=');
      if (k) params[k] = decodeURIComponent(rest.join('=').replace(/\+/g, ' '));
    });
  }
  return { params, path, host };
}

/**
 * The waterfall. Returns the channel key plus the evidence that decided it, so the lead
 * drawer and the tester can both say *why* and not only *what*.
 *
 * @param {object}   input
 * @param {object}   input.params     query-string parameters of the landing URL
 * @param {string}   input.referrer   document.referrer of the first page of the visit
 * @param {string}   input.path       pathname of the landing page
 * @param {string[]} input.siteHosts  the tenant's own hostnames — a referrer among these is
 *                                    navigation inside the site, not a referral
 * @param {string}   input.blogParam  custom parameter marking a blog call-to-action
 */
export function classifyTouch({ params = {}, referrer = '', path = '/', siteHosts = [], blogParam = 'ref' } = {}) {
  const p = params || {};
  const source = canonicalSource(p.utm_source);
  const medium = cleanValue(p.utm_medium);
  const host = referrerHost(referrer);
  const own = (siteHosts || []).map((h) => referrerHost(h)).filter(Boolean);

  const googleClick = p.gclid || p.gbraid || p.wbraid;
  if (googleClick || (source === 'google' && GOOGLE_PAID_MEDIUM.test(medium))) {
    return {
      channel: 'google_ads',
      because: googleClick ? 'Google Ads click id on the link' : 'utm_source=google with a paid medium',
    };
  }
  if (p.fbclid || p.ctwa_clid || META_SOURCES.includes(source)) {
    return {
      channel: 'meta_ads',
      because: p.ctwa_clid ? 'WhatsApp ad click id' : p.fbclid ? 'Meta click id on the link' : 'utm_source=' + source,
    };
  }
  // Bing is counted with paid search rather than given a channel of its own: at the volumes
  // these clients run it, one more card would be a card showing two leads.
  if (p.msclkid) return { channel: 'google_ads', because: 'Bing Ads click id, counted with paid search' };

  if (source === 'whatsapp' || OFFLINE_MEDIUM.test(medium)) {
    return { channel: 'offline', because: 'utm_medium=' + (medium || 'whatsapp') };
  }
  if (PARTNER_MEDIUM.test(medium)) return { channel: 'referral', because: 'utm_medium=' + medium };

  const blogTag = String(p[blogParam] || '').toLowerCase();
  if (blogTag.startsWith('blog') || /^\/blog(\/|$)/i.test(path)) {
    return {
      channel: 'blog',
      because: /^\/blog/i.test(path) ? 'landed on a blog article' : blogParam + ' tag names a blog button',
    };
  }
  if (host && SEARCH_ENGINE_HOST.test(host)) {
    return { channel: 'organic', because: 'arrived from ' + host + ' with no ad click' };
  }
  if (host && !own.includes(host)) return { channel: 'referral', because: 'arrived from ' + host };

  return {
    channel: DEFAULT_CHANNEL,
    because: host ? 'navigation inside your own site' : 'no tracking information on the visit',
  };
}

/**
 * True when a visit carries anything at all that identifies where it came from. Drives the
 * "untracked" badge on a lead and the tracking-health percentage on the Setup page.
 */
export function isTracked({ params = {}, referrer = '' } = {}) {
  const p = params || {};
  if (p.gclid || p.gbraid || p.wbraid || p.fbclid || p.ctwa_clid || p.msclkid || p.li_fat_id) return true;
  if (p.utm_source || p.utm_medium || p.utm_campaign) return true;
  return !!referrerHost(referrer);
}

// The waterfall rendered as plain sentences, for the "How the source is decided" panel on the
// Setup page. Generated from the same ordering above so the explanation cannot drift from the
// code that actually decides.
export const CLASSIFICATION_ORDER = [
  { test: 'Clicked a Google ad (or Bing)', channel: 'google_ads' },
  { test: 'Clicked a Facebook, Instagram or WhatsApp ad', channel: 'meta_ads' },
  { test: 'Used a WhatsApp, email, SMS or QR link', channel: 'offline' },
  { test: 'Came through a partner or influencer link', channel: 'referral' },
  { test: 'Opened a blog article or a blog button', channel: 'blog' },
  { test: 'Found you on Google search, no ad clicked', channel: 'organic' },
  { test: 'Came from another website', channel: 'referral' },
  { test: 'None of the above', channel: 'direct' },
];
