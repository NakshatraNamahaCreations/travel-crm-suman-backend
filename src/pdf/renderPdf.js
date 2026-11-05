import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { env } from '../config/env.js';

const CANDIDATES = [
  env.chromePath,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : '',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
].filter(Boolean);

export function findChrome() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/* ---------- image inlining with memory + disk cache ----------
   External images (Unsplash, hotel photos) dominated render time because a
   throwaway browser re-downloaded them on every request. We fetch them once
   in Node, cache to disk, and inline as data: URIs so Chrome hits no network. */

// /tmp is wiped on many hosts (and on every container restart), which makes
// the first PDF after each deploy re-download every image. PDF_CACHE_DIR lets
// a deployment point this at persistent storage.
const IMG_CACHE_DIR = process.env.PDF_CACHE_DIR || path.join(os.tmpdir(), 'tcrm-img-cache');
const memCache = new Map(); // url -> data URI

function cacheFile(url) {
  return path.join(IMG_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex'));
}

/* Ask image CDNs for a print-sized rendition instead of the original. An A4
   page at 12mm margins is ~186mm wide, so ~1000px covers full-bleed art and
   ~600px covers inline thumbnails — originals are far larger and inflate the
   PDF (and the fetch time) for no visible gain. */
function shrinkUrl(url, maxW = 1000) {
  try {
    const u = new URL(url);
    if (/(^|\.)unsplash\.com$/i.test(u.hostname)) {
      const w = Number(u.searchParams.get('w')) || maxW;
      u.searchParams.set('w', String(Math.min(w, maxW)));
      u.searchParams.set('q', '70');
      u.searchParams.set('auto', 'format');
      return u.toString();
    }
    if (/(^|\.)res\.cloudinary\.com$/i.test(u.hostname) && u.pathname.includes('/upload/')) {
      // Skip if a transformation is already present.
      if (/\/upload\/[^/]*[wqf]_/.test(u.pathname)) return url;
      u.pathname = u.pathname.replace('/upload/', `/upload/w_${maxW},q_auto,f_auto/`);
      return u.toString();
    }
  } catch { /* not a URL we can rewrite */ }
  return url;
}

// Print sizing. A4 at 12mm margins is ~186mm of content, so 760px is already
// past what 150dpi needs; images are the dominant cost in the PDF.
const PRINT_WIDTH = Number(process.env.PDF_IMAGE_WIDTH) || 760;
const PRINT_QUALITY = Number(process.env.PDF_IMAGE_QUALITY) || 64;
const MAX_EMBED_BYTES = 200 * 1024; // any single image above this gets a harder pass

// Resize + recompress an image for print. Falls back to the original bytes if
// the format is one sharp can't read (e.g. SVG served as image/svg+xml).
async function downscale(raw, type) {
  if (/svg/i.test(type)) return { buf: raw, mime: type };
  try {
    const img = sharp(raw, { failOn: 'none' }).rotate();
    const meta = await img.metadata();
    // Only small transparent assets (logos, badges) stay PNG — a photo kept as
    // PNG can be many times its JPEG size, so anything sizeable is flattened
    // onto white and encoded as JPEG.
    const keepPng = !!meta.hasAlpha && raw.length < 60 * 1024;
    const sized = () => sharp(raw, { failOn: 'none' }).rotate()
      .resize({ width: PRINT_WIDTH, withoutEnlargement: true });

    if (keepPng) {
      const buf = await sized().png({ compressionLevel: 9, palette: true }).toBuffer();
      return buf.length < raw.length ? { buf, mime: 'image/png' } : { buf: raw, mime: type };
    }

    let buf = await sized().flatten({ background: '#ffffff' })
      .jpeg({ quality: PRINT_QUALITY, mozjpeg: true }).toBuffer();
    // One stubbornly large image can dominate the file; squeeze those harder.
    if (buf.length > MAX_EMBED_BYTES) {
      buf = await sized().flatten({ background: '#ffffff' })
        .jpeg({ quality: 52, mozjpeg: true }).toBuffer();
    }
    if (buf.length >= raw.length) return { buf: raw, mime: type }; // already optimal
    return { buf, mime: 'image/jpeg' };
  } catch {
    return { buf: raw, mime: type };
  }
}

async function fetchAsDataUri(url) {
  if (memCache.has(url)) return memCache.get(url);
  const file = cacheFile(url);
  try {
    if (fs.existsSync(file)) {
      const cached = fs.readFileSync(file, 'utf8');
      memCache.set(url, cached);
      return cached;
    }
  } catch { /* fall through to network */ }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(shrinkUrl(url), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) { memCache.set(url, null); return null; }
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) { memCache.set(url, null); return null; }
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length > 12 * 1024 * 1024) return null; // pathological original
    // Re-encode to print size. Most source images are screen/full-res and are
    // the single biggest contributor to PDF size — an A4 page at 12mm margins
    // is ~186mm wide, so 900px is already beyond what 150dpi print needs.
    // Typically ~75% smaller with no visible difference.
    const { buf, mime } = await downscale(raw, type);
    const uri = `data:${mime};base64,${buf.toString('base64')}`;
    memCache.set(url, uri);
    try {
      fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, uri, 'utf8');
    } catch { /* disk cache is best-effort */ }
    return uri;
  } catch {
    memCache.set(url, null); // don't retry a dead URL on every later render
    return null;
  }
}

