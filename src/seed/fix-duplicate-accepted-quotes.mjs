/* One-off: enforce a single accepted quote per query.
   Keeps the quote the booking points to (or the newest accepted one when no
   booking exists) and demotes the rest to 'sent'. */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { Quote } from '../models/Quote.js';
import { Booking } from '../models/Booking.js';

async function run() {
  await connectDB();

  const dupes = await Quote.aggregate([
    { $match: { status: 'accepted' } },
    { $group: { _id: '$query', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  let demoted = 0;
  for (const { _id: queryId, ids } of dupes) {
    const booking = await Booking.findOne({ query: queryId, quote: { $in: ids } }).sort('-createdAt');
    let keep = booking?.quote;
    if (!keep) {
      const newest = await Quote.findOne({ _id: { $in: ids } }).sort('-updatedAt').select('_id');
      keep = newest._id;
    }
    const r = await Quote.updateMany({ _id: { $in: ids, $ne: keep }, status: 'accepted' }, { status: 'sent' });
    demoted += r.modifiedCount;
    // eslint-disable-next-line no-console
    console.log(`[fix-accepted] query ${queryId}: kept quote ${keep}, demoted ${r.modifiedCount}`);
  }

  // eslint-disable-next-line no-console
  console.log(`[fix-accepted] ${dupes.length} querie(s) had duplicates; ${demoted} quote(s) demoted to 'sent'.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[fix-accepted] Failed:', err);
  process.exit(1);
});
