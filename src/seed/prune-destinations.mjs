/* One-off: keep only the two allowed destinations, delete the rest. */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { Destination } from '../models/Destination.js';

const KEEP = ['Andaman', 'Andaman and Nicobar Islands'];

async function run() {
  await connectDB();
  // Ensure the two exist.
  for (const name of KEEP) {
    await Destination.findOneAndUpdate(
      { name },
      { name, country: 'India', region: 'Andaman' },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
  const r = await Destination.deleteMany({ name: { $nin: KEEP } });
  // eslint-disable-next-line no-console
  console.log(`[prune-destinations] Deleted ${r.deletedCount} destination(s). Kept: ${KEEP.join(', ')}`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[prune-destinations] Failed:', err);
  process.exit(1);
});
