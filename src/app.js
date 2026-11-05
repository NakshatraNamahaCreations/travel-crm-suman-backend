import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import './models/index.js'; // register all Mongoose schemas
import apiRouter from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

const app = express();

app.use(helmet());

// Website lead ingest runs on each tenant's OWN site, whose origin this server cannot know in
// advance — it is whatever domain the client's marketing site lives on. The token in the path
// is the credential and no cookies are sent, so these paths accept any origin.
//
// Declared BEFORE the whitelist below on purpose: `cors()` answers the preflight itself and
// ends the response, so the whitelist would reject the OPTIONS request from a tenant's site
// and the browser would never send the visit at all.
const ingestCors = cors({ origin: '*', credentials: false, maxAge: 86400 });
app.use('/api/public/track', ingestCors);
app.use('/api/public/leads', ingestCors);
app.use('/api/public/form', ingestCors);

app.use(
  cors({
    // Allow whitelisted origins; permit requests with no Origin (curl, server-to-server).
    // Disallowed origins simply get no CORS headers (browser blocks) rather than a 500.
    origin(origin, cb) {
      cb(null, !origin || env.clientUrls.includes(origin));
    },
    credentials: true,
  })
);
// 8mb: org-profile brand images travel as base64 data URIs in JSON.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
if (!env.isProd) app.use(morgan('dev'));

// Basic rate limit on the API surface
app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// PDF rendering depends on a system Chrome/Chromium binary (puppeteer-core
// bundles none). This reports whether one was found and whether it actually
// launches — so a failing deploy says why instead of "Could not generate the PDF".
const pdfHealth = async (req, res) => {
  const { findChrome, htmlToPdf } = await import('./pdf/renderPdf.js');
  const executablePath = findChrome();
  if (!executablePath) {
    return res.status(503).json({ ok: false, stage: 'find', message: 'No Chrome/Chromium found on this server.' });
  }
  try {
    const pdf = await htmlToPdf('<!doctype html><html><body><h1>ok</h1></body></html>');
    return res.json({ ok: true, executablePath, bytes: pdf.length });
  } catch (err) {
    return res.status(500).json({ ok: false, stage: 'launch', executablePath, message: err.message });
  }
};
// Registered on both paths: a reverse proxy commonly forwards only /api.
app.get('/health/pdf', pdfHealth);
app.get('/api/health/pdf', pdfHealth);

app.use('/api', apiRouter);

// In production, serve the built client (client/dist) with an SPA fallback — but only when a
// build is actually there.
//
// The API is commonly deployed on its own (client on Netlify, API in a container whose build
// context is just this folder), and then ../../client/dist does not exist. Without this check
// every non-API request answers 500 from sendFile's ENOENT, so the first thing anyone sees
// when they open the API's own domain is a server error on a perfectly healthy deployment.
if (env.isProd) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(__dirname, '../../client/dist');
  const indexHtml = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(indexHtml));
  } else {
    app.use(notFoundHandler);
  }
} else {
  app.use(notFoundHandler);
}

app.use(errorHandler);

export default app;
