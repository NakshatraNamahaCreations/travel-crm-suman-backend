/* One-off: registers vehicle/cab-type names already sitting in TransportPrice
   (from Excel imports done before the importer synced them) into the Option
   master list (category 'vehicleType'), per organization. Safe to re-run —
   upserts, so nothing is duplicated. See importTransport in import/core.mjs
   for the ongoing sync going forward. */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { Organization } from '../models/Organization.js';
import { TransportPrice } from '../models/TransportPrice.js';
import { Option } from '../models/Option.js';

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function run() {
  await connectDB();
  const orgs = await Organization.find().select('name');
  let totalInserted = 0;

  for (const org of orgs) {
    enterTenant(org._id);
    const names = (await TransportPrice.distinct('config')).filter(Boolean);
    let inserted = 0;
    for (const name of names) {
      const existing = await Option.findOne({ category: 'vehicleType', value: new RegExp(`^${escRx(name)}$`, 'i') });
      if (existing) continue;
      await Option.create({ category: 'vehicleType', value: name, label: name });
      inserted++;
      // eslint-disable-next-line no-console
      console.log(`  [+] ${org.name}: ${name}`);
    }
    totalInserted += inserted;
    // eslint-disable-next-line no-console
    console.log(`[${org.name}] ${names.length} distinct config(s) found, ${inserted} new option(s) added.`);
  }

  // eslint-disable-next-line no-console
  console.log(`\n✓ Done — ${totalInserted} vehicleType option(s) added across ${orgs.length} organization(s).`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[backfill-vehicle-options] Failed:', err);
  process.exit(1);
});
