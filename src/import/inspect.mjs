// Dumps the structure of every Excel file under /doc so we can map columns to models.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(__dirname, '../../../doc');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(xlsx|xls|csv)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(DOC);
console.log(`Found ${files.length} spreadsheet(s)\n`);

for (const f of files) {
  console.log('═'.repeat(70));
  console.log('FILE:', path.relative(DOC, f));
  const wb = XLSX.readFile(f);
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
    console.log(`\n  SHEET "${sheetName}"  (${nonEmpty.length} non-empty rows)`);
    // print first 6 non-empty rows, truncating long cells
    nonEmpty.slice(0, 6).forEach((r, i) => {
      const cells = r.map((c) => String(c).slice(0, 22)).slice(0, 12);
      console.log(`   ${i === 0 ? 'HDR' : 'r' + i}: ${cells.join(' | ')}`);
    });
  }
  console.log('');
}
