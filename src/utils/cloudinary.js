import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';

// Cloudinary is optional: with no credentials configured, callers fall back
// to storing images inline (data URIs). Configure via CLOUDINARY_URL or the
// CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET trio in server/.env.
let configured = false;
function ensureConfig() {
  if (configured) return true;
  const { url, cloudName, apiKey, apiSecret } = env.cloudinary;
  // Always configure explicitly — the SDK only auto-reads CLOUDINARY_URL if it
  // was in process.env before the SDK loaded, which dotenv can't guarantee.
  let creds = null;
  if (cloudName && apiKey && apiSecret) {
    creds = { cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret };
  } else if (url) {
    const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (m) creds = { api_key: m[1], api_secret: m[2], cloud_name: m[3] };
  }
  if (creds) {
    cloudinary.config({ ...creds, secure: true });
    configured = true;
  }
  return configured;
}

export const cloudinaryEnabled = () => ensureConfig();

/**
 * Upload an image (data URI or remote URL) to Cloudinary.
 * A fixed publicId per slot (e.g. "travel-crm/org/logo") means replacing an
 * image overwrites the previous one — no orphaned assets pile up.
 * Returns the secure URL, or null when Cloudinary isn't configured.
 */
export async function uploadImage(src, publicId) {
  if (!ensureConfig()) return null;
  const res = await cloudinary.uploader.upload(src, {
    public_id: publicId,
    overwrite: true,
    invalidate: true,
    resource_type: 'image',
  });
  return res.secure_url;
}

/**
 * Upload an ad-hoc image (e.g. a hotel/activity/transport photo picked from
 * the user's device) into a folder, letting Cloudinary generate a unique
 * public_id — unlike uploadImage, nothing here is ever meant to overwrite a
 * previous asset. Returns the secure URL, or null when Cloudinary isn't configured.
 */
export async function uploadImageUnique(src, folder) {
  if (!ensureConfig()) return null;
  const res = await cloudinary.uploader.upload(src, { folder, resource_type: 'image' });
  return res.secure_url;
}
