// Imports Transport_.xlsx into TransportService + TransportPrice.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { defaultOrg } from '../seed/org.js';
import { TransportService } from '../models/TransportService.js';
import { TransportPrice } from '../models/TransportPrice.js';
import { Destination } from '../models/Destination.js';
import { parseRange, num, pickSheets } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(__dirname, '../../../doc');

function findFile() {
  let found = null;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/transport/i.test(p) && /\.xlsx$/i.test(e.name)) found = p; } };
  walk(DOC);
  return found;
}

// Safe cell read — out-of-range cells are undefined; never treat as text.
const cell = (r, c) => { const v = r && r[c]; return v == null ? '' : String(v).trim(); };

function parseSheet(rows) {
  // Header row: col3 == 'Service'
  let H = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) if (cell(rows[i], 3).toLowerCase() === 'service') { H = i; break; }
  if (H < 0) return [];

  const maxCol = Math.max(...rows.slice(0, 8).map((r) => r.length), 8);
  const groups = [];
  for (let c = 8; c < rows[H].length; c++) if (cell(rows[H], c)) groups.push({ start: c });
  if (!groups.length) groups.push({ start: 8 });
  groups.forEach((g, i) => (g.end = groups[i + 1] ? groups[i + 1].start : maxCol));

  // date ranges + vehicle (config) row
  const ranges = [];
  let V = -1;
  for (let i = H + 1; i < Math.min(rows.length, H + 6); i++) {
    let hasDate = false, hasText = false;
    for (const g of groups) for (let c = g.start; c < g.end; c++) {
      const v = cell(rows[i], c);
      if (!v) continue;
      if (parseRange(v)) { ranges.push(parseRange(v)); hasDate = true; } else hasText = true;
    }
    if (hasText && !hasDate && V < 0) V = i;
  }
  if (V < 0) V = H + 1;
  const vehicles = [];
  for (const g of groups) for (let c = g.start; c < g.end; c++) { const v = cell(rows[V], c); if (v) vehicles.push({ col: c, name: v }); }
  const dateRanges = ranges.length ? ranges : [null];

  // Data rows
  const routes = new Map();
  let curRoute = '';
  for (let i = V + 1; i < rows.length; i++) {
    const r = rows[i];
    if (cell(r, 1)) curRoute = cell(r, 1);
    const service = cell(r, 3);
    if (!service || !curRoute) continue;
    if (!routes.has(curRoute)) routes.set(curRoute, { items: [], prices: [] });
    const route = routes.get(curRoute);
    route.items.push({ name: service, description: cell(r, 7) });
    for (const v of vehicles) {
      const price = num(r[v.col]);
      if (!price) continue;
      for (const range of dateRanges) if (range) route.prices.push({ itemName: service, config: v.name, price, ...range });
    }
  }
  return [...routes.entries()].map(([name, v]) => ({ name, ...v }));
}

async function run() {
  await connectDB();
  enterTenant((await defaultOrg())._id); // scope the import to the default org
  const dry = process.argv.includes('--dry');
  const wb = XLSX.readFile(findFile());
  const andaman = await Destination.findOne({ name: 'Andaman' });
  const sheets = pickSheets(wb.SheetNames);

  let sCount = 0, pCount = 0;
  for (const { sheet } of sheets) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
    const routes = parseSheet(rows);
    console.log(`[${sheet}] ${routes.length} routes`);
    for (const route of routes) {
      if (dry) { sCount++; pCount += route.prices.length; continue; }
      const doc = await TransportService.findOneAndUpdate(
        { name: route.name },
        { name: route.name, from: route.name, destinations: andaman ? [andaman._id] : [], items: route.items.slice(0, 50) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await TransportPrice.deleteMany({ service: doc._id });
      const rows2 = route.prices.map((p) => ({ service: doc._id, itemName: p.itemName, config: p.config, startDate: p.start, endDate: p.end, price: p.price }));
      if (rows2.length) await TransportPrice.insertMany(rows2);
      sCount++; pCount += rows2.length;
    }
  }
  console.log(`\n==== TRANSPORT ${dry ? '(DRY)' : 'IMPORTED'} ====\nServices: ${sCount} | Price rows: ${pCount}`);
  await mongoose.disconnect();
  process.exit(0);
}
run().catch((e) => { console.error('Failed:', e); process.exit(1); });
