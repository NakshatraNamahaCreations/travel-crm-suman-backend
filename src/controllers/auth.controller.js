import { User } from '../models/User.js';
import { Organization } from '../models/Organization.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { signToken, setAuthCookie } from '../utils/token.js';
import crypto from 'node:crypto';
import { sendMail, emailEnabled } from '../utils/mailer.js';
import { env } from '../config/env.js';
import { effectivePermissions } from '../config/permissions.js';
import { orgModules } from '../config/modules.js';
import { assertOrgAccess } from '../middleware/auth.js';

// Serialises a user doc with its resolved permission list for the client.
const withPermissions = (user) => {
  const json = user.toJSON();
  // Resolve the subscription's module list here (an empty stored list means
  // "everything") so the client never re-implements that fallback. Owners have
  // no organization and are not module-gated.
  const org = json.organization;
  if (org && typeof org === 'object') {
    org.modules = orgModules(org);
  }
  return { ...json, permissions: effectivePermissions(user) };
};

// There is no public registration. Tenant companies are created by the
// platform owner (POST /api/owner/organizations); the owner account itself is
// bootstrapped via `npm run bootstrap:owner`.

// POST /api/auth/login
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+password +isActive');
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.isActive) throw ApiError.forbidden('Account disabled');

  if (user.role !== 'owner') {
    const org = await Organization.findById(user.organization).select('isActive subscription');
    assertOrgAccess(org);
  }

  user.lastLoginAt = new Date();
  await user.save();

  const token = signToken(user);
  setAuthCookie(res, token);
  user.password = undefined;
  if (user.organization) await user.populate('organization', 'name isActive subscription');
  return ok(res, { user: withPermissions(user), token });
});

// POST /api/auth/logout
export const logout = asyncHandler(async (req, res) => {
  res.clearCookie('token');
  return ok(res, { message: 'Logged out' });
});

// GET /api/auth/me
export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
    .populate('team', 'name')
    .populate('organization', 'name isActive subscription');
  return ok(res, { user: withPermissions(user) });
});

// PATCH /api/auth/profile — update own name/phone, and optionally change password.
export const updateProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  const { name, phone, currentPassword, newPassword } = req.body;
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;

  if (newPassword) {
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      throw ApiError.badRequest('Current password is incorrect');
    }
    user.password = newPassword; // re-hashed by pre-save hook
  }

  await user.save();
  user.password = undefined;
  return ok(res, { user });
});

/* ------------------------------ password reset ------------------------------ */

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Small in-memory throttle so the endpoint can't be used to mail-bomb an
// address: max 3 requests per email per 15 minutes (per process).
const resetAttempts = new Map(); // email -> [timestamps]
function throttled(email) {
  const now = Date.now();
  const list = (resetAttempts.get(email) || []).filter((t) => now - t < 15 * 60 * 1000);
  list.push(now);
  resetAttempts.set(email, list);
  return list.length > 3;
}

// POST /api/auth/forgot-password  { email }
// Always answers with the same message whether or not the account exists —
// anything else lets an attacker enumerate registered emails.
export const forgotPassword = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) throw ApiError.badRequest('Email is required');
  if (!emailEnabled()) {
    throw ApiError.badRequest('Password reset email is not configured on this server — please contact your administrator.');
  }

  const generic = { sent: true, message: 'If an account exists for that email, a reset link has been sent.' };
  if (throttled(email)) return ok(res, generic);

  // /auth is mounted outside the tenant wall, so this lookup is global —
  // matching login, where email is globally unique.
  const user = await User.findOne({ email }).select('+isActive');
  if (!user || user.isActive === false) return ok(res, generic);

  const token = crypto.randomBytes(32).toString('hex');
  user.resetPasswordToken = hashToken(token);
  user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await user.save({ validateBeforeSave: false });

  const link = `${env.clientUrl}/reset-password?token=${token}`;
  // Console copy for the operator. The full link is a live credential, so in
  // production only the fact of the send is logged — not the token.
  if (env.isProd) {
    // eslint-disable-next-line no-console
    console.log(`[auth] password reset email sent to ${user.email}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[auth] password reset link for ${user.email}: ${link}`);
  }
  try {
    await sendMail({
      to: user.email,
      subject: 'Reset your Trip CRM password',
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
          <h2 style="color:#0a4d88">Password reset</h2>
          <p>Hi ${user.name || ''},</p>
          <p>We received a request to reset the password for this account. Click the button below to choose a new one. The link is valid for <b>1 hour</b> and can be used once.</p>
          <p style="margin:26px 0">
            <a href="${link}" style="background:#1d4ed8;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Reset Password</a>
          </p>
          <p style="font-size:13px;color:#64748b">If the button doesn't work, paste this link into your browser:<br/><a href="${link}">${link}</a></p>
          <p style="font-size:13px;color:#64748b">If you didn't request this, you can safely ignore this email — your password stays unchanged.</p>
        </div>`,
    });
  } catch (err) {
    // Don't leave a live token behind if the email never went out.
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save({ validateBeforeSave: false });
    throw ApiError.badRequest('Could not send the reset email — please try again or contact your administrator.');
  }
  return ok(res, generic);
});

// POST /api/auth/reset-password  { token, password }
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token) throw ApiError.badRequest('Reset token is missing');
  if (!password || String(password).length < 6) {
    throw ApiError.badRequest('Password must be at least 6 characters');
  }

  const user = await User.findOne({
    resetPasswordToken: hashToken(String(token)),
    resetPasswordExpires: { $gt: new Date() },
  }).select('+password');
  if (!user) throw ApiError.badRequest('This reset link is invalid or has expired — request a new one.');

  user.password = password; // re-hashed by the pre-save hook
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();

  return ok(res, { reset: true, message: 'Password updated — you can now sign in.' });
});
