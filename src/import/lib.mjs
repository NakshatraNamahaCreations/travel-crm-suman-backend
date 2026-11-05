// Shared helpers for the Excel importers.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseDate(s) {
  const m = String(s).replace(/\s+/g, ' ').trim().match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  return new Date(Date.UTC(+m[3], mon, Math.min(+m[1], 28) <= 28 ? +m[1] : +m[1]));
}

export function parseRange(s) {
  const parts = String(s).split(/\s*[-–]\s*/);
  if (parts.length < 2) return null;
  const a = parseDate(parts[0]);
  const b = parseDate(parts[parts.length - 1]);
  return a && b ? { start: a, end: b } : null;
}

export function parsePersons(room) {
  const m = String(room).match(/(\d)\s*P\b/i);
  return m ? +m[1] : 2;
}

export function parseStar(v) {
  const m = String(v).match(/\d/);
  return m ? +m[0] : 0;
}

export function num(v) {
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function parseLoc(s) {
  const parts = String(s).split(',').map((x) => x.trim()).filter(Boolean);
  return {
    city: parts[0] || '',
    state: parts[1] || 'Andaman and Nicobar Islands',
    country: parts[2] || 'India',
  };
}

// Pair each "Copy of X" (newer, possibly name-truncated) with its original X.
// Returns [{ sheet, name }] — `sheet` to parse (prefer the copy's data),
// `name` the display name (prefer the fuller original name).
export function pickSheets(sheetNames) {
  const skip = (s) => /^sheet\d+$/i.test(String(s).trim()) || !String(s).trim();
  const strip = (s) => s.replace(/^copy of\s*/i, '').trim();
  const names = sheetNames.filter((s) => !skip(s));
  const copies = names.filter((s) => /^copy of/i.test(s));
  const origs = names.filter((s) => !/^copy of/i.test(s));

  const prefixMatch = (a, b) => {
    const x = a.toLowerCase().trim(), y = b.toLowerCase().trim();
    if (x === y) return true; // exact (handles short names like "Neil", "Havelock")
    const n = Math.min(x.length, y.length);
    return n >= 10 && x.slice(0, n) === y.slice(0, n); // truncated copy names
  };

  const used = new Set();
  const result = [];
  for (const o of origs) {
    const c = copies.find((cp) => !used.has(cp) && prefixMatch(strip(cp), o));
    if (c) { used.add(c); result.push({ sheet: c, name: o.trim() }); } // copy data + fuller name
    else result.push({ sheet: o, name: o.trim() });
  }
  for (const c of copies) if (!used.has(c)) result.push({ sheet: c, name: strip(c) });
  // CSV uploads parse as a single generic "Sheet1" — don't drop them. Empty
  // name so importers fall back to the name found inside the sheet data.
  if (!result.length) return sheetNames.map((s) => ({ sheet: s, name: '' }));
  return result;
}
