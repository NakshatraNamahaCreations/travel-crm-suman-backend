import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { uploadImage, cloudinaryEnabled } from '../utils/cloudinary.js';

const router = Router();
router.use(protect);

// GET /api/org-profile — any signed-in user (needed to render invoices)
router.get('/', asyncHandler(async (req, res) => ok(res, await OrgProfile.getFor(req.organizationId))));

// PUT /api/org-profile — admins/managers edit the org details
router.put('/', can('settings.edit'), asyncHandler(async (req, res) => {
  const doc = await OrgProfile.getFor(req.organizationId);
  const { _id, organization, createdAt, updatedAt, ...patch } = req.body || {};

  // Freshly-uploaded images arrive as data URIs. With Cloudinary configured
  // they're pushed there (fixed public_id per slot → replacing overwrites)
  // and only the CDN URL is stored; otherwise the data URI is kept inline.
  if (patch.images && cloudinaryEnabled()) {
    for (const [key, val] of Object.entries(patch.images)) {
      if (typeof val === 'string' && val.startsWith('data:')) {
        try {
          patch.images[key] = await uploadImage(val, `travel-crm/org/${req.organizationId}/${key}`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[cloudinary] upload failed for ${key}: ${err.message} — storing inline`);
        }
      }
    }
  }

  Object.assign(doc, patch);
  await doc.save();
  return ok(res, doc);
}));

export default router;
