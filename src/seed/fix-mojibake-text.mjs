/* One-off: repairs "mojibake" text in imported master data — UTF-8 bytes that
   were decoded as latin1/cp1252 somewhere in the Excel import path, so
   "café" ended up stored as "cafÃ©" and shows that way in the app and on the
   quotation PDF.

   The repair is deterministic: re-encode the string's characters back to
   bytes as latin1 and decode them as UTF-8. It only rewrites a field when
   that round-trip actually produces different (and still valid) text, so
   re-running is safe and untouched fields are left alone.

   Usage: node src/seed/fix-mojibake-text.mjs [--apply]
   Without --apply it only reports what it would change. */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { Organization } from '../models/Organization.js';
import { TravelActivity } from '../models/TravelActivity.js';
import { TransportService } from '../models/TransportService.js';
import { Hotel } from '../models/Hotel.js';

const APPLY = process.argv.includes('--apply');
const RX = /[ÃÂ][-¿]/;

function repair(s) {
  if (!s || !RX.test(s)) return null;
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  // Reject if the round-trip produced replacement chars (not real mojibake).
  if (!fixed || fixed.includes('�') || fixed === s) return null;
  return fixed;
}

async function run() {
  await connectDB();
  let changed = 0;

  for (const org of await Organization.find().select('name')) {
    enterTenant(org._id);

    for (const a of await TravelActivity.find()) {
      let dirty = false;
      const d = repair(a.details);
      if (d) { a.details = d; dirty = true; }
      (a.ticketTypes || []).forEach((t) => {
        const td = repair(t.details);
        if (td) { t.details = td; dirty = true; }
      });
      if (dirty) { await a.save(); changed++; console.log(`  [activity] ${a.name}`); }
    }

    for (const t of await TransportService.find()) {
      let dirty = false;
      (t.items || []).forEach((i) => {
        const d = repair(i.description);
        if (d) { i.description = d; dirty = true; }
      });
      if (dirty) { await t.save(); changed++; console.log(`  [transport] ${t.name}`); }
    }

    for (const h of await Hotel.find()) {
      const n = repair(h.notes);
      if (n) { h.notes = n; await h.save(); changed++; console.log(`  [hotel] ${h.name}`); }
    }
  }

  console.log(`\n${APPLY ? '✓ Repaired' : 'Would repair'} ${changed} document(s).`);
  if (!APPLY) console.log('Re-run with --apply to write the changes.');
  await mongoose.disconnect();
  process.exit(0);
}

// Dry-run mode still loads and mutates in memory but never calls save().
if (!APPLY) {
  const origSave = mongoose.Model.prototype.save;
  mongoose.Model.prototype.save = async function noop() { return this; };
  void origSave;
}

run().catch((err) => {
  console.error('[fix-mojibake-text] Failed:', err);
  process.exit(1);
});
