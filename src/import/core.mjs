// Shared Excel→DB import logic, used by both the CLI scripts and the in-app
// upload endpoint. Each importer takes a parsed XLSX workbook + returns a summary.
import XLSX from 'xlsx';
import { Hotel } from '../models/Hotel.js';
import { HotelPrice } from '../models/HotelPrice.js';
import { TransportService } from '../models/TransportService.js';
import { TransportPrice } from '../models/TransportPrice.js';
import { TravelActivity } from '../models/TravelActivity.js';
import { TravelActivityPrice } from '../models/TravelActivityPrice.js';
import { Destination } from '../models/Destination.js';
import { Option } from '../models/Option.js';
import { parseRange, parsePersons, parseStar, num, parseLoc, pickSheets } from './lib.mjs';

// Also repairs common UTF-8-as-cp1252 mojibake from client CSVs ("Corbynâ€™s").
const MOJIBAKE = [['â€™', '’'], ['â€˜', '‘'], ['â€œ', '“'], ['â€', '”'], ['â€"', '–'], ['â€“', '–'], ['â€”', '—'], ['Â', '']];
const demojibake = (s) => MOJIBAKE.reduce((out, [bad, good]) => out.split(bad).join(good), s);
const cell = (r, c) => { const v = r && r[c]; return v == null ? '' : demojibake(String(v).trim()); };
const sheetRows = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// Case-insensitive, whitespace-tolerant exact-name filter, so CSV spelling
// variations ("silver sand  resort") upsert onto the existing record instead
// of creating a duplicate (prices link to hotels by _id after import).
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameEq = (s) => ({ $regex: `^\\s*${escRx(String(s).trim()).replace(/\s+/g, '\\s+')}\\s*$`, $options: 'i' });

// Re-uploading a sheet must refresh prices without erasing hand-authored
// content on the existing record (photos, descriptions). Merge the freshly
// parsed sub-items with the current ones by name: sheet fields win where the
// sheet provides them, everything else carries over.
const itemKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function mergeSubItems(fresh, existing) {
  const prevByName = new Map((existing || []).map((it) => {
    const o = typeof it.toObject === 'function' ? it.toObject() : it;
    return [itemKey(o.name), o];
  }));
  return (fresh || []).map((it) => {
    const prev = prevByName.get(itemKey(it.name));
    if (!prev) return it;
    const merged = { ...prev, ...it };
    for (const [k, v] of Object.entries(it)) {
      if ((v === undefined || v === null || v === '') && prev[k] !== undefined) merged[k] = prev[k];
    }
    delete merged._id;
    return merged;
  });
}

