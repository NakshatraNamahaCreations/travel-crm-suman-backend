// Imports the client's Hotel workbooks (Port Blair / Havelock / Neil) into
// Hotel + HotelPrice. Run while connected to the target DB.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { defaultOrg } from '../seed/org.js';
import { Hotel } from '../models/Hotel.js';
import { HotelPrice } from '../models/HotelPrice.js';
import { Destination } from '../models/Destination.js';
import { parseRange, parsePersons, parseStar, num, parseLoc, pickSheets } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(__dirname, '../../../doc');

function hotelFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.xlsx$/i.test(e.name) && /hotel/i.test(p)) out.push(p);
    }
  };
  walk(DOC);
  return out;
}

function parseHotelSheet(rows, sheetName) {
  let H = -1;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    if (String(rows[i][4]).trim().toLowerCase() === 'room') { H = i; break; }
  }
  if (H < 0) return null;
  const header = rows[H];

  // Season groups: header cells from col 5 onward
  const groups = [];
  for (let c = 5; c < header.length; c++) if (String(header[c]).trim()) groups.push({ label: String(header[c]).trim(), start: c });
  if (!groups.length) return null;
  groups.forEach((g, i) => (g.end = groups[i + 1] ? groups[i + 1].start : header.length));

  // Meal-plan row
  let M = -1;
  for (let i = H + 1; i < Math.min(rows.length, H + 7); i++) {
    if (groups.some((g) => /^(CP|MAP|AP|EP|Room only)$/i.test(String(rows[i][g.start]).trim()))) { M = i; break; }
  }
  if (M < 0) return null;
  for (const g of groups) {
    g.meals = [];
    for (let c = g.start; c < g.end; c++) { const mp = String(rows[M][c]).trim(); if (mp) g.meals.push({ col: c, mealPlan: mp }); }
    g.ranges = [];
    for (let i = H + 1; i < M; i++) for (let c = g.start; c < g.end; c++) { const r = parseRange(rows[i][c]); if (r) g.ranges.push(r); }
  }

  let name = '', loc = '', star = 0;
  const rooms = new Set(), mealsSet = new Set(), prices = [], extra = {};
  for (let i = M + 1; i < rows.length; i++) {
    const r = rows[i];
    const room = String(r[4]).trim();
    if (!room) continue;
    if (String(r[2]).trim() && String(r[2]).trim().toLowerCase() !== 'extras' && !name) name = String(r[2]).trim();
    if (String(r[1]).trim() && !loc) loc = String(r[1]).trim();
    if (String(r[3]).trim()) star = parseStar(r[3]) || star;
    const isExtra = String(r[2]).trim().toLowerCase() === 'extras' || /extra\s*bed|extra\s*mattress|\bcnb\b|\bcwb\b/i.test(room);
    const persons = parsePersons(room);

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      for (const m of g.meals) {
        const val = num(r[m.col]);
        if (!val) continue;
        if (isExtra) {
          const key = gi + '|' + m.mealPlan;
          extra[key] = extra[key] || {};
          if (/adult/i.test(room)) extra[key].aweb = val;
          else if (/no\s*bed|cnb|without/i.test(room)) extra[key].cwoeb = val;
          else extra[key].cweb = val;
        } else {
          rooms.add(room); mealsSet.add(m.mealPlan);
          for (const range of g.ranges) prices.push({ roomType: room, mealPlan: m.mealPlan, basePrice: val, persons, _gi: gi, ...range });
        }
      }
    }
  }
  for (const p of prices) { const e = extra[p._gi + '|' + p.mealPlan] || {}; p.aweb = e.aweb || 0; p.cweb = e.cweb || 0; p.cwoeb = e.cwoeb || 0; delete p._gi; }

  const valid = prices.filter((p) => p.start && p.end);
  const { city, state, country } = parseLoc(loc);
  return {
    // Sheet name is the reliable hotel name; parsed col2 only as fallback.
    name: sheetName.replace(/^copy of\s*/i, '').trim() || name,
    location: { city, state, country },
    stars: star || 3,
    mealPlans: [...mealsSet],
    roomTypes: [...rooms].map((n) => ({ name: n, eb: 1, aweb: 1, cweb: 1 })),
    prices: valid,
  };
}

async function run() {
  await connectDB();
  enterTenant((await defaultOrg())._id); // scope the import to the default org
  const dryRun = process.argv.includes('--dry');
  const files = hotelFiles();
  let hotelCount = 0, priceCount = 0, skipped = 0;
  const cityCache = new Map();

  for (const f of files) {
    const wb = XLSX.readFile(f);
    const sheets = pickSheets(wb.SheetNames);
    console.log(`\n[${path.basename(f)}] ${sheets.length} hotels`);
    for (const { sheet, name: displayName } of sheets) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
      const parsed = parseHotelSheet(rows, displayName);
      if (!parsed || !parsed.name || !parsed.prices.length) { skipped++; continue; }
      parsed.name = displayName; // fuller original name wins

      if (dryRun) {
        console.log(`   • ${parsed.name} (${parsed.stars}★, ${parsed.location.city}) — ${parsed.roomTypes.length} rooms, ${parsed.prices.length} price rows`);
        hotelCount++; priceCount += parsed.prices.length; continue;
      }

      // Ensure destination for the city
      let destId = cityCache.get(parsed.location.city);
      if (parsed.location.city && !destId) {
        const d = await Destination.findOneAndUpdate(
          { name: parsed.location.city },
          { name: parsed.location.city, region: 'Andaman' },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        destId = d._id; cityCache.set(parsed.location.city, destId);
      }

      const hotel = await Hotel.findOneAndUpdate(
        { name: parsed.name },
        {
          name: parsed.name, location: parsed.location, stars: parsed.stars,
          mealPlans: parsed.mealPlans, roomTypes: parsed.roomTypes,
          destinations: destId ? [destId] : [],
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await HotelPrice.deleteMany({ hotel: hotel._id });
      const rows2 = parsed.prices.map((p) => ({
        hotel: hotel._id, startDate: p.start, endDate: p.end, mealPlan: p.mealPlan,
        roomType: p.roomType, basePrice: p.basePrice, persons: p.persons,
        aweb: p.aweb, cweb: p.cweb, cwoeb: p.cwoeb,
      }));
      if (rows2.length) await HotelPrice.insertMany(rows2);
      hotelCount++; priceCount += rows2.length;
    }
  }

  console.log(`\n==== HOTELS ${dryRun ? '(DRY RUN)' : 'IMPORTED'} ====`);
  console.log(`Hotels: ${hotelCount} | Price rows: ${priceCount} | Skipped sheets: ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => { console.error('Import failed:', e); process.exit(1); });
