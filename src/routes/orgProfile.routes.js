import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { uploadImage, uploadImageUnique, cloudinaryEnabled } from '../utils/cloudinary.js';
import { DEFAULT_COLORS, COLOR_ROLES, cleanColor } from '../utils/quotationTheme.js';
import { QUOTATION_TEMPLATES } from '../pdf/renderQuotation.js';


const router = Router();
router.use(protect);

// Caps. A quotation with forty cover banners is a mistake rather than a requirement, and
// without a limit one tenant's settings document can grow until it is slow to load on every
// PDF render.
const MAX_BANNERS = 30;
const MAX_TERM_SECTIONS = 40;
const MAX_TERM_ITEMS = 60;

/** Pushes a freshly-picked image to Cloudinary and keeps only the CDN url. Falls back to
 *  storing the data URI inline, because a quotation that renders with a heavy inline image is
 *  better than one whose cover silently vanished. */
async function hostImage(value, { publicId, folder } = {}) {
  if (typeof value !== 'string' || !value.startsWith('data:')) return value;
  if (!cloudinaryEnabled()) return value;
  try {
    // A fixed public id overwrites the previous image in that slot (logo, default banner);
    // a folder mints a new id each time, which is what a list of banners needs — replacing
    // one must not silently overwrite another's artwork.
    const url = publicId ? await uploadImage(value, publicId) : await uploadImageUnique(value, folder);
    return url || value;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[cloudinary] upload failed for ${publicId || folder}: ${err.message} — storing inline`);
    return value;
  }
}

/** Validates and normalizes the quotation block. Throws a message an agent can act on rather
 *  than letting a bad value reach the stylesheet, where it breaks the rule it belongs to and
 *  shows up as an oddly-coloured PDF nobody can explain. */
function cleanQuotation(input) {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object') throw ApiError.badRequest('Invalid quotation settings');
  const out = {};

  if (input.template !== undefined) {
    if (!QUOTATION_TEMPLATES.some((t) => t.key === input.template)) {
      throw ApiError.badRequest(`Unknown layout: ${input.template}`);
    }
    out.template = input.template;
  }
  if (input.tagline !== undefined) out.tagline = String(input.tagline || '').trim().slice(0, 120) || undefined;
  if (input.watermark !== undefined) out.watermark = String(input.watermark ?? '').trim().slice(0, 60);
  if (input.watermarkOff !== undefined) out.watermarkOff = !!input.watermarkOff;
  if (input.whyUs !== undefined) {
    if (!Array.isArray(input.whyUs)) throw ApiError.badRequest('Why-us points must be a list');
    out.whyUs = input.whyUs
      .map((w) => ({ title: String(w?.title || '').trim().slice(0, 80), text: String(w?.text || '').trim().slice(0, 300) }))
      .filter((w) => w.title || w.text)
      .slice(0, 12);
  }

  if (input.colors !== undefined) {
    const colors = {};
    for (const role of COLOR_ROLES) {
      const raw = input.colors?.[role.key];
      if (raw === undefined || raw === null || raw === '') continue;
      const c = cleanColor(raw);
      if (!c) throw ApiError.badRequest(`"${raw}" is not a colour — use a hex value like ${DEFAULT_COLORS[role.key]}`);
      colors[role.key] = c;
    }
    out.colors = colors;
  }

  if (input.banners !== undefined) {
    if (!Array.isArray(input.banners)) throw ApiError.badRequest('Banners must be a list');
    if (input.banners.length > MAX_BANNERS) throw ApiError.badRequest(`At most ${MAX_BANNERS} banners`);
    out.banners = input.banners.map((b, i) => {
      const label = String(b?.label || '').trim();
      if (!label) throw ApiError.badRequest(`Banner ${i + 1} needs a name, so you can tell them apart`);
      return {
        _id: b._id,
        label: label.slice(0, 60),
        destination: b.destination || undefined,
        match: String(b.match || '').trim().slice(0, 200) || undefined,
        image: b.image || undefined,
        order: Number.isFinite(Number(b.order)) ? Number(b.order) : i,
      };
    });
  }

  if (input.defaultBanner !== undefined) out.defaultBanner = input.defaultBanner || undefined;

  if (input.terms !== undefined) {
    if (!Array.isArray(input.terms)) throw ApiError.badRequest('Terms must be a list');
    if (input.terms.length > MAX_TERM_SECTIONS) throw ApiError.badRequest(`At most ${MAX_TERM_SECTIONS} terms sections`);
    out.terms = input.terms.map((s, i) => {
      const heading = String(s?.heading || '').trim();
      if (!heading) throw ApiError.badRequest(`Terms section ${i + 1} needs a heading`);
      const items = (Array.isArray(s.items) ? s.items : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, MAX_TERM_ITEMS);
      const rows = Array.isArray(s.table?.rows)
        ? s.table.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : [])).filter((r) => r.some(Boolean))
        : [];
      return {
        _id: s._id,
        heading: heading.slice(0, 160),
        intro: String(s.intro || '').trim() || undefined,
        boxTitle: String(s.boxTitle || '').trim() || undefined,
        table: rows.length ? { headers: (s.table.headers || []).map((h) => String(h || '').trim()), rows } : undefined,
        items,
        order: Number.isFinite(Number(s.order)) ? Number(s.order) : i,
      };
    });
  }

  if (input.bookingTerms !== undefined) out.bookingTerms = String(input.bookingTerms || '').trim().slice(0, 600) || undefined;
  return out;
}

// GET /api/org-profile — any signed-in user (needed to render invoices)
router.get('/', asyncHandler(async (req, res) => ok(res, await OrgProfile.getFor(req.organizationId))));

// GET /api/org-profile/quotation-defaults — the palette and starter Terms the document falls
// back to, so the editor can offer "reset to default" without hard-coding a second copy of them.
router.get('/quotation-defaults', asyncHandler(async (req, res) => ok(res, {
  colors: DEFAULT_COLORS,
  templates: QUOTATION_TEMPLATES,
  roles: COLOR_ROLES,
  // No starter text: the sections the static config held were one real agency's, and
  // another agency must not issue them under its own name. An empty list means the editor
  // offers nothing to reset to, which is the honest answer.
  terms: [],
  bookingTerms: '',
})));

// PUT /api/org-profile — admins/managers edit the org details
router.put('/', can('settings.edit'), asyncHandler(async (req, res) => {
  const doc = await OrgProfile.getFor(req.organizationId);
  const { _id, organization, createdAt, updatedAt, quotation, ...patch } = req.body || {};

  // Freshly-uploaded images arrive as data URIs. With Cloudinary configured
  // they're pushed there (fixed public_id per slot → replacing overwrites)
  // and only the CDN URL is stored; otherwise the data URI is kept inline.
  if (patch.images && cloudinaryEnabled()) {
    for (const [key, val] of Object.entries(patch.images)) {
      if (typeof val === 'string' && val.startsWith('data:')) {
        patch.images[key] = await hostImage(val, { publicId: `travel-crm/org/${req.organizationId}/${key}` });
      }
    }
  }

  const nextQuotation = cleanQuotation(quotation);
  if (nextQuotation) {
    // Cover banners are full-width artwork, far larger than a logo — they go to the CDN under
    // their own ids rather than inline, or every PDF render would carry megabytes of base64.
    if (nextQuotation.banners) {
      for (const b of nextQuotation.banners) {
        b.image = await hostImage(b.image, { folder: `travel-crm/org/${req.organizationId}/quote-banners` });
      }
    }
    if (nextQuotation.defaultBanner) {
      nextQuotation.defaultBanner = await hostImage(nextQuotation.defaultBanner, { publicId: `travel-crm/org/${req.organizationId}/quote-default-banner` });
    }
    doc.quotation = { ...(doc.quotation?.toObject?.() || doc.quotation || {}), ...nextQuotation };
    doc.markModified('quotation');
  }

  Object.assign(doc, patch);
  await doc.save();
  return ok(res, doc);
}));

export default router;