/* ===================== HOTELS ===================== */
export function parseHotelSheet(rows, displayName) {
  let H = -1;
  for (let i = 0; i < Math.min(rows.length, 8); i++) if (cell(rows[i], 4).toLowerCase() === 'room') { H = i; break; }
  if (H < 0) return null;
  const header = rows[H];
  const groups = [];
  for (let c = 5; c < header.length; c++) if (cell(header, c)) groups.push({ label: cell(header, c), start: c });
  if (!groups.length) return null;
  groups.forEach((g, i) => (g.end = groups[i + 1] ? groups[i + 1].start : header.length));

  let M = -1;
  for (let i = H + 1; i < Math.min(rows.length, H + 7); i++) if (groups.some((g) => /^(CP|MAP|AP|EP|Room only)$/i.test(cell(rows[i], g.start)))) { M = i; break; }
  if (M < 0) return null;
  for (const g of groups) {
    g.meals = [];
    for (let c = g.start; c < g.end; c++) { const mp = cell(rows[M], c); if (mp) g.meals.push({ col: c, mealPlan: mp }); }
    g.ranges = [];
    for (let i = H + 1; i < M; i++) for (let c = g.start; c < g.end; c++) { const r = parseRange(cell(rows[i], c)); if (r) g.ranges.push(r); }
    // CSV template keeps the dates inside the season label itself, e.g. "Season 1: 1 Jul 2026 - 30 Sep 2026".
    if (!g.ranges.length) { const r = parseRange(g.label); if (r) g.ranges.push(r); }
  }

  let name = '', loc = '', star = 0;
  const rooms = new Set(), mealsSet = new Set(), prices = [], extra = {};
  for (let i = M + 1; i < rows.length; i++) {
    const r = rows[i];
    const room = cell(r, 4);
    if (!room) continue;
    if (cell(r, 2) && cell(r, 2).toLowerCase() !== 'extras' && !name) name = cell(r, 2);
    if (cell(r, 1) && !loc) loc = cell(r, 1);
    if (cell(r, 3)) star = parseStar(cell(r, 3)) || star;
    const isExtra = cell(r, 2).toLowerCase() === 'extras' || /extra\s*bed|extra\s*mattress|\bcnb\b|\bcwb\b/i.test(room);
    const persons = parsePersons(room);
    for (let gi = 0; gi < groups.length; gi++) {
      for (const m of groups[gi].meals) {
        const val = num(cell(r, m.col));
        if (!val) continue;
        if (isExtra) {
          const key = gi + '|' + m.mealPlan;
          extra[key] = extra[key] || {};
          if (/adult/i.test(room)) extra[key].aweb = val;
          else if (/no\s*bed|cnb|without/i.test(room)) extra[key].cwoeb = val;
          else extra[key].cweb = val;
        } else {
          rooms.add(room); mealsSet.add(m.mealPlan);
          for (const range of groups[gi].ranges) prices.push({ roomType: room, mealPlan: m.mealPlan, basePrice: val, persons, _gi: gi, ...range });
        }
      }
    }
  }
  for (const p of prices) { const e = extra[p._gi + '|' + p.mealPlan] || {}; p.aweb = e.aweb || 0; p.cweb = e.cweb || 0; p.cwoeb = e.cwoeb || 0; delete p._gi; }
  const valid = prices.filter((p) => p.start && p.end);
  const { city, state, country } = parseLoc(loc);
  return { name: displayName || name, location: { city, state, country }, stars: star || 3, mealPlans: [...mealsSet], roomTypes: [...rooms].map((n) => ({ name: n, eb: 1, aweb: 1, cweb: 1 })), prices: valid };
}

