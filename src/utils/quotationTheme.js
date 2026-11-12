// Resolves how one organization's quotation document should look.
//
// The quotation used to read its cover art, colours and terms straight out of the static
// config in config/company.js — fine for a single-company deployment, wrong the moment a
// second tenant sends a quote, because every company's document came out branded as the
// first one's. This layer puts the organization's own settings on top and keeps the config
// as the fallback, so a tenant that has never opened the editor renders exactly what it
// rendered before.
//
// Nothing here throws. A quotation is a document an agent is trying to send to a guest right
// now; a malformed colour or a deleted banner must degrade to the default, not produce an
// error page.

import { company } from '../config/company.js';

// The palette the document was built with. Each key maps to one role rather than one element,
// so a tenant picking two colours gets a coherent document instead of having to name nineteen
// separate shades.
export const DEFAULT_COLORS = {
  primary: '#092a78', // headings, section bars, cover wordmark
  accent: '#f05a18', // prices, call-outs
  text: '#2c3d51', // body copy
  soft: '#9bd3ef', // hairline borders
  tint: '#eef4fb', // pale panel fills
};

export const COLOR_ROLES = [
  { key: 'primary', label: 'Headings & section bars', hint: 'The main brand colour. Used for titles, the cover and every section header.' },
  { key: 'accent', label: 'Prices & highlights', hint: 'Draws the eye to the package price and call-outs.' },
  { key: 'text', label: 'Body text', hint: 'Paragraphs and table content.' },
  { key: 'soft', label: 'Borders', hint: 'Hairlines around cards and tables.' },
  { key: 'tint', label: 'Panel background', hint: 'The pale fill behind boxed sections.' },
];

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A usable CSS colour, or null. Anything else is ignored rather than passed into the
 *  stylesheet, where a malformed value silently breaks the rule it belongs to. */
export function cleanColor(v) {
  const s = String(v ?? '').trim();
  return HEX.test(s) ? s.toLowerCase() : null;
}

/** Lighten/darken a hex colour by `amt` (-1..1). Used to derive the few shades the document
 *  needs either side of the chosen primary, so a tenant picks one colour and not four. */
export function shade(hex, amt) {
  const c = cleanColor(hex);
  if (!c) return hex;
  const n = parseInt(c.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const next = amt >= 0 ? v + (255 - v) * amt : v * (1 + amt);
    return Math.max(0, Math.min(255, Math.round(next)));
  });
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Readable foreground for a given background — white on dark, near-black on light. */
export function readableOn(hex) {
  const c = cleanColor(hex);
  if (!c) return '#ffffff';
  const n = parseInt(c.slice(1), 16);
  // Rec. 601 luma: good enough for picking between two fixed foregrounds.
  const luma = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return luma > 150 ? '#13233a' : '#ffffff';
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * The colours this organization's quotation should use, with every unset or malformed role
 * falling back to the document's original value.
 */
export function resolveColors(org) {
  const chosen = org?.quotation?.colors || {};
  const out = { ...DEFAULT_COLORS };
  for (const key of Object.keys(DEFAULT_COLORS)) {
    const c = cleanColor(chosen[key]);
    if (c) out[key] = c;
  }
  // A couple of shades the stylesheet needs that nobody should have to choose by hand.
  out.primaryDark = shade(out.primary, -0.25);
  out.primaryLight = shade(out.primary, 0.12);
  out.onPrimary = readableOn(out.primary);
  return out;
}

/**
 * Terms & Conditions sections, in order. Falls back to the static config when the tenant has
 * never edited them — an empty stored array is NOT a fallback, because deleting every section
 * is a deliberate choice and must be honoured.
 */
export function resolveTerms(org) {
  const stored = org?.quotation?.terms;
  if (!Array.isArray(stored)) return Array.isArray(company.termsAndConditions) ? company.termsAndConditions : [];
  return [...stored]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => ({
      heading: s.heading || '',
      intro: s.intro || '',
      boxTitle: s.boxTitle || '',
      table: s.table?.rows?.length ? { headers: s.table.headers || [], rows: s.table.rows } : undefined,
      items: (s.items || []).filter((x) => !isBlank(x)),
    }));
}

/** The booking-terms one-liner printed under the price. */
export function resolveBookingTerms(org) {
  const v = org?.quotation?.bookingTerms;
  return isBlank(v) ? company.bookingTerms || '' : String(v).trim();
}

/** Normalizes the words a banner matches on. */
const keywordsOf = (banner) =>
  String(banner?.match || banner?.label || '')
    .split('|')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Picks the cover banner for one quotation.
 *
 * Checked in order of how specific the evidence is:
 *   1. a banner pinned to one of the trip's Destination rows
 *   2. a banner whose keywords appear in a destination name or a hotel city
 *   3. the organization's default banner
 *   4. whatever the static config supplied (the behaviour before this existed)
 *
 * Keyword matching walks the NAMES in the order given, not the banners: the caller passes
 * destination names first, then hotel cities, then the package name, and the first name that
 * matches any banner wins. Walking banners instead would let a package still titled "Kashmir
 * Group Tour" put a Kashmir cover on a trip whose destination and every hotel say Andaman —
 * the stalest field in the quote would outvote the freshest ones.
 *
 * @param {object}   org
 * @param {object}   trip
 * @param {string[]} trip.destinationIds  Destination ids on the query/quote
 * @param {string[]} trip.names           destination names, then cities, then package name
 * @returns {{image: string|null, source: string}}  `source` explains the choice, for debugging
 */
export function pickBanner(org, { destinationIds = [], names = [] } = {}) {
  const banners = (org?.quotation?.banners || [])
    .filter((b) => b && b.image)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (banners.length) {
    const wantedIds = destinationIds.map((d) => String(d?._id || d)).filter(Boolean);
    const byId = banners.find((b) => b.destination && wantedIds.includes(String(b.destination)));
    if (byId) return { image: byId.image, source: 'destination:' + byId.label };

    for (const raw of names) {
      const name = String(raw || '').toLowerCase().trim();
      if (!name) continue;
      // Banner order still breaks ties between two banners matching the SAME name.
      const hit = banners.find((b) => keywordsOf(b).some((k) => name.includes(k)));
      if (hit) return { image: hit.image, source: 'keyword:' + hit.label };
    }
  }

  const fallback = org?.quotation?.defaultBanner;
  if (fallback) return { image: fallback, source: 'default' };
  return { image: null, source: 'config' };
}

/** Everything the renderer needs, in one object. */
export function resolveQuotationTheme(org, trip) {
  return {
    colors: resolveColors(org),
    banner: pickBanner(org, trip),
    terms: resolveTerms(org),
    bookingTerms: resolveBookingTerms(org),
  };
}

/**
 * The `:root` block injected into the document's stylesheet. The renderer's hard-coded hexes
 * were replaced with these variables, so one declaration re-themes the whole document.
 */
export function themeCss(colors) {
  return `:root{
  --q-primary:${colors.primary};
  --q-primary-dark:${colors.primaryDark};
  --q-primary-light:${colors.primaryLight};
  --q-on-primary:${colors.onPrimary};
  --q-accent:${colors.accent};
  --q-text:${colors.text};
  --q-soft:${colors.soft};
  --q-tint:${colors.tint};
}`;
}
