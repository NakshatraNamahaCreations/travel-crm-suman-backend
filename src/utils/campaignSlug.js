// Builds the campaign names and tracking URLs the Tracking Links page hands out.
//
// The naming convention is enforced rather than suggested. Campaign names are the join key
// between the ad platforms and these reports: once an agent types "Diwali Offer" in one place
// and "diwali-offer-2026" in another, the two halves of the same spend stop adding up and no
// later cleanup can tell them apart.
//
//   {prefix}-{platform}-{campaign}-{service}-{city}-{yyyymm}
//   irs-meta-diwali-offer-maldives-mdu-202611

/** URL/platform-safe token: lowercase, non-alphanumerics collapsed to single hyphens. */
export function slug(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** YYYYMM for the month a campaign belongs to. */
export function monthStamp(date = new Date()) {
  const d = new Date(date);
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0');
}

/**
 * Assembles a campaign name from its parts, dropping any that are blank so a link built
 * without a city does not end up with a double hyphen where the city should have been.
 */
export function buildCampaignName({ prefix = 'crm', platform, name, service, city, at } = {}) {
  return [slug(prefix), slug(platform), slug(name), slug(service), slug(city), monthStamp(at)]
    .filter(Boolean)
    .join('-');
}

/**
 * Appends UTM parameters to a target URL, keeping any query string the page already has and
 * replacing an existing tag of the same name rather than adding a second copy of it.
 */
export function buildTrackingUrl(targetUrl, params = {}) {
  const raw = String(targetUrl || '').trim();
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!raw) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    for (const [k, v] of pairs) u.searchParams.set(k, String(v));
    return u.toString();
  } catch {
    // Unparseable target (a path, a typo mid-edit): still produce something copyable rather
    // than an empty box, since this value is shown live as the agent types.
    const qs = pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
    if (!qs) return raw;
    return raw + (raw.includes('?') ? '&' : '?') + qs;
  }
}

/** The utm_* set a destination implies, ready to merge into buildTrackingUrl. */
export function utmParams({ source, medium, campaign, content, term, id } = {}) {
  const out = {};
  if (source) out.utm_source = source;
  if (medium) out.utm_medium = medium;
  if (campaign) out.utm_campaign = campaign;
  if (content) out.utm_content = slug(content);
  if (term) out.utm_term = slug(term);
  if (id) out.utm_id = id;
  return out;
}

/** Short, unambiguous code for a shareable /r/<code> redirect. Excludes vowels and the
 *  characters people mistype reading a code off a printed flyer (0/O, 1/I/l). */
const CODE_ALPHABET = '23456789bcdfghjkmnpqrstvwxyz';
export function shortCode(len = 7) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}