async function inlineImages(html) {
  const urls = [...new Set([...html.matchAll(/src="(https?:\/\/[^"]+)"/g)].map((m) => m[1]))];
  const started = Date.now();
  const pairs = await Promise.all(urls.map(async (u) => [u, await fetchAsDataUri(u)]));
  let out = html;
  let bytes = 0;
  // The same photo often appears under several URLs (different width params);
  // after downscaling they produce identical bytes, so share one data URI.
  const byContent = new Map();
  for (const [u, uri] of pairs) {
    if (!uri) continue;
    const key = crypto.createHash('sha1').update(uri).digest('hex');
    if (byContent.has(key)) {
      out = out.split(`src="${u}"`).join(`src="${byContent.get(key)}"`);
      continue;
    }
    byContent.set(key, uri);
    out = out.split(`src="${u}"`).join(`src="${uri}"`);
    bytes += uri.length;
  }
  // eslint-disable-next-line no-console
  console.log(`[pdf] inlined ${pairs.filter((x) => x[1]).length}/${urls.length} images, ${(bytes / 1048576).toFixed(1)}MB, ${Date.now() - started}ms`);
  return out;
}

/* Inline the Google Fonts stylesheet + woff2 files so the page needs no
   network at all — lets us skip the networkidle wait entirely. */
async function fetchCachedText(url, headers = {}) {
  if (memCache.has(url)) return memCache.get(url);
  const file = cacheFile(url);
  try {
    if (fs.existsSync(file)) {
      const cached = fs.readFileSync(file, 'utf8');
      memCache.set(url, cached);
      return cached;
    }
  } catch { /* fall through */ }
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    let out;
    if (/text\/css/i.test(res.headers.get('content-type') || '')) {
      out = await res.text();
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      out = `data:${res.headers.get('content-type') || 'font/woff2'};base64,${buf.toString('base64')}`;
    }
    memCache.set(url, out);
    try {
      fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, out, 'utf8');
    } catch { /* best-effort */ }
    return out;
  } catch {
    return null;
  }
}

async function inlineFonts(html) {
  const m = html.match(/<link href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)" rel="stylesheet"\/?>/);
  if (!m) return html;
  // Chrome UA so Google serves woff2 @font-face rules.
  const css = await fetchCachedText(m[1], { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' });
  if (!css) return html;
  const fontUrls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((x) => x[1]))];
  const pairs = await Promise.all(fontUrls.map(async (u) => [u, await fetchCachedText(u)]));
  let inlinedCss = css;
  for (const [u, uri] of pairs) {
    if (uri) inlinedCss = inlinedCss.split(u).join(uri);
  }
  return html.replace(m[0], `<style>${inlinedCss}</style>`);
}

/* ---------- shared browser instance ----------
   Launching Chrome per request cost seconds; keep one alive and reuse it.
   A persistent profile dir lets fonts/stylesheets cache across renders. */

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.connected) return b;
    } catch { /* relaunch below */ }
    browserPromise = null;
  }
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Chromium found for PDF rendering. Install it on the server '
      + '(e.g. `apt-get install -y chromium` or `chromium-browser`) and set '
      + 'CHROME_PATH in server/.env to its full path. Looked in: '
      + CANDIDATES.join(', ')
    );
  }
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // /dev/shm is commonly 64MB on a VPS/container — Chrome crashes without this.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
    userDataDir: path.join(os.tmpdir(), 'tcrm-pdf-profile'),
  });
  // Surface launch failures (missing shared libs, permissions) instead of
  // leaving a rejected promise cached for every later request.
  browserPromise.catch(() => { browserPromise = null; });
  return browserPromise;
}

// Render an HTML string to an A4 PDF buffer using the system Chrome/Edge.
export async function htmlToPdf(html) {
  const t0 = Date.now();
  const inlined = await inlineFonts(await inlineImages(html));
  const tAssets = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Everything the document needs is already inlined as data: URIs. Anything
    // still pointing at the network failed to fetch, and letting Chrome retry
    // it stalls `load` until the timeout — which is what makes a render take a
    // minute on a server with slower egress. Abort those instead of waiting.
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (/^https?:/i.test(r.url())) r.abort().catch(() => {});
      else r.continue().catch(() => {});
    });
    await page.setContent(inlined, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
    });
    // eslint-disable-next-line no-console
    console.log(`[pdf] assets ${tAssets - t0}ms, render ${Date.now() - tAssets}ms, out ${(pdf.length / 1048576).toFixed(1)}MB`);
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}
