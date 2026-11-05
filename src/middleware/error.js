import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

export function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}


// "startDate" -> "Start date", "guest.name" -> "Guest name".
function fieldLabel(path) {
  const last = String(path || '').split('.').pop();
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// Mongoose validator messages ("Path `name` is required.") are developer-facing.
// Rewrite the common kinds into something an agent can act on; anything custom
// already has a human message so it passes through unchanged.
function humanizeValidation(e) {
  const label = fieldLabel(e.path);
  switch (e.kind) {
    case 'required':
      return `${label} is required`;
    case 'minlength':
      return `${label} must be at least ${e.properties?.minlength} characters`;
    case 'maxlength':
      return `${label} must be at most ${e.properties?.maxlength} characters`;
    case 'min':
      return `${label} must be ${e.properties?.min} or more`;
    case 'max':
      return `${label} must be ${e.properties?.max} or less`;
    case 'enum':
      return `${label} must be one of: ${(e.properties?.enumValues || []).join(', ')}`;
    default:
      return e.message;
  }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  // Mongoose: bad ObjectId
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  }
  // Mongoose: validation
  if (err.name === 'ValidationError') {
    statusCode = 400;
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: humanizeValidation(e) }));
    // Clients surface `message` only, so fold the field errors into it —
    // "Validation failed" alone gives the user nothing to act on.
    message = details.map((d) => d.message).join('; ') || 'Validation failed';
  }
  // Mongoose: duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = `${fieldLabel(field)} is already in use`;
    details = err.keyValue;
  }
  // Zod
  if (err.name === 'ZodError') {
    statusCode = 400;
    details = err.issues?.map((i) => ({ field: i.path.join('.'), message: i.message }));
    message = (details || []).map((d) => `${d.field}: ${d.message}`).join('; ') || 'Validation failed';
  }

  if (statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    // err.code is also set (to a number) by Mongo driver errors — only forward
    // our own string codes (e.g. 'ORG_SUSPENDED', 'SUBSCRIPTION_EXPIRED').
    ...(typeof err.code === 'string' ? { code: err.code } : {}),
    ...(details ? { details } : {}),
    ...(env.isProd ? {} : { stack: err.stack }),
  });
}
