import { TrackingLink } from '../models/TrackingLink.js';
import { Query } from '../models/Query.js';
import { LeadSettings } from '../models/LeadSettings.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { LINK_DESTINATIONS, linkDestination, AD_PLATFORM_TEMPLATES, channelMeta } from '../config/leadChannels.js';
import { buildCampaignName, buildTrackingUrl, utmParams, slug, shortCode } from '../utils/campaignSlug.js';
import { ownScope } from '../utils/ownScope.js';

const WON = ['converted', 'on_trip', 'past'];
const MAX_URL = 2048;

/** Validated target URL. http(s) only — a javascript: or data: URL here would be handed
 *  straight back out of the public /r/<code> redirect as an open redirect for anyone. */
function cleanTargetUrl(raw) {
  const v = String(raw || '').trim().slice(0, MAX_URL);
  if (!v) throw ApiError.badRequest('Where should people land? Paste the page address.');
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v);
  } catch {
    throw ApiError.badRequest('"' + v + '" is not a valid web address');
  }
  if (!/^https?:$/.test(u.protocol)) throw ApiError.badRequest('The link must start with http:// or https://');
  if (!u.hostname.includes('.')) throw ApiError.badRequest('That address has no domain name in it');
  return u.toString();
}

/** Assembles the campaign name and finished URL from the builder's inputs. */
function composeLink(body, prefix) {
  const dest = linkDestination(String(body.destination || '').trim());
  if (!dest) throw ApiError.badRequest('Pick where the link will be shared');
  const targetUrl = cleanTargetUrl(body.targetUrl);

  const name = String(body.name || '').trim();
  if (!name) throw ApiError.badRequest('Give the campaign a name, in plain words');

  const campaign = buildCampaignName({
    prefix,
    platform: dest.platform,
    name,
    service: body.service,
    city: body.city,
    at: body.at ? new Date(body.at) : new Date(),
  });

  const params = utmParams({
    source: dest.source,
    medium: dest.medium,
    campaign,
    content: body.version,
  });
  return {
    dest,
    targetUrl,
    campaign,
    params,
    url: buildTrackingUrl(targetUrl, params),
    content: params.utm_content || null,
  };
}

// POST /api/leads/tracking-links/preview — live output as the agent types. Saves nothing.
export const previewLink = asyncHandler(async (req, res) => {
  const settings = await LeadSettings.getFor();
  const { dest, targetUrl, campaign, params, url } = composeLink(req.body || {}, settings.campaignPrefix);
  const meta = channelMeta(dest.channel);

  return ok(res, {
    campaign,
    url,
    targetUrl,
    params: Object.entries(params),
    shortUrlExample: env.publicBaseUrl + '/api/public/r/' + shortCode(),
    destination: {
      key: dest.key, label: dest.label, icon: dest.icon, color: dest.color,
      source: dest.source, medium: dest.medium, channel: dest.channel, autoTemplate: !!dest.autoTemplate,
    },
    hint: dest.key === 'whatsapp' || dest.key === 'qr'
      ? 'Save the link to get a short address — a URL with five tags on it is unusable in a message or under a QR code.'
      : 'Leads from this link will show as ' + meta.label + '.',
    // Offered only where the platform can fill the names itself; for a flyer there is nothing
    // to automate and showing an empty callout would just be noise.
    platformTemplate: dest.autoTemplate ? AD_PLATFORM_TEMPLATES[dest.platform] || null : null,
    destinations: LINK_DESTINATIONS.map((d) => ({ key: d.key, label: d.label, icon: d.icon, color: d.color, autoTemplate: !!d.autoTemplate })),
  });
});

/** Mints a short code, retrying on the unique-index collision rather than trusting randomness.
 *  28^7 is roomy, but "roomy" is not "never". */
async function mintCode() {
  for (let i = 0; i < 6; i++) {
    const code = shortCode(7);
    const taken = await TrackingLink.findOne({ code }).select('_id').setOptions({ skipTenant: true }).lean();
    if (!taken) return code;
  }
  return shortCode(10);
}

// POST /api/leads/tracking-links
export const createLink = asyncHandler(async (req, res) => {
  const settings = await LeadSettings.getFor();
  const b = req.body || {};
  const { dest, targetUrl, campaign, params, url, content } = composeLink(b, settings.campaignPrefix);

  const label = String(b.label || b.name || '').trim();
  if (!label) throw ApiError.badRequest('Give the link a name you will recognise later');

  // Same campaign tag twice would split one campaign's results across two rows that can never
  // be told apart afterwards.
  const clash = await TrackingLink.findOne({ campaign }).select('label').lean();
  if (clash) {
    throw ApiError.conflict('"' + clash.label + '" already uses the campaign tag ' + campaign
      + '. Change the campaign name, city or service to tell them apart.');
  }

  const link = await TrackingLink.create({
    label: label.slice(0, 120),
    destination: dest.key,
    channel: dest.channel,
    targetUrl,
    campaign,
    source: params.utm_source,
    medium: params.utm_medium,
    content,
    term: params.utm_term,
    url,
    code: await mintCode(),
    notes: String(b.notes || '').trim().slice(0, 500) || undefined,
    createdBy: req.user._id,
  });

  return created(res, shapeLink(link.toObject(), { leads: 0, conversion: 0, revenue: 0 }, req.user));
});

