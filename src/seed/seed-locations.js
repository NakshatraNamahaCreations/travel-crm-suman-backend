/* Seed City and State collections from scratch. Safe to re-run (upsert by name). */
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { defaultOrg } from './org.js';
import { State } from '../models/State.js';
import { City } from '../models/City.js';

const STATES = [
  { name: 'Andaman and Nicobar Islands', country: 'India' },
];

const CITIES = [
  { name: 'Port Blair',        state: 'Andaman and Nicobar Islands' },
  { name: 'Havelock Island',   state: 'Andaman and Nicobar Islands' },
  { name: 'Neil Island',       state: 'Andaman and Nicobar Islands' },
  { name: 'Baratang Island',   state: 'Andaman and Nicobar Islands' },
  { name: 'Diglipur',          state: 'Andaman and Nicobar Islands' },
  { name: 'Rangat',            state: 'Andaman and Nicobar Islands' },
  { name: 'Mayabunder',        state: 'Andaman and Nicobar Islands' },
  { name: 'Long Island',       state: 'Andaman and Nicobar Islands' },
  { name: 'Little Andaman',    state: 'Andaman and Nicobar Islands' },
  { name: 'Jolly Buoy Island', state: 'Andaman and Nicobar Islands' },
  { name: 'Ross Island',       state: 'Andaman and Nicobar Islands' },
  { name: 'North Bay Island',  state: 'Andaman and Nicobar Islands' },
  { name: 'Radhanagar Beach',  state: 'Andaman and Nicobar Islands' },
];

async function run() {
  await connectDB();
  enterTenant((await defaultOrg())._id); // scope all writes to the default org

  // Upsert states
  const stateMap = {};
  for (const s of STATES) {
    const doc = await State.findOneAndUpdate(
      { name: s.name },
      { name: s.name, country: s.country },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    stateMap[s.name] = doc._id;
    console.log(`  [state] ${s.name}`);
  }

  // Upsert cities
  for (const c of CITIES) {
    await City.findOneAndUpdate(
      { name: c.name },
      { name: c.name, state: stateMap[c.state] || undefined },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`  [city]  ${c.name}`);
  }

  console.log(`\n✓ Done — ${STATES.length} state(s), ${CITIES.length} city/cities seeded.`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
