// Render the cover with the real org profile (logo) from the DB.
import { quotationHtml } from 'file:///d:/Yogesh/Travel-CRM/server/src/pdf/quotationHtml.js';
import { findChrome } from 'file:///d:/Yogesh/Travel-CRM/server/src/pdf/renderPdf.js';
import { connectDB } from 'file:///d:/Yogesh/Travel-CRM/server/src/config/db.js';
import mongoose from 'mongoose';
import puppeteer from 'puppeteer-core';

const OUT = 'C:/Users/ADMIN/AppData/Local/Temp/claude/d--Yogesh-Travel-CRM/9feeba0d-9c6c-4603-83a0-b7f1c3e639e0/scratchpad';

await connectDB();
const { OrgProfile } = await import('file:///d:/Yogesh/Travel-CRM/server/src/models/OrgProfile.js');
const orgDoc = await OrgProfile.findOne();
const org = orgDoc ? orgDoc.toObject() : null;
await mongoose.disconnect();
console.log('org logo present:', !!org?.images?.logo);

const q = {
  nights: 3,
  startDate: '2026-07-31',
  selectedPackageIndex: 0,
  packages: [{
    name: 'Deluxe Package',
    hotels: [
      { hotelName: 'Blue Bird Residency', city: 'Neil Island', nights: [1, 2], rooms: 1, roomType: 'Standard', mealPlan: 'CP' },
      { hotelName: 'Lemon Tree', city: 'Port Blair', nights: [3], rooms: 1, roomType: 'Superior', mealPlan: 'CP' },
    ],
    activities: [], transports: [],
  }],
  query: { queryNumber: 26, guest: { salutation: 'Mr.', name: 'syedd', phones: [{ countryCode: '91', number: '1234567890' }] } },
  pax: { adults: 2, children: [] },
  pricing: { subtotal: 50000, markup: 5000, tax: 2750, total: 57750 },
  days: [],
};

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 794, height: 1123 });
await page.setContent(quotationHtml(q, org), { waitUntil: 'networkidle0', timeout: 60000 });
await page.evaluate(() => document.fonts.ready);
const pages = await page.$$('.page');
await pages[0].screenshot({ path: `${OUT}/page-cover.png` });
await browser.close();
console.log('done');
