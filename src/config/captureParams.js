// Catalog of everything the website tracking script can record about a visit, and the
// attribution field each value is saved into.
//
// `field` is a path inside Query.attribution (see models/Query.js). A tenant may re-point a
// row at a different field name from the UTM Capture page, which is why the mapping is stored
// per organization rather than hard-wired here — this file only supplies the defaults and the
// "recommended" on/off state.
//
// `aliases` exists because one value arrives under several query-string names: Google sends
// gclid normally but gbraid/wbraid when iOS App Tracking Transparency blocks the usual click
// id, and all three mean the same thing to us.

export const CAPTURE_GROUPS = [
  {
    key: 'utm',
    label: 'Campaign tags (UTM)',
    note: 'Added to links by you or the ad platform',
    // UTM values are lowercased/trimmed by the cleanup rule; click ids and visit facts are not.
    clean: true,
    params: [
      { key: 'utm_source', label: 'Who sent the visitor', field: 'source', example: 'ig', on: true },
      { key: 'utm_medium', label: 'Type of traffic', field: 'medium', example: 'paid_social', on: true },
      { key: 'utm_campaign', label: 'Campaign name', field: 'campaign', example: 'irs-meta-reels-maldives-202611', on: true },
      { key: 'utm_content', label: 'Ad or creative', field: 'content', example: 'reel-1', on: true },
      { key: 'utm_term', label: 'Keyword or audience', field: 'term', example: 'maldives honeymoon package', on: true },
      { key: 'utm_id', label: 'Campaign ID', field: 'campaignId', example: '120211458830450', on: true },
    ],
  },
  {
    key: 'click',
    label: 'Ad click IDs',
    note: 'Added by the ad platforms themselves. Required to report sales back to them.',
    params: [
      { key: 'gclid', aliases: ['gbraid', 'wbraid'], label: 'Google Ads click', field: 'clickIds.google', example: 'Cj0KCQjw2...BwE', on: true },
      { key: 'fbclid', label: 'Facebook / Instagram click', field: 'clickIds.meta', example: 'IwZXh0bgNhZW0...', on: true },
      { key: 'ctwa_clid', label: 'WhatsApp ad click', field: 'clickIds.whatsapp', example: 'ARAkLkA8...', on: true },
      { key: 'msclkid', label: 'Microsoft Bing click', field: 'clickIds.bing', example: 'a1b2c3...', on: false },
      { key: 'li_fat_id', label: 'LinkedIn click', field: 'clickIds.linkedin', example: 'e5f6...', on: false },
    ],
  },
  {
    key: 'visit',
    label: 'Visit details',
    note: 'Recorded by the tracking code — no tags needed',
    params: [
      { key: 'landing_page', label: 'First page they opened', field: 'landingPage', example: '/maldives-packages', on: true, derived: true },
      { key: 'referrer', label: 'Website they came from', field: 'referrer', example: 'l.instagram.com', on: true, derived: true },
      { key: 'form_page', label: 'Page where they enquired', field: 'conversionPage', example: '/maldives-packages', on: true, derived: true },
      { key: 'device', label: 'Mobile or desktop', field: 'device', example: 'Mobile, Android', on: true, derived: true },
      { key: 'city', label: 'City from IP', field: 'visitorCity', example: 'Chennai', on: true, derived: true },
      { key: 'visits', label: 'Visits before enquiring', field: 'visitCount', example: '3', on: true, derived: true },
      { key: 'first_seen', label: 'Date of first visit', field: 'firstSeenAt', example: '14 Oct 2026', on: true, derived: true },
      { key: 'ga_client_id', label: 'GA4 client ID', field: 'gaClientId', example: 'GA1.1.2041...', on: false, derived: true },
    ],
  },
];

// Flat lookup of every catalog param, by its query-string key.
export const CAPTURE_PARAMS = CAPTURE_GROUPS.flatMap((g) =>
  g.params.map((p) => ({ ...p, group: g.key, clean: !!g.clean }))
);

export const captureParam = (key) => CAPTURE_PARAMS.find((p) => p.key === key) || null;

// Every query-string name worth reading, aliases included.
export const ALL_CAPTURE_KEYS = CAPTURE_PARAMS.flatMap((p) => [p.key, ...(p.aliases || [])]);

// The shape stored on LeadSettings.capture.params when a tenant has never touched the page.
export const defaultCaptureParams = () =>
  CAPTURE_PARAMS.map((p) => ({ key: p.key, field: p.field, enabled: p.on }));

// Attribution paths the UI must not let a tenant point two different params at, because the
// classification and the reports read them by name.
export const RESERVED_FIELDS = ['channel', 'firstChannel', 'lastChannel', 'tracked', 'touches', 'raw'];

export const TOUCH_MODES = [
  { key: 'both', label: 'First and last visit (recommended)', description: 'Saves where they first found you and what made them enquire. Reports can credit either.' },
  { key: 'first', label: 'First visit only', description: 'Credit goes to whatever created the interest.' },
  { key: 'last', label: 'Last visit only', description: 'Credit goes to what made them enquire. Simplest, but hides early sources like Instagram and blogs.' },
];

export const RETENTION_CHOICES = [30, 60, 90, 180];