function shapeLink(l, stats, creator) {
  return {
    _id: l._id,
    label: l.label,
    destination: l.destination,
    channel: l.channel,
    channelLabel: channelMeta(l.channel).label,
    targetUrl: l.targetUrl,
    campaign: l.campaign,
    url: l.url,
    code: l.code,
    shortUrl: l.code ? env.publicBaseUrl + '/api/public/r/' + l.code : null,
    clicks: l.clicks || 0,
    lastClickAt: l.lastClickAt || null,
    leads: stats.leads,
    conversion: stats.conversion,
    conversionPct: stats.leads ? Math.round((stats.conversion / stats.leads) * 100) : 0,
    revenue: Math.round(stats.revenue || 0),
    isActive: l.isActive !== false,
    notes: l.notes || null,
    createdAt: l.createdAt,
    createdBy: l.createdBy?.name ? l.createdBy : creator ? { _id: creator._id, name: creator.name } : null,
  };
}

// GET /api/leads/tracking-links
export const listLinks = asyncHandler(async (req, res) => {
  const links = await TrackingLink.find().sort('-createdAt').limit(300).populate('createdBy', 'name').lean();
  if (!links.length) return ok(res, { items: [] });

  // Leads are matched by campaign tag, not by link id: a lead that arrived through the ad
  // platform's own template never passed through our redirect, but it still carries the
  // campaign name, and those are exactly the leads this table exists to count.
  const campaigns = links.map((l) => l.campaign);
  const rows = await Query.aggregate([
    {
      $match: {
        $or: [
          { 'attribution.last.campaign': { $in: campaigns } },
          { 'attribution.first.campaign': { $in: campaigns } },
        ],
        ...ownScope(req.user),
      },
    },
    { $addFields: { _camp: { $ifNull: ['$attribution.last.campaign', '$attribution.first.campaign'] } } },
    {
      $group: {
        _id: '$_camp',
        leads: { $sum: 1 },
        conversion: { $sum: { $cond: [{ $in: ['$status', WON] }, 1, 0] } },
        revenue: { $sum: { $cond: [{ $in: ['$status', WON] }, { $ifNull: ['$bookedAmount', 0] }, 0] } },
      },
    },
  ]);
  const byCampaign = new Map(rows.map((r) => [r._id, r]));

  return ok(res, {
    items: links.map((l) => shapeLink(l, byCampaign.get(l.campaign) || { leads: 0, conversion: 0, revenue: 0 })),
    destinations: LINK_DESTINATIONS.map((d) => ({ key: d.key, label: d.label, icon: d.icon, color: d.color, autoTemplate: !!d.autoTemplate })),
  });
});

// PATCH /api/leads/tracking-links/:id — rename, pause, or re-note. The campaign tag and URL
// are deliberately immutable: a link already printed on a flyer or live in an ad account
// cannot be changed, and editing the tag would orphan every lead already attributed to it.
export const updateLink = asyncHandler(async (req, res) => {
  const link = await TrackingLink.findById(req.params.id);
  if (!link) throw ApiError.notFound('Link not found');
  const b = req.body || {};
  if (b.label !== undefined) {
    const v = String(b.label || '').trim();
    if (!v) throw ApiError.badRequest('The link needs a name');
    link.label = v.slice(0, 120);
  }
  if (b.isActive !== undefined) link.isActive = !!b.isActive;
  if (b.notes !== undefined) link.notes = String(b.notes || '').trim().slice(0, 500) || undefined;
  await link.save();
  return ok(res, shapeLink(link.toObject(), { leads: 0, conversion: 0, revenue: 0 }));
});

// DELETE /api/leads/tracking-links/:id
export const removeLink = asyncHandler(async (req, res) => {
  const link = await TrackingLink.findById(req.params.id);
  if (!link) throw ApiError.notFound('Link not found');

  // Leads already attributed to this campaign keep their attribution — it is a copy on the
  // lead, not a reference — but the short code stops resolving, which breaks a printed QR
  // code for good. Pausing is the reversible option, so say so.
  const used = await Query.countDocuments({
    $or: [{ 'attribution.last.campaign': link.campaign }, { 'attribution.first.campaign': link.campaign }],
  });
  if (used > 0 && !req.query.force) {
    throw ApiError.conflict(used + ' lead' + (used === 1 ? ' has' : 's have') + ' come through this link. '
      + 'Pause it instead to stop using it, or delete with ?force=1 to remove it anyway — any printed QR code will stop working.');
  }
  await link.deleteOne();
  return ok(res, { _id: link._id, deleted: true });
});
