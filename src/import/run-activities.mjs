// Imports Activities Master.xlsx (Ferry + Activities sheets) into
// TravelActivity + TravelActivityPrice.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { defaultOrg } from '../seed/org.js';
import { TravelActivity } from '../models/TravelActivity.js';
import { TravelActivityPrice } from '../models/TravelActivityPrice.js';
import { Destination } from '../models/Destination.js';
import { parseRange, num } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(__dirname, '../../../doc');

function findFile() {
  let found = null;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/activit/i.test(p) && /\.xlsx$/i.test(e.name)) found = p; } };
  walk(DOC);
  return found;
}

// Parse a sheet → { activities: Map<name,{ticketTypes:Set, ageConfig}>, prices: [...] }
function parseSheet(rows) {
  let H = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    if (String(rows[i][0]).trim().toLowerCase() === 'name' && String(rows[i][1]).trim().toLowerCase() === 'service') { H = i; break; }
  }
  if (H < 0) return { activities: new Map(), prices: [] };

  // Season groups: row H cells from col 7 onward
  const groups = [];
  for (let c = 7; c < rows[H].length; c++) if (String(rows[H][c]).trim()) groups.push({ start: c });
  groups.forEach((g, i) => (g.end = groups[i + 1] ? groups[i + 1].start : rows[H].length + 6));

  // Config row: first row after H where a group col has Adult/Child
  let C = -1;
  for (let i = H + 1; i < Math.min(rows.length, H + 6); i++) {
    if (groups.some((g) => /adult|child/i.test(String(rows[i][g.start]).trim()))) { C = i; break; }
  }
  if (C < 0) return { activities: new Map(), prices: [] };

  for (const g of groups) {
    g.configs = [];
    for (let c = g.start; c < g.end; c++) { const cfg = String(rows[C][c]).trim(); if (cfg) g.configs.push({ col: c, config: cfg }); }
    g.ranges = [];
    for (let i = H + 1; i < C; i++) for (let c = g.start; c < g.end; c++) { const r = parseRange(rows[i][c]); if (r) g.ranges.push(r); }
  }

  const activities = new Map();
  const prices = [];
  let curName = '';
  for (let i = C + 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]).trim()) curName = String(r[0]).trim();
    const service = String(r[1]).trim();
    if (!service || !curName) continue;

    if (!activities.has(curName)) activities.set(curName, { ticketTypes: new Set(), ageConfig: '' });
    activities.get(curName).ticketTypes.add(service);

    for (const g of groups) {
      for (const cfg of g.configs) {
        const price = num(r[cfg.col]);
        if (!price) continue;
        if (!activities.get(curName).ageConfig) activities.get(curName).ageConfig = g.configs.map((x) => x.config).join(', ');
        for (const range of g.ranges) prices.push({ activity: curName, service, config: cfg.config, price, ...range });
      }
    }
  }
  return { activities, prices };
}

async function run() {
  await connectDB();
  enterTenant((await defaultOrg())._id); // scope the import to the default org
  const dry = process.argv.includes('--dry');
  const wb = XLSX.readFile(findFile());
  const andaman = await Destination.findOne({ name: 'Andaman' });

  let aCount = 0, pCount = 0;
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    const { activities, prices } = parseSheet(rows);
    console.log(`[${sheetName}] ${activities.size} activities, ${prices.filter((p) => p.start).length} prices`);

    for (const [name, info] of activities) {
      if (dry) { aCount++; continue; }
      const doc = await TravelActivity.findOneAndUpdate(
        { name },
        { name, ageConfig: info.ageConfig || 'Adult, Child', destinations: andaman ? [andaman._id] : [], ticketTypes: [...info.ticketTypes].map((t) => ({ name: t })) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await TravelActivityPrice.deleteMany({ activity: doc._id });
      const rows2 = prices.filter((p) => p.activity === name && p.start && p.end).map((p) => ({ activity: doc._id, service: p.service, config: p.config, startDate: p.start, endDate: p.end, price: p.price }));
      if (rows2.length) await TravelActivityPrice.insertMany(rows2);
      aCount++; pCount += rows2.length;
    }
    if (dry) pCount += prices.filter((p) => p.start).length;
  }
  console.log(`\n==== ACTIVITIES ${dry ? '(DRY)' : 'IMPORTED'} ====\nActivities: ${aCount} | Price rows: ${pCount}`);
  await mongoose.disconnect();
  process.exit(0);
}
run().catch((e) => { console.error('Failed:', e); process.exit(1); });