export async function importHotels(wb, opts = {}) {
  const sheets = pickSheets(wb.SheetNames);
  let hotels = 0, priceRows = 0, skipped = 0;
  // Tag imported hotels with the destinations picked in the upload form,
  // falling back to Andaman. Cities are NOT turned into Destination records —
  // Destinations stay trip-level (states/regions); city filtering uses the
  // hotel's location.city instead.
  let extraDest = (opts.destinations || []).filter(Boolean).map(String);
  if (!extraDest.length) {
    const andaman = await Destination.findOne({ name: /andaman/i });
    if (andaman) extraDest = [String(andaman._id)];
  }
  for (const { sheet, name } of sheets) {
    const parsed = parseHotelSheet(sheetRows(wb.Sheets[sheet]), name);
    if (!parsed || !parsed.name || !parsed.prices.length) { skipped++; continue; }
    const dests = [...new Set(extraDest)];
    const hotel = await Hotel.findOneAndUpdate({ name: nameEq(parsed.name) }, { $set: { location: parsed.location, stars: parsed.stars, mealPlans: parsed.mealPlans, roomTypes: parsed.roomTypes, destinations: dests }, $setOnInsert: { name: parsed.name } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await HotelPrice.deleteMany({ hotel: hotel._id });
    const rows = parsed.prices.map((p) => ({ hotel: hotel._id, startDate: p.start, endDate: p.end, mealPlan: p.mealPlan, roomType: p.roomType, basePrice: p.basePrice, persons: p.persons, aweb: p.aweb, cweb: p.cweb, cwoeb: p.cwoeb }));
    if (rows.length) await HotelPrice.insertMany(rows);
    hotels++; priceRows += rows.length;
  }
  return { hotels, priceRows, skipped };
}

/* ===================== ACTIVITIES ===================== */
// Columns: Name, Service, Description, Open Time, Close Time, Duration (Mins),
// Slots, then Season groups. Description/Duration/Slots feed the ticket type's
// own fields so the quote builder can auto-fill them (and the PDF can show a
// description) instead of falling back to defaults.
export function parseActivitiesSheet(rows) {
  let H = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) if (cell(rows[i], 0).toLowerCase() === 'name' && cell(rows[i], 1).toLowerCase() === 'service') { H = i; break; }
  if (H < 0) return { activities: new Map(), prices: [] };
  const groups = [];
  for (let c = 7; c < rows[H].length; c++) if (cell(rows[H], c)) groups.push({ start: c });
  groups.forEach((g, i) => (g.end = groups[i + 1] ? groups[i + 1].start : rows[H].length + 6));
  let C = -1;
  for (let i = H + 1; i < Math.min(rows.length, H + 6); i++) if (groups.some((g) => /adult|child/i.test(cell(rows[i], g.start)))) { C = i; break; }
  if (C < 0) return { activities: new Map(), prices: [] };
  for (const g of groups) {
    g.configs = [];
    for (let c = g.start; c < g.end; c++) { const cfg = cell(rows[C], c); if (cfg) g.configs.push({ col: c, config: cfg }); }
    g.ranges = [];
    for (let i = H + 1; i < C; i++) for (let c = g.start; c < g.end; c++) { const r = parseRange(cell(rows[i], c)); if (r) g.ranges.push(r); }
    // CSV template keeps the dates inside the season label itself.
    if (!g.ranges.length) { const r = parseRange(cell(rows[H], g.start)); if (r) g.ranges.push(r); }
  }
  const activities = new Map(); const prices = []; let curName = '';
  for (let i = C + 1; i < rows.length; i++) {
    const r = rows[i];
    if (cell(r, 0)) curName = cell(r, 0);
    const service = cell(r, 1);
    if (!service || !curName) continue;
    if (!activities.has(curName)) activities.set(curName, { ticketTypes: new Map(), ageConfig: '' });
    if (!activities.get(curName).ticketTypes.has(service)) {
      activities.get(curName).ticketTypes.set(service, {
        details: cell(r, 2),
        openTime: cell(r, 3),
        closeTime: cell(r, 4),
        duration: num(cell(r, 5)) || undefined,
        slots: cell(r, 6),
      });
    }
    for (const g of groups) for (const cfg of g.configs) {
      const price = num(cell(r, cfg.col));
      if (!price) continue;
      if (!activities.get(curName).ageConfig) activities.get(curName).ageConfig = g.configs.map((x) => x.config).join(', ');
      for (const range of g.ranges) prices.push({ activity: curName, service, config: cfg.config, price, ...range });
    }
  }
  return { activities, prices };
}

export async function importActivities(wb, { destinations = [] } = {}) {
  // Tag imported activities with the chosen destinations, falling back to Andaman.
  let destIds = (destinations || []).filter(Boolean);
  if (!destIds.length) {
    const andaman = await Destination.findOne({ name: 'Andaman' });
    if (andaman) destIds = [andaman._id];
  }
  let activities = 0, priceRows = 0;
  for (const sheetName of wb.SheetNames) {
    const { activities: acts, prices } = parseActivitiesSheet(sheetRows(wb.Sheets[sheetName]));
    for (const [name, info] of acts) {
      const ticketTypes = [...info.ticketTypes].map(([tName, t]) => ({
        name: tName,
        details: t.details || undefined,
        slots: t.slots || undefined,
        duration: t.duration,
        durationUnit: t.duration ? 'mins' : undefined,
      }));
      const prevAct = await TravelActivity.findOne({ name: nameEq(name) }).select('ticketTypes');
      const mergedTickets = mergeSubItems(ticketTypes, prevAct?.ticketTypes);
      const doc = await TravelActivity.findOneAndUpdate({ name: nameEq(name) }, { $set: { ageConfig: info.ageConfig || 'Adult, Child', destinations: destIds, ticketTypes: mergedTickets }, $setOnInsert: { name } }, { upsert: true, new: true, setDefaultsOnInsert: true });
      await TravelActivityPrice.deleteMany({ activity: doc._id });
      const rows = prices.filter((p) => p.activity === name && p.start && p.end).map((p) => ({ activity: doc._id, service: p.service, config: p.config, startDate: p.start, endDate: p.end, price: p.price }));
      if (rows.length) await TravelActivityPrice.insertMany(rows);
      activities++; priceRows += rows.length;
    }
  }
  return { activities, priceRows };
}

/* ===================== TRANSPORT ===================== */
export function parseTransportSheet(rows) {
  let H = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) if (cell(rows[i], 3).toLowerCase() === 'service') { H = i; break; }
  if (H < 0) return [];
  const maxCol = Math.max(...rows.slice(0, 8).map((r) => r.length), 8);
  const groups = [];
  for (let c = 8; c < rows[H].length; c++) if (cell(rows[H], c)) groups.push({ start: c });
  if (!groups.length) groups.push({ start: 8 });
  groups.forEach((g, i) => (g.end = groups[i + 1] ? groups[i + 1].start : maxCol));
  const ranges = []; let V = -1;
  for (let i = H + 1; i < Math.min(rows.length, H + 6); i++) {
    let hasDate = false, hasText = false;
    for (const g of groups) for (let c = g.start; c < g.end; c++) { const v = cell(rows[i], c); if (!v) continue; const r = parseRange(v); if (r) { ranges.push(r); (g.ranges = g.ranges || []).push(r); hasDate = true; } else hasText = true; }
    if (hasText && !hasDate && V < 0) V = i;
  }
  if (V < 0) V = H + 1;
  // CSV template keeps the dates inside the season label itself.
  for (const g of groups) if (!g.ranges) { const r = parseRange(cell(rows[H], g.start)); if (r) { g.ranges = [r]; ranges.push(r); } }
  const vehicles = [];
  // Pair each vehicle column with its own season's date range(s); fall back to
  // all ranges for legacy sheets where dates couldn't be matched to a group.
  for (const g of groups) for (let c = g.start; c < g.end; c++) { const v = cell(rows[V], c); if (v) vehicles.push({ col: c, name: v, ranges: g.ranges }); }
  const dateRanges = ranges.length ? ranges : [null];
  // Routes are keyed by START city (col A) + END city (col B) — "Port Blair"
  // and "Port Blair → Havelock" are DIFFERENT services with their own items.
  // A "-" or empty B means the service has no end city (local sightseeing).
  const routes = new Map(); let curFrom = ''; let curTo = '';
  for (let i = V + 1; i < rows.length; i++) {
    const r = rows[i];
    if (cell(r, 1)) { curFrom = cell(r, 1); curTo = cell(r, 2); }
    else if (cell(r, 2)) curTo = cell(r, 2);
    const service = cell(r, 3);
    if (!service || !curFrom) continue;
    const to = curTo && curTo !== '-' ? curTo : '';
    const key = `${curFrom.toLowerCase()}|${to.toLowerCase()}`;
    if (!routes.has(key)) routes.set(key, { from: curFrom, to, name: to ? `${curFrom} to ${to}` : curFrom, items: [], prices: [] });
    const route = routes.get(key);
    // Columns: Duty Code, A, B, Service, Distance, Start Time, Duration(mins), Day Schedule.
    const item = { name: service, description: cell(r, 7) };
    const distance = num(cell(r, 4));
    if (distance) item.distanceKms = distance;
    const startTime = cell(r, 5);
    if (startTime) item.startTime = startTime;
    const durationMins = num(cell(r, 6));
    if (durationMins) item.durationMins = durationMins;
    route.items.push(item);
    for (const v of vehicles) { const price = num(cell(r, v.col)); if (!price) continue; for (const range of (v.ranges || dateRanges)) if (range) route.prices.push({ itemName: service, config: v.name, price, ...range }); }
  }
  return [...routes.values()];
}

