import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ok } from '../utils/apiResponse.js';
import { uploadImageUnique, cloudinaryEnabled } from '../utils/cloudinary.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const router = Router();

// POST /api/uploads/image (multipart: file) — generic "pick an image from
// your device" endpoint backing every Image URL field (hotels, transport,
// activities, …) alongside the option to paste an external link.
router.post('/image', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  if (!cloudinaryEnabled()) throw ApiError.badRequest('Image hosting is not configured — set CLOUDINARY_* in server/.env');
  if (!req.file.mimetype?.startsWith('image/')) throw ApiError.badRequest('Only image files are supported');

  const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const url = await uploadImageUnique(dataUri, `travel-crm/${req.organizationId}/uploads`);
  return ok(res, { url });
}));

export default router;
