import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transporter = null;

export function emailEnabled() {
  return !!(env.email.host && env.email.user);
}

function getTransport() {
  if (!emailEnabled()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.email.host,
      port: env.email.port,
      secure: env.email.secure,
      auth: { user: env.email.user, pass: env.email.pass },
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, html, attachments }) {
  const t = getTransport();
  if (!t) {
    const err = new Error('Email is not configured. Set EMAIL_HOST / EMAIL_USER / EMAIL_PASS in server/.env');
    err.statusCode = 400;
    throw err;
  }
  return t.sendMail({ from: env.email.from, to, subject, html, attachments });
}
