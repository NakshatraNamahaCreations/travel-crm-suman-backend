import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

// Gallabox WhatsApp Business API (per their Postman docs):
//   POST https://server.gallabox.com/devapi/messages/whatsapp
//   headers: apiKey, apiSecret
//   body: { channelId, channelType: 'whatsapp', recipient: { name, phone },
//           whatsapp: { type: 'text', text: { body } } }
// Note: free-form ("session") messages deliver only inside WhatsApp's 24-hour
// customer-service window; first-contact messages need an approved template.
const GALLABOX_URL = 'https://server.gallabox.com/devapi/messages/whatsapp';

const gallaboxConfigured = () =>
  !!(env.gallabox.apiKey && env.gallabox.apiSecret && env.gallabox.channelId);

// The gateway itself, not any one session: which session carries a message is decided per
// organization at send time, so a deployment is "configured" once the gateway is reachable.
const openwaConfigured = () => !!(env.openwa.baseUrl && env.openwa.apiKey);

/** Whether the transport this deployment selected has everything it needs to send. */
export const whatsappEnabled = () =>
  env.whatsapp.provider === 'openwa' ? openwaConfigured() : gallaboxConfigured();

// "+91 98765 43210" → "919876543210"; bare 10-digit numbers get India's 91.
export const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `91${digits}` : digits;
};

// Fills {{placeholder}} tokens the way both gateways' own renderers do: a value that was not
// supplied leaves its placeholder standing, so a missing one is visible rather than blanked.
const renderBody = (body, values) =>
  String(body || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => {
    const v = values?.[k];
    return v === undefined || v === '' ? m : String(v);
  });

// OpenWA drives an ordinary WhatsApp account, so it has no approved-template requirement and
// no 24-hour session window: the rendered text is sent as a plain message. That keeps the
// tenant's own edited copy authoritative instead of mirroring every template into a second store.
async function postOpenWA(path, payload, sessionId) {
  if (!env.openwa.baseUrl || !env.openwa.apiKey) {
    throw ApiError.badRequest('OpenWA is not configured. Set OPENWA_BASE_URL / OPENWA_API_KEY in server/.env');
  }
  // The caller resolves which session carries the message — the organization's own linked number,
  // or the single environment session on a one-tenant deployment. Refused rather than guessed:
  // falling back to "some other session" would send a guest's message from another company's number.
  if (!sessionId) {
    throw ApiError.badRequest('This company has no WhatsApp number linked yet. Connect one under WhatsApp → Connection.');
  }
  const url = `${env.openwa.baseUrl}/sessions/${sessionId}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env.openwa.apiKey },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // A gateway that is not running at all: say which address was tried, since a self-hosted
    // one is usually just stopped rather than misconfigured.
    throw ApiError.badRequest(`WhatsApp send failed: could not reach OpenWA at ${env.openwa.baseUrl} (${err.message})`);
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = data?.message || data?.error || `OpenWA error (HTTP ${res.status})`;
    throw ApiError.badRequest(`WhatsApp send failed: ${Array.isArray(msg) ? msg.join('; ') : msg}`);
  }
  return { id: data?.messageId || null, status: 'sent' };
}

async function postGallabox(payload) {
  if (!gallaboxConfigured()) {
    throw ApiError.badRequest('WhatsApp API is not configured. Set GALLABOX_API_KEY / GALLABOX_API_SECRET / GALLABOX_CHANNEL_ID in server/.env');
  }
  const res = await fetch(GALLABOX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apiKey: env.gallabox.apiKey,
      apiSecret: env.gallabox.apiSecret,
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = data?.message || data?.error || `WhatsApp API error (HTTP ${res.status})`;
    throw ApiError.badRequest(`WhatsApp send failed: ${msg}`);
  }
  return { id: data?.id || data?.messageId || null, status: data?.status || 'accepted' };
}

export async function sendWhatsAppText({ phone, name, text, sessionId }) {
  const to = normalizePhone(phone);
  if (!to) throw ApiError.badRequest('A valid WhatsApp phone number is required');
  if (!String(text || '').trim()) throw ApiError.badRequest('Nothing to send');

  if (env.whatsapp.provider === 'openwa') {
    const result = await postOpenWA('/messages/send-text', { chatId: `${to}@c.us`, text }, sessionId);
    return { to, ...result };
  }

  const result = await postGallabox({
    channelId: env.gallabox.channelId,
    channelType: 'whatsapp',
    recipient: { name: name || 'Guest', phone: to },
    whatsapp: { type: 'text', text: { body: text } },
  });
  return { to, ...result };
}

// Sends a pre-approved WhatsApp template (required for first-contact / any
// message outside the 24-hour session window). `templateName` must match a
// template already created + approved in the Gallabox dashboard; bodyValues
// keys must match that template's {{VariableName}} placeholders exactly.
export async function sendWhatsAppTemplate({ phone, name, templateName, bodyValues, body, sessionId }) {
  const to = normalizePhone(phone);
  if (!to) throw ApiError.badRequest('A valid WhatsApp phone number is required');
  if (!String(templateName || '').trim()) throw ApiError.badRequest('A template name is required');

  if (env.whatsapp.provider === 'openwa') {
    // The copy comes from the caller (the stored template's own body), because OpenWA has no
    // approved template to name — it sends the finished text.
    const text = renderBody(body, bodyValues);
    if (!text.trim()) {
      throw ApiError.badRequest(`Template "${templateName}" has no message body to send through OpenWA`);
    }
    const result = await postOpenWA('/messages/send-text', { chatId: `${to}@c.us`, text }, sessionId);
    return { to, ...result };
  }

  const result = await postGallabox({
    channelId: env.gallabox.channelId,
    channelType: 'whatsapp',
    recipient: { name: name || 'Guest', phone: to },
    whatsapp: {
      type: 'template',
      template: { templateName, bodyValues: bodyValues || {} },
    },
  });
  return { to, ...result };
}
