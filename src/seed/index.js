/* Seeds the default org, an admin user + a couple of sample teams.
   Safe to re-run (idempotent on email/name). All writes run inside the default
   org's tenant context so tenantPlugin stamps/scopes them automatically. */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { runWithTenant } from '../tenant/context.js';
import { defaultOrg } from './org.js';
import { User } from '../models/User.js';
import { Team } from '../models/Team.js';
import { Destination } from '../models/Destination.js';
import { QuerySource } from '../models/QuerySource.js';
import { Tag } from '../models/Tag.js';
import { Hotel } from '../models/Hotel.js';
import { HotelPrice } from '../models/HotelPrice.js';
import { TransportService } from '../models/TransportService.js';
import { TravelActivity } from '../models/TravelActivity.js';
import { TravelActivityPrice } from '../models/TravelActivityPrice.js';
import { Query } from '../models/Query.js';
import { Option } from '../models/Option.js';

async function upsertMany(Model, field, values, extra = () => ({})) {
  for (const v of values) {
    const doc = typeof v === 'string' ? { [field]: v, ...extra(v) } : v;
    await Model.findOneAndUpdate({ [field]: doc[field] }, doc, {
      upsert: true,
      setDefaultsOnInsert: true,
    });
  }
}


async function seedTenantData() {
  const teams = ['Inbound Sales', 'Outbound Sales'];
  const teamDocs = {};
  for (const name of teams) {
    teamDocs[name] = await Team.findOneAndUpdate(
      { name },
      { name },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  const adminEmail = 'admin@travelcrm.test';
  let admin = await User.findOne({ email: adminEmail });
  if (!admin) {
    admin = await User.create({
      name: 'CRM Admin',
      email: adminEmail,
      password: 'admin123',
      role: 'admin',
      team: teamDocs['Inbound Sales']._id,
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] Created admin: ${adminEmail} / admin123`);
  } else {
    // eslint-disable-next-line no-console
    console.log('[seed] Admin already exists, skipping.');
  }

  const salesEmail = 'sales@travelcrm.test';
  if (!(await User.findOne({ email: salesEmail }))) {
    await User.create({
      name: 'Sample Salesperson',
      email: salesEmail,
      password: 'sales123',
      role: 'sales',
      team: teamDocs['Outbound Sales']._id,
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] Created sales user: ${salesEmail} / sales123`);
  }

  // Master data
  // Andaman Travel Care is an Andaman Islands operator — islands & spots first.
  // Only these two destinations are offered.
  const DESTINATION_NAMES = ['Andaman', 'Andaman and Nicobar Islands'];
  await upsertMany(Destination, 'name', [
    { name: 'Andaman', country: 'India', region: 'Islands' },
    { name: 'Andaman and Nicobar Islands', country: 'India', region: 'Andaman' },
  ]);
  // Remove any other destinations seeded previously.
  await Destination.deleteMany({ name: { $nin: DESTINATION_NAMES } });
  await upsertMany(QuerySource, 'name', [
    'Website',
    'B2B',
    'WhatsApp',
    'Referral',
    'Walk-in',
    'Instagram',
    'Google Ads',
  ]);
  await upsertMany(Tag, 'name', ['honeymoon', 'family', 'group', 'luxury', 'budget'], () => ({}));

  // Generic option lists for user-extensible dropdowns
  const OPTION_DEFAULTS = {
    mealPlan: ['Room only', 'CP', 'MAP', 'AP', 'CP MAP'],
    salutation: ['Mr.', 'Mrs.', 'Ms.'],
    currency: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'THB'],
    paymentMode: ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'],
    vehicleType: ['Sedan (Dzire/Etios)', 'SUV (Xylo/Ertiga)', '17 Seater Tempo Traveller', '26 Seater Tempo Traveller'],
    paxConfig: ['Adult', 'Child (2-12)', 'Child (6-12)', 'Child (1-2)', 'Infant'],
    city: ['Port Blair', 'Havelock Island', 'Neil Island', 'Baratang Island', 'Diglipur', 'Rangat', 'Mayabunder', 'Long Island', 'Little Andaman', 'Jolly Buoy Island', 'Ross Island', 'North Bay Island', 'Radhanagar Beach'],
    state: ['Andaman and Nicobar Islands'],
    country: ['India'],
    hotelGroup: ['Taj', 'Lemon Tree', 'Symphony', 'Silver Sand', 'TSG', 'NK', 'Aquays', 'Ocean Tree'],
    paymentPreference: [
      '25% on Booking Date, 75% 1 day after Checkin Date',
      '25% on Booking Date, 75% 2 days before Checkin Date',
      'Full payment on booking',
      '50% advance, 50% on arrival',
    ],
  };
  for (const [category, values] of Object.entries(OPTION_DEFAULTS)) {
    for (let i = 0; i < values.length; i++) {
      await Option.findOneAndUpdate(
        { category, value: values[i] },
        { category, value: values[i], label: values[i], order: i },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
  }
  // Populate roomType options from the imported hotels' room types.
  const roomTypeSet = new Set();
  for (const h of await Hotel.find({}, 'roomTypes')) {
    (h.roomTypes || []).forEach((r) => r.name && roomTypeSet.add(r.name.trim()));
  }
  for (const name of roomTypeSet) {
    await Option.findOneAndUpdate({ category: 'roomType', value: name }, { category: 'roomType', value: name, label: name }, { upsert: true, setDefaultsOnInsert: true });
  }
  // eslint-disable-next-line no-console
  console.log('[seed] Master data ready (destinations, sources, tags, option lists).');

  // ---- Services / supplier inventory ----
  const andaman = await Destination.findOne({ name: 'Andaman' });
  const goa = await Destination.findOne({ name: 'Goa' });
  const destId = andaman?._id;

  const hotelsSeed = [
    {
      name: 'Blue Bird Residency',
      location: { city: 'Neil Island', state: 'Andaman and Nicobar Islands', country: 'India' },
      stars: 3,
      mealPlans: ['AP', 'CP', 'CP MAP', 'Room only'],
      roomTypes: [{ name: 'Standard Non AC', eb: 1, aweb: 1, cweb: 1 }],
      childEbAge: { from: 6, to: 12 },
      destinations: destId ? [destId] : [],
      address: 'Neil Island, Andaman and Nicobar Islands, India',
    },
    {
      name: 'Silver Sand Village Resort',
      location: { city: 'Havelock', state: 'Andaman and Nicobar Islands', country: 'India' },
      stars: 5,
      mealPlans: ['AP', 'MAP', 'CP'],
      roomTypes: [
        { name: 'Andaman Cabana', eb: 1, aweb: 1, cweb: 1 },
        { name: 'Premium Room', eb: 1, aweb: 1, cweb: 1 },
      ],
      destinations: destId ? [destId] : [],
    },
    {
      name: 'Lemon Tree Hotel',
      location: { city: 'Port Blair', state: 'Andaman and Nicobar Islands', country: 'India' },
      stars: 4,
      mealPlans: ['CP', 'MAP', 'AP'],
      roomTypes: [{ name: 'Superior Room', eb: 1, aweb: 1, cweb: 1 }],
      destinations: destId ? [destId] : [],
    },
  ];
  for (const h of hotelsSeed) {
    const doc = await Hotel.findOneAndUpdate({ name: h.name }, h, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
    // Seed a couple of rate rows for the 5-star resort
    if (h.name === 'Silver Sand Village Resort') {
      const rows = [
        { roomType: 'Andaman Cabana', mealPlan: 'AP', basePrice: 17783, aweb: 4800, cweb: 4800, cwoeb: 3800 },
        { roomType: 'Andaman Cabana', mealPlan: 'MAP', basePrice: 14083, aweb: 3400, cweb: 3400, cwoeb: 2400 },
        { roomType: 'Premium Room', mealPlan: 'CP', basePrice: 8063, aweb: 2000, cweb: 2000, cwoeb: 1000 },
      ];
      for (const r of rows) {
        await HotelPrice.findOneAndUpdate(
          { hotel: doc._id, roomType: r.roomType, mealPlan: r.mealPlan },
          {
            hotel: doc._id,
            startDate: new Date('2026-01-16'),
            endDate: new Date('2026-09-30'),
            persons: 2,
            ...r,
          },
          { upsert: true, setDefaultsOnInsert: true }
        );
      }
    }
  }

  await TransportService.findOneAndUpdate(
    { name: 'Port Blair Arrival' },
    {
      name: 'Port Blair Arrival',
      from: 'Port Blair Arrival',
      destinations: destId ? [destId] : [],
      items: [
        { name: 'Day At leisure', description: 'On this day you are free to plan for yourself.' },
        { name: 'Cellular Jail Visit with Sound & Light Show', description: 'Visit the historic Cellular Jail followed by a Light & Sound Show.' },
      ],
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  const activity = await TravelActivity.findOneAndUpdate(
    { name: 'Havelock to Neil Island' },
    {
      name: 'Havelock to Neil Island',
      destinations: destId ? [destId] : [],
      ageConfig: 'Adult, Child (2-12)',
      ticketTypes: [
        { name: 'Makruzz Ferry: Premium' },
        { name: 'Nautika Ferry: Royal' },
        { name: 'Private Ferry' },
      ],
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  for (const cfg of ['Adult', 'Child (2-12)']) {
    await TravelActivityPrice.findOneAndUpdate(
      { activity: activity._id, service: 'Makruzz Ferry: Premium', config: cfg },
      {
        activity: activity._id,
        service: 'Makruzz Ferry: Premium',
        config: cfg,
        startDate: new Date('2026-01-16'),
        endDate: new Date('2026-12-31'),
        price: cfg === 'Adult' ? 1775 : 1500,
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  if (goa) {
    /* keep goa referenced so lint stays quiet */
  }
  // eslint-disable-next-line no-console
  console.log('[seed] Services ready (hotels, prices, transport, activities).');

  // ---- A sample lead so the pipeline isn't empty ----
  if (!(await Query.findOne({ referenceId: 'SEED-ANI-001' }))) {
    const website = await QuerySource.findOne({ name: 'Website' });
    await Query.create({
      referenceId: 'SEED-ANI-001',
      source: website?._id,
      destinations: andaman ? [andaman._id] : [],
      startDate: new Date('2026-06-26'),
      nights: 3,
      pax: { adults: 2, children: [{ age: 8 }] },
      guest: {
        salutation: 'Mr.',
        name: 'Yogi Sharma',
        email: 'yogi@example.com',
        location: 'Delhi',
        phones: [{ countryCode: '91', number: '9890091212', isPrimary: true }],
      },
      comments: 'Honeymoon-style trip, prefers sea-view rooms.',
      status: 'in_progress',
      owner: admin._id,
      createdBy: admin._id,
    });
    // eslint-disable-next-line no-console
    console.log('[seed] Sample query (Mr. Yogi → Andaman) created.');
  }

  // eslint-disable-next-line no-console
  console.log('[seed] Done.');
}

async function run() {
  await connectDB();
  const org = await defaultOrg();
  // eslint-disable-next-line no-console
  console.log(`[seed] Seeding into org: ${org.name} (${org._id})`);
  await runWithTenant(org._id, seedTenantData);
  await mongoose.disconnect();
  process.exit(0);
}

// Only run when executed directly (this module is also imported for defaultOrg).
if (process.argv[1] && /seed[\\/]index\.js$/.test(process.argv[1])) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] Failed:', err);
    process.exit(1);
  });
}
