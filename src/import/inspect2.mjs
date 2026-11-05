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

const target = process.argv[2] || 'Transport';
const files = walk(DOC).filter((f) => f.toLowerCase().includes(target.toLowerCase()));

for (const f of files) {
  const wb = XLSX.readFile(f);
  console.log('FILE:', path.basename(f), '| sheets:', wb.SheetNames.length);
  // show first sheet fully (all columns), first 6 rows
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log('SHEET:', wb.SheetNames[0]);
  rows.slice(0, 7).forEach((r, i) => {
    console.log(`  ${i}: [${r.map((c) => String(c).slice(0, 26)).join('] [')}]`);
  });
  console.log('  ...all sheet names:', wb.SheetNames.join(' | '));
  console.log('');
}
