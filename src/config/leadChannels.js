// Lead acquisition channels — the coarse "where did this lead come from" bucket.
//
// Deliberately a FIXED list rather than tenant master data: the classification waterfall in
// utils/leadChannel.js decides a channel from tracking parameters, so a tenant inventing its
// own channel would produce a value nothing can ever assign. Tenant-specific naming lives on
// QuerySource (which stays the editable list agents pick from by hand).
//
// `source` is the QuerySource name a classified lead is mapped onto, so the existing
// sales-report breakdown (?by=source) keeps working for automatically captured leads.

export const LEAD_CHANNELS = [
  { key: 'google_ads', label: 'Google Ads', description: 'Search and Performance Max ads', icon: 'G', color: '#2a78d6', paid: true, source: 'Google Ads' },
  { key: 'meta_ads', label: 'Facebook & Instagram', description: 'Meta ads, instant forms, WhatsApp ads', icon: 'f', color: '#eb6834', paid: true, source: 'Meta Ads' },
  { key: 'organic', label: 'Google Search (free)', description: 'SEO: the guest found your website', icon: 'S', color: '#1baf7a', source: 'Website' },
  { key: 'blog', label: 'Blog articles', description: 'Readers of your travel blog', icon: 'B', color: '#eda100', source: 'Website' },
  { key: 'referral', label: 'Referrals', description: 'Other websites and partners', icon: 'R', color: '#e87ba4', source: 'Referral' },
  { key: 'offline', label: 'WhatsApp, SMS & Offline', description: 'Broadcasts, flyers, QR codes', icon: 'W', color: '#6250d6', source: 'WhatsApp' },
  { key: 'direct', label: 'Direct / Unknown', description: 'Typed your URL, or no tracking', icon: 'D', color: '#64748b', source: 'Website' },
];

export const LEAD_CHANNEL_KEYS = LEAD_CHANNELS.map((c) => c.key);

// The bucket a lead falls into when nothing identifies it. Also what an agent-entered query
// with no tracking gets, which is why 'direct' is labelled "Direct / Unknown" and not "Direct".
export const DEFAULT_CHANNEL = 'direct';

export const channelMeta = (key) =>
  LEAD_CHANNELS.find((c) => c.key === key) || LEAD_CHANNELS.find((c) => c.key === DEFAULT_CHANNEL);

export const isPaidChannel = (key) => !!channelMeta(key).paid;

// Destinations offered by the tracking-link builder. Each pins the utm_source/utm_medium pair
// the link will carry, which is what makes the classification land on the intended channel.
export const LINK_DESTINATIONS = [
  { key: 'meta', label: 'Facebook / Instagram ad', icon: 'f', color: '#eb6834', source: 'ig', medium: 'paid_social', platform: 'meta', channel: 'meta_ads', autoTemplate: true },
  { key: 'google', label: 'Google ad', icon: 'G', color: '#2a78d6', source: 'google', medium: 'cpc', platform: 'google', channel: 'google_ads', autoTemplate: true },
  { key: 'whatsapp', label: 'WhatsApp message', icon: 'W', color: '#128C7E', source: 'whatsapp', medium: 'broadcast', platform: 'wa', channel: 'offline' },
  { key: 'email', label: 'Email', icon: '@', color: '#0D1B3E', source: 'newsletter', medium: 'email', platform: 'email', channel: 'offline' },
  { key: 'qr', label: 'Flyer / hoarding QR', icon: 'Q', color: '#6250d6', source: 'flyer', medium: 'offline', platform: 'offline', channel: 'offline' },
  { key: 'partner', label: 'Influencer / partner', icon: '*', color: '#e87ba4', source: 'partner', medium: 'partner', platform: 'partner', channel: 'referral' },
];

export const linkDestination = (key) => LINK_DESTINATIONS.find((d) => d.key === key) || null;

// Pasted once per ad account instead of building a link per ad — the platform substitutes the
// campaign/ad names itself. Shown on the Tracking Links page.
export const AD_PLATFORM_TEMPLATES = {
  meta: {
    label: 'Meta Ads Manager',
    where: 'Ad › Tracking › URL parameters',
    value: 'utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}',
  },
  google: {
    label: 'Google Ads',
    where: 'Admin › Account settings › Tracking › Final URL suffix (with auto-tagging on)',
    value: 'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}&utm_id={campaignid}',
  },
};