export async function importTransport(wb, { destinations = [] } = {}) {
  // Tag imported services with the destinations chosen in the upload form,
  // falling back to the Andaman destination when none were picked.
  let destIds = (destinations || []).filter(Boolean);
  if (!destIds.length) {
    const andaman = await Destination.findOne({ name: 'Andaman' });
    if (andaman) destIds = [andaman._id];
  }
  let services = 0, priceRows = 0;
  const vehicleNames = new Set();
  for (const { sheet } of pickSheets(wb.SheetNames)) {
    for (const route of parseTransportSheet(sheetRows(wb.Sheets[sheet]))) {
      const prevSvc = await TransportService.findOne({ name: nameEq(route.name) }).select('items imageUrl');
      const mergedItems = mergeSubItems(route.items.slice(0, 50), prevSvc?.items);
      const doc = await TransportService.findOneAndUpdate({ name: nameEq(route.name) }, { $set: { destinations: destIds, items: mergedItems, from: route.from || route.name, to: route.to || '' }, $setOnInsert: { name: route.name } }, { upsert: true, new: true, setDefaultsOnInsert: true });
      await TransportPrice.deleteMany({ service: doc._id });
      const rows = route.prices.map((p) => ({ service: doc._id, itemName: p.itemName, config: p.config, startDate: p.start, endDate: p.end, price: p.price }));
      if (rows.length) await TransportPrice.insertMany(rows);
      rows.forEach((r) => r.config && vehicleNames.add(r.config));
      services++; priceRows += rows.length;
    }
  }
  // Sync the vehicle/cab-type names used in the price sheet into the Option
  // master list (category 'vehicleType') — the Quote Builder's cab-type
  // picker searches that list, so an imported config is otherwise invisible
  // there even though it's right in the Transport Service Prices table.
  for (const name of vehicleNames) {
    await Option.findOneAndUpdate(
      { category: 'vehicleType', value: nameEq(name) },
      { $setOnInsert: { category: 'vehicleType', value: name, label: name } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
  return { services, priceRows };
}

/* ===================== DISPATCH ===================== */
export function detectType(wb) {
  for (const name of wb.SheetNames) {
    const rows = sheetRows(wb.Sheets[name]);
    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const joined = (rows[i] || []).map((c) => String(c).toLowerCase()).join('|');
      if (joined.includes('duty code') || joined.includes('day schedule')) return 'transport';
      if (joined.includes('group name') || cell(rows[i], 4).toLowerCase() === 'room') return 'hotels';
      if (cell(rows[i], 0).toLowerCase() === 'name' && cell(rows[i], 1).toLowerCase() === 'service') return 'activities';
    }
  }
  return 'unknown';
}

/* ===================== HOTELS MASTER (flat, no prices) ===================== */
const normHdr = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Aliases for flexible column matching regardless of exact header wording.
const COL_ALIASES = {
  name:          ['name', 'hotelname', 'propertyname', 'hotel'],
  groupname:     ['groupname', 'group', 'chain', 'chainname', 'grouphotelname'],
  location:      ['location', 'place', 'area'],
  star:          ['star', 'stars', 'starrating', 'rating', 'category'],
  phonedialcode: ['phonedialcode', 'dialcode', 'countrycode', 'isd', 'isdcode'],
  contactnumber: ['contactnumber', 'phone', 'mobile', 'contact', 'phone1', 'mobile1'],
  contactnumber2:['contactnumber2', 'phone2', 'mobile2', 'alternateno', 'alternatephone'],
  emailid:       ['emailid', 'email', 'emailaddress'],
  addressline1:  ['addressline1', 'address', 'street', 'addressline'],
  landmark:      ['landmark', 'nearbylandmark'],
  pincode:       ['pincode', 'pin', 'zipcode', 'zip', 'postal'],
  checkintime:   ['checkintime', 'checkin', 'checkinat', 'checkinhr'],
  checkouttime:  ['checkouttime', 'checkout', 'checkoutat', 'checkouthr'],
  url:           ['url', 'website', 'link', 'hotelurl'],
};

// Parse a flat hotels sheet: Group Name, Location, Name, Star, Address Line 1,
// Landmark, Pin Code, Phone Dial Code, Contact Number(s), Email Id, Checkin/Checkout, Url.
export function parseHotelsMasterSheet(rows) {
  let H = -1;
  // Search up to 15 rows to handle files with title/info rows before the header.
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const norm = (rows[i] || []).map(normHdr);
    const hasName  = norm.some((n) => COL_ALIASES.name.includes(n));
    const hasStar  = norm.some((n) => COL_ALIASES.star.includes(n));
    const hasGroup = norm.some((n) => COL_ALIASES.groupname.includes(n));
    if (hasName && (hasStar || hasGroup)) { H = i; break; }
  }
  if (H < 0) return [];
  const idx = {};
  rows[H].forEach((c, i) => { idx[normHdr(c)] = i; });
  // Flexible getter: tries all known aliases for each logical field.
  const getIdx = (key) => {
    for (const alias of (COL_ALIASES[key] || [key])) { if (idx[alias] != null) return idx[alias]; }
    return null;
  };
  const get = (row, key) => { const i = getIdx(key); return i == null ? '' : String(cell(row, i) ?? '').trim(); };
  const carry = (v, last) => (v === '...' || v === '…' || v === '' ? last : v);

  const out = [];
  let lastGroup = '', lastLocation = '';
  for (let i = H + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const name = get(row, 'name');
    if (!name) continue;
    lastGroup = carry(get(row, 'groupname'), lastGroup);
    lastLocation = carry(get(row, 'location'), lastLocation);
    const [city, state, country] = lastLocation.split(',').map((s) => s.trim());
    const dial = get(row, 'phonedialcode').replace(/[^0-9]/g, '') || '91';
    const phones = [get(row, 'contactnumber'), get(row, 'contactnumber2')]
      .filter(Boolean).map((number) => ({ countryCode: dial, number }));
    const street = get(row, 'addressline1');
    out.push({
      name,
      groupName: lastGroup || undefined,
      stars: Number(get(row, 'star')) || 3,
      location: {
        label: lastLocation || undefined,
        city: city || undefined,
        state: state || undefined,
        country: country || 'India',
        pin: get(row, 'pincode') || undefined,
        street: street || undefined,
        landmark: get(row, 'landmark') || undefined,
      },
      address: street || undefined,
      email: get(row, 'emailid') || undefined,
      phones,
      checkIn: get(row, 'checkintime') || undefined,
      checkOut: get(row, 'checkouttime') || undefined,
      detailsLink: get(row, 'url') || undefined,
    });
  }
  return out;
}

export async function importHotelsMaster(wb, opts = {}) {
  // Destinations stay trip-level (states/regions) — cities are never turned
  // into Destination records; city filtering uses the hotel's location.city.
  let extraDest = (opts.destinations || []).filter(Boolean).map(String);
  if (!extraDest.length) {
    const andaman = await Destination.findOne({ name: /andaman/i });
    if (andaman) extraDest = [String(andaman._id)];
  }
  let hotels = 0, skipped = 0;
  let totalRecordsParsed = 0;
  for (const sheetName of wb.SheetNames) {
    const records = parseHotelsMasterSheet(sheetRows(wb.Sheets[sheetName]));
    totalRecordsParsed += records.length;
    for (const rec of records) {
      try {
        const patch = { ...rec, destinations: [...new Set(extraDest)] };
        Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
        delete patch.name;
        await Hotel.findOneAndUpdate({ name: nameEq(rec.name) }, { $set: patch, $setOnInsert: { name: rec.name } }, { upsert: true, new: true, setDefaultsOnInsert: true });
        hotels++;
      } catch { skipped++; }
    }
  }
  if (totalRecordsParsed === 0) {
    throw new Error(
      'No hotel rows found. Make sure your file has these column headers (row 1): ' +
      'Group Name, Location, Name, Star, Address Line 1, Contact Number, Email Id. ' +
      'The "Name" and ("Star" or "Group Name") columns are required.'
    );
  }
  return { hotels, skipped };
}

export async function importWorkbook(wb, type = 'auto', opts = {}) {
  const t = !type || type === 'auto' ? detectType(wb) : type;
  if (t === 'hotels-master') return { type: t, ...(await importHotelsMaster(wb, opts)) };
  if (t === 'hotels') return { type: t, ...(await importHotels(wb, opts)) };
  if (t === 'activities') return { type: t, ...(await importActivities(wb, opts)) };
  if (t === 'transport') return { type: t, ...(await importTransport(wb, opts)) };
  throw new Error('Unrecognized file format — expected a Hotels, Transport, or Activities sheet');
}
