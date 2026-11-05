// Thin client for the OpenWA gateway's session endpoints.
//
// Every call goes out from the server: the gateway's API key is an admin credential for the
// whole gateway (it can read any session's chats), so it must never reach a browser. The
// connection page therefore asks this server for a QR and this server asks the gateway.

import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

/** Whether this server can talk to a gateway at all. A per-tenant session is a separate matter. */
export const openwaConfigured = () => !!(env.openwa.baseUrl && env.openwa.apiKey);

/** Raw call. `expect404` lets a caller treat a missing session as a value rather than an error. */
async function call(path, { method = 'GET', body, expect404 = false } = {}) {
  if (!env.openwa.baseUrl || !env.openwa.apiKey) {
    throw ApiError.badRequest('OpenWA is not configured. Set OPENWA_BASE_URL / OPENWA_API_KEY in server/.env');
  }
  let res;
  try {
    res = await fetch(`${env.openwa.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env.openwa.apiKey },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw ApiError.badRequest(`Could not reach the WhatsApp gateway at ${env.openwa.baseUrl} (${err.message})`);
  }

  if (res.status === 404 && expect404) return null;
  if (res.status === 204) return {};

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = data?.message || data?.error || `WhatsApp gateway error (HTTP ${res.status})`;
    throw new ApiError(res.status === 409 ? 409 : 400, Array.isArray(msg) ? msg.join('; ') : msg);
  }
  return data;
}

export const createSession = (name) => call('/sessions', { method: 'POST', body: { name } });
export const getSession = (id) => call(`/sessions/${id}`, { expect404: true });
export const startSession = (id) => call(`/sessions/${id}/start`, { method: 'POST' });
export const stopSession = (id) => call(`/sessions/${id}/stop`, { method: 'POST' });
export const logoutSession = (id) => call(`/sessions/${id}/logout`, { method: 'POST' });
export const deleteSession = (id) => call(`/sessions/${id}`, { method: 'DELETE', expect404: true });
/** The QR as a data URL, or null while the gateway has none ready (400 until it does). */
export const getSessionQr = async (id) => {
  try {
    const data = await call(`/sessions/${id}/qr`);
    return data?.qrCode || null;
  } catch (err) {
    // "QR not ready, or the session is already authenticated" is a state, not a fault.
    if (err.statusCode === 400) return null;
    throw err;
  }
};

/** Finds a gateway session by the name we derive for an organization, if one already exists. */
export async function findSessionByName(name) {
  const list = await call('/sessions');
  const rows = Array.isArray(list) ? list : list?.data || [];
  return rows.find((s) => s.name === name) || null;
}
