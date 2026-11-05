// The organization's own WhatsApp number: link it, watch it, unlink it.
//
// A tenant scans its own QR, and from then on every template this CRM sends for that tenant
// leaves from that handset. The gateway holds the session; this controller is the tenant-scoped
// door to it, so one company can never address another's session.

import { WhatsappConnection } from '../models/WhatsappConnection.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { env } from '../config/env.js';
import {
  createSession,
  deleteSession,
  findSessionByName,
  getSession,
  getSessionQr,
  logoutSession,
  openwaConfigured,
  startSession,
  stopSession,
} from '../utils/openwaGateway.js';

// Derived from the organization id, not its display name: gateway session names are unique, and
// two tenants may well both be called "Travels". Prefixed so a gateway shared with something
// else still shows which rows are ours.
const sessionNameFor = (orgId) => `crm-${String(orgId)}`;

/**
 * The row for this organization, created empty on first use so later writes are plain updates.
 *
 * Upserted in one operation rather than read-then-create: the connection page polls, so two
 * requests can arrive together on a tenant that has no row yet and would otherwise each insert one.
 */
async function connectionRow(userId) {
  return WhatsappConnection.findOneAndUpdate(
    {},
    { $setOnInsert: { status: 'none', createdBy: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

/** What the client needs, with the gateway's credentials and internals kept on this side. */
const publicShape = (row) => ({
  connected: row.status === 'ready',
  status: row.status || 'none',
  phone: row.phone || null,
  pushName: row.pushName || null,
  connectedAt: row.connectedAt || null,
  lastError: row.lastError || null,
  hasSession: !!row.sessionId,
});

/**
 * Refresh the cached state from the gateway.
 *
 * The gateway is the authority: a handset can unlink a device without telling this server, so a
 * row saying 'ready' proves nothing on its own. A session the gateway no longer knows resets the
 * row to 'none' rather than leaving a dead id that every later send would fail against.
 */
async function refresh(row) {
  if (!row.sessionId) return row;
  const live = await getSession(row.sessionId);
  if (!live) {
    row.set({ sessionId: null, status: 'none', phone: null, pushName: null, connectedAt: null });
  } else {
    row.set({
      status: live.status || 'none',
      phone: live.phone || null,
      pushName: live.pushName || null,
      connectedAt: live.connectedAt || row.connectedAt,
      lastError: live.lastError || null,
    });
  }
  row.lastCheckedAt = new Date();
  await row.save();
  return row;
}

// ── Operations, free of req/res ──────────────────────────────────────────────
//
// Each runs inside whatever tenant context the caller established, so the tenant's own routes
// and the platform owner acting on a company's behalf share one implementation rather than two
// that could drift on something as consequential as which number sends.

/** Current link state, refreshed from the gateway. */
export async function readConnection(userId) {
  if (!openwaConfigured()) return { configured: false, connected: false, status: 'not_configured' };
  const row = await refresh(await connectionRow(userId));
  return { configured: true, ...publicShape(row) };
}

/** Create and start the session so a QR becomes available; reuses an existing one. */
export async function startConnection(orgId, userId) {
  if (!openwaConfigured()) throw ApiError.badRequest('The WhatsApp gateway is not configured on this server');

  const row = await connectionRow(userId);
  const name = sessionNameFor(orgId);

  if (!row.sessionId) {
    // A session may already exist on the gateway from an earlier attempt whose row was lost;
    // adopt it instead of failing on the gateway's unique-name conflict.
    let session = await findSessionByName(name);
    if (!session) session = await createSession(name);
    row.set({ sessionId: session.id, sessionName: name, status: session.status || 'created' });
    await row.save();
  }

  // Starting an already-started session is how the gateway re-issues a QR, so this is not gated
  // on the current status — except when it is already linked, where starting it would be a no-op
  // that misleads the caller into waiting for a QR that will never come.
  const live = await getSession(row.sessionId);
  if (live?.status === 'ready') {
    await refresh(row);
    return { configured: true, alreadyConnected: true, ...publicShape(row) };
  }

  const started = await startSession(row.sessionId);
  row.set({ status: started?.status || 'created', lastError: null });
  await row.save();
  return { configured: true, alreadyConnected: false, ...publicShape(row) };
}

/** The QR to scan, plus the state, so one poll answers both questions. */
export async function readQr(userId) {
  const row = await connectionRow(userId);
  if (!row.sessionId) throw ApiError.badRequest('Start a connection first');
  const qrCode = await getSessionQr(row.sessionId);
  await refresh(row);
  return { qrCode, ...publicShape(row) };
}

/** Unlink the handset but keep the session, so reconnecting is another scan, not a fresh setup. */
export async function endConnection(userId) {
  const row = await connectionRow(userId);
  if (!row.sessionId) return { configured: true, ...publicShape(row) };
  // logout unlinks the device; stop only halts the engine and would leave it linked.
  try {
    await logoutSession(row.sessionId);
  } catch {
    // Already logged out, or the engine never started: stopping is still worth attempting so the
    // gateway is not left holding a running browser for a session nobody is using.
    try { await stopSession(row.sessionId); } catch { /* nothing left to stop */ }
  }
  row.set({ status: 'stopped', phone: null, pushName: null, connectedAt: null });
  await row.save();
  return { configured: true, ...publicShape(row) };
}

/** Remove the session from the gateway entirely. */
export async function dropConnection(userId) {
  const row = await connectionRow(userId);
  if (row.sessionId) await deleteSession(row.sessionId);
  row.set({ sessionId: null, sessionName: null, status: 'none', phone: null, pushName: null, connectedAt: null });
  await row.save();
  return { configured: true, ...publicShape(row) };
}

// ── Tenant-facing handlers ───────────────────────────────────────────────────

// GET /api/whatsapp-connection — current link state, refreshed from the gateway.
export const getConnection = asyncHandler(async (req, res) =>
  ok(res, await readConnection(req.user?._id))
);

// POST /api/whatsapp-connection/connect — create and start this organization's session, so a QR
// becomes available. Safe to call again: an existing session is reused rather than duplicated.
export const connect = asyncHandler(async (req, res) => {
  const state = await startConnection(req.organization?._id ?? req.organization, req.user?._id);
  return state.alreadyConnected ? ok(res, state) : created(res, state);
});

// GET /api/whatsapp-connection/qr — the QR to scan, proxied so the gateway key stays server-side.
export const getQr = asyncHandler(async (req, res) => ok(res, await readQr(req.user?._id)));

// POST /api/whatsapp-connection/disconnect — unlink the handset but keep the session, so
// reconnecting is another scan rather than a fresh setup.
export const disconnect = asyncHandler(async (req, res) => ok(res, await endConnection(req.user?._id)));

// DELETE /api/whatsapp-connection — remove the session from the gateway entirely.
export const removeConnection = asyncHandler(async (req, res) => ok(res, await dropConnection(req.user?._id)));

/**
 * The gateway session that should carry this organization's messages.
 *
 * Falls back to the single session named in the environment, which is what a one-tenant
 * deployment configures and what every tenant used before per-company linking existed. Returns
 * null when neither exists, so a caller reports "not connected" rather than sending a guest's
 * message from another company's number.
 */
export async function resolveSessionId() {
  const row = await WhatsappConnection.findOne().select('sessionId status').lean();
  if (row?.sessionId && row.status === 'ready') return row.sessionId;
  return env.openwa.sessionId || null;
}
