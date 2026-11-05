import dotenv from 'dotenv';

dotenv.config();

const required = ['MONGODB_URI', 'JWT_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.warn(`[env] Missing variables: ${missing.join(', ')} — check server/.env`);
}

// CLIENT_URL may hold one or many comma-separated origins. Entries without a
// scheme are assumed https (so "site.netlify.app" → "https://site.netlify.app").
const clientUrls = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (/^https?:\/\//i.test(s) ? s : `https://${s}`))
  .map((s) => s.replace(/\/+$/, ''));

export const env = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/travel_crm',
  jwtSecret: process.env.JWT_SECRET || 'insecure-dev-secret',
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  clientUrls,
  clientUrl: clientUrls[0],
  // Absolute origin of THIS API, used to build customer-facing document
  // links (quotation / receipt / GST invoice) that get sent over WhatsApp.
  // Must be publicly reachable in production — localhost links won't open on
  // a guest's phone.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${Number(process.env.PORT) || 5000}`).replace(/\/+$/, ''),
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  chromePath: process.env.CHROME_PATH || '',
  cloudinary: {
    // Either set CLOUDINARY_URL (cloudinary://key:secret@cloud) or the trio below.
    url: process.env.CLOUDINARY_URL || '',
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
  // Gallabox WhatsApp Business API (https://server.gallabox.com/devapi).
  // All three must be set to enable in-app WhatsApp sending.
  gallabox: {
    apiKey: process.env.GALLABOX_API_KEY || '',
    apiSecret: process.env.GALLABOX_API_SECRET || '',
    channelId: process.env.GALLABOX_CHANNEL_ID || '',
  },
  whatsapp: {
    // Which transport carries WhatsApp messages: 'gallabox' (Meta's official Business API
    // through Gallabox — every template needs their approval) or 'openwa' (a self-hosted
    // gateway driving an ordinary WhatsApp account — no approval, no per-message fee, and
    // no delivery guarantee from Meta either).
    provider: process.env.WHATSAPP_PROVIDER === 'openwa' ? 'openwa' : 'gallabox',
    // Message the guest the 'enquiry_received' acknowledgement the moment a query is created.
    // OFF unless explicitly turned on: switching it on starts messaging real guests without
    // an agent reviewing anything, so that has to be a deliberate choice per deployment.
    autoEnquiry: process.env.WHATSAPP_AUTO_ENQUIRY === 'true',
  },
  // Self-hosted OpenWA gateway (https://github.com/rmyndharis/OpenWA). Used only when
  // WHATSAPP_PROVIDER=openwa. The session must already be linked to a phone and 'ready'.
  openwa: {
    baseUrl: (process.env.OPENWA_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.OPENWA_API_KEY || '',
    sessionId: process.env.OPENWA_SESSION_ID || '',
  },
  // Platform owner bootstrap (npm run bootstrap:owner / migration script).
  owner: {
    email: process.env.OWNER_EMAIL || '',
    password: process.env.OWNER_PASSWORD || '',
    name: process.env.OWNER_NAME || 'Platform Owner',
  },
  // SMTP settings — EMAIL_* preferred, SMTP_* accepted as aliases (both
  // conventions appear in deployed .env files).
  email: {
    host: process.env.EMAIL_HOST || process.env.SMTP_HOST || '',
    port: Number(process.env.EMAIL_PORT || process.env.SMTP_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    user: process.env.EMAIL_USER || process.env.SMTP_USER || '',
    pass: process.env.EMAIL_PASS || process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.EMAIL_USER || process.env.SMTP_USER || 'no-reply@irshadtravels.com',
  },
};
