import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function signToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      org: user.organization ? user.organization.toString() : null,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpires }
  );
}

// Sets the token as an httpOnly cookie (used alongside the Bearer response).
export function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
