/* One-off: rowsFromQuote() (serviceBooking.controller.js) used to collapse a
   hotel row's nights into one contiguous ServiceBooking span even when the
   nights were non-consecutive (e.g. [1,5,6,7] — same hotel booked again
   later after a stay elsewhere), producing a wrong date range and merging
   what should be two separate bookings into one. That's now fixed to split
   on gaps. This regenerates the 'hotel' ServiceBooking rows for specific
   already-generated trips so they pick up the corrected split.

   Usage: node src/seed/fix-nonconsecutive-hotel-bookings.mjs <queryNumber> [queryNumber...] */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { Organization } from '../models/Organization.js';
import { Query } from '../models/Query.js';
import { Quote } from '../models/Quote.js';
import { ServiceBooking } from '../models/ServiceBooking.js';
import { autoGenerateServiceBookings } from '../controllers/serviceBooking.controller.js';

const queryNumbers = process.argv.slice(2).map(Number).filter(Boolean);

async function run() {
  if (!queryNumbers.length) {
    console.log('Usage: node src/seed/fix-nonconsecutive-hotel-bookings.mjs <queryNumber> [queryNumber...]');
    process.exit(1);
  }
  await connectDB();
  const orgs = await Organization.find().select('name');

  for (const org of orgs) {
    enterTenant(org._id);
    for (const queryNumber of queryNumbers) {
      const query = await Query.findOne({ queryNumber });
      if (!query) continue;

      const existing = await ServiceBooking.find({ query: query._id, kind: 'hotel' });
      if (!existing.length) continue;

      const quoteId = existing[0].quote;
      const quote = quoteId ? await Quote.findById(quoteId) : await Quote.findOne({ query: query._id, status: 'accepted' });
      if (!quote) {
        console.log(`[${org.name}] Trip #${queryNumber}: no quote found, skipping.`);
        continue;
      }

      await ServiceBooking.deleteMany({ query: query._id, kind: 'hotel' });
      const created = await autoGenerateServiceBookings(query._id, quote._id, existing[0].bookedBy || null, ['hotel']);
      console.log(`[${org.name}] Trip #${queryNumber}: replaced ${existing.length} hotel booking row(s) with ${created.length} correctly-split row(s).`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('[fix-nonconsecutive-hotel-bookings] Failed:', err);
  process.exit(1);
});
