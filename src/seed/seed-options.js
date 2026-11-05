/* One-shot: insert/update default option lists only (cities, states, meal plans, etc).
   Safe to re-run — uses upsert so nothing is duplicated or deleted. */
import { connectDB } from '../config/db.js';
import { enterTenant } from '../tenant/context.js';
import { defaultOrg } from './org.js';
import { Option } from '../models/Option.js';

const DEFAULTS = {
  city: [
    'Port Blair', 'Havelock Island', 'Neil Island', 'Baratang Island',
    'Diglipur', 'Rangat', 'Mayabunder', 'Long Island',
    'Little Andaman', 'Jolly Buoy Island', 'Ross Island',
    'North Bay Island', 'Radhanagar Beach',
  ],
  state: ['Andaman and Nicobar Islands'],
  country: ['India'],
  mealPlan: ['Room only', 'CP', 'MAP', 'AP', 'CP MAP'],
  salutation: ['Mr.', 'Mrs.', 'Ms.'],
  currency: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'THB'],
  paymentMode: ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'],
  vehicleType: [
    'Sedan (Dzire/Etios)', 'SUV (Xylo/Ertiga)',
    '17 Seater Tempo Traveller', '26 Seater Tempo Traveller',
  ],
  hotelGroup: ['Taj', 'Lemon Tree', 'Symphony', 'Silver Sand', 'TSG', 'NK', 'Aquays', 'Ocean Tree'],
  hotelService: [
    'Candle Light Dinner', 'Beach Side Candle Light Dinner', 'Gala Dinner',
    'Honeymoon Cake', 'Flower Bed Decoration', 'Fruit Basket', 'Early Check-in', 'Late Check-out',
  ],
  tripService: [
    'Cake and Room Decoration', 'Candle Light Dinner', 'Candle Light Dinner (Pool Side)',
    'Off Road Dinner', 'Side Treking', 'Bonfire', 'Photography / Videography', 'Scuba Diving',
  ],
  paymentPreference: [
    '25% on Booking Date, 75% 1 day after Checkin Date',
    '25% on Booking Date, 75% 2 days before Checkin Date',
    'Full payment on booking',
    '50% advance, 50% on arrival',
  ],
};

async function run() {
  await connectDB();
  enterTenant((await defaultOrg())._id); // scope all writes to the default org
  let inserted = 0;
  let skipped = 0;

  for (const [category, values] of Object.entries(DEFAULTS)) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      const existing = await Option.findOne({ category, value: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      if (existing) { skipped++; continue; }
      await Option.create({ category, value, label: value, order: i });
      inserted++;
      // eslint-disable-next-line no-console
      console.log(`  [+] ${category}: ${value}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n✓ Done — ${inserted} inserted, ${skipped} already existed.`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
