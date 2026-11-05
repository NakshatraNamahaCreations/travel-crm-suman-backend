/* Demo data for a fresh database — a small but complete platform you can show
   a client: five tenant companies on three plans, each with staff, supplier
   inventory, a full trip pipeline (leads → quotes → bookings) and the money
   that follows it (collections, supplier payouts, instalments, GST invoices).

   Every number the owner panel reads is populated, and the companies differ on
   purpose (big/small, active/expiring/expired/suspended, full/limited modules)
   so the client-wise views actually have something to compare.

   Usage, from the `server` folder:
     npm run seed:demo                      # fill; skips companies already there
     npm run seed:demo -- --only=coral      # just the companies matching a name
     npm run seed:demo -- --leads=5         # cap the pipeline size (quick run)
     npm run seed:demo -- --drop=coral      # remove ONE company, then re-seed it
     npm run seed:demo -- --reset           # DESTRUCTIVE: wipe everything first

   Data is generated from a fixed seed, so re-running after a --reset produces
   the same demo again.
*/
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { env } from '../config/env.js';
import { MODULE_KEYS } from '../config/modules.js';
import { runWithTenant } from '../tenant/context.js';
import { seedMasterData } from './masterData.js';
import { Organization } from '../models/Organization.js';
import { Plan } from '../models/Plan.js';
import { SubscriptionPayment } from '../models/SubscriptionPayment.js';
import { OrgProfile } from '../models/OrgProfile.js';
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
import { Quote } from '../models/Quote.js';
import { Booking } from '../models/Booking.js';
import { Payment } from '../models/Payment.js';
import { Installment } from '../models/Installment.js';
import { GstInvoice } from '../models/GstInvoice.js';
import { Account } from '../models/Account.js';
import { Counter } from '../models/Counter.js';
import { Option } from '../models/Option.js';

/* ------------------------------------------------------------------ random */
// Deterministic PRNG (mulberry32) — a demo that looks the same every time is
// easier to talk through than one that reshuffles on every run.
let _seed = 20261030;
const rnd = () => {
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const some = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  return out;
};
// Same pick, but keeping the source order — an itinerary has to read arrival
// first and departure last, so the transport legs can't come out shuffled.
const someInOrder = (arr, n) => {
  const chosen = new Set();
  while (chosen.size < Math.min(n, arr.length)) chosen.add(Math.floor(rnd() * arr.length));
  return [...chosen].sort((a, b) => a - b).map((i) => arr[i]);
};
// Weighted choice from [[value, weight], ...].
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
};

const DAY = 86400000;
const TODAY = new Date();
TODAY.setHours(9, 30, 0, 0);
const daysAgo = (n) => new Date(TODAY.getTime() - n * DAY);
const daysOut = (n) => new Date(TODAY.getTime() + n * DAY);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
// Nothing that already happened may be dated after today. A lead created three
// days ago plus "quoted 4 days later" lands in the future, and a quote sent
// tomorrow or a payment received next week reads as a bug in the demo.
const clampPast = (d) => (d.getTime() > TODAY.getTime() ? new Date(TODAY) : d);
const r0 = (n) => Math.round(n);
const inr = (n) => `₹${r0(n).toLocaleString('en-IN')}`;

/* ------------------------------------------------------- reference catalogs */
const FIRST = ['Arjun', 'Priya', 'Rahul', 'Sneha', 'Vikram', 'Divya', 'Karthik', 'Meera', 'Rohit', 'Anjali',
  'Suresh', 'Kavya', 'Nikhil', 'Pooja', 'Aditya', 'Lakshmi', 'Manoj', 'Swathi', 'Harish', 'Ritu',
  'Sandeep', 'Nisha', 'Gautam', 'Shruti', 'Abhishek', 'Deepa', 'Varun', 'Ananya', 'Prakash', 'Ishita'];
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Menon', 'Patel', 'Verma', 'Gupta', 'Rao', 'Pillai',
  'Desai', 'Joshi', 'Kulkarni', 'Banerjee', 'Chatterjee', 'Krishnan', 'Subramanian', 'Mehta', 'Shetty', 'Bose'];
const ORIGIN_CITIES = ['Chennai', 'Bengaluru', 'Hyderabad', 'Mumbai', 'Delhi', 'Pune', 'Kolkata', 'Kochi',
  'Coimbatore', 'Ahmedabad', 'Jaipur', 'Lucknow', 'Indore', 'Nagpur', 'Visakhapatnam'];
const SALUTATIONS = ['Mr.', 'Mrs.', 'Ms.'];

// The companies are Indian outbound agencies selling Maldives packages — which
// is why guests come from Indian cities, billing is in INR and GST invoices
// still make sense, while every destination below sits in the Maldives.
const DESTINATION = 'Maldives';
const HOME_CITY = 'Chennai';
const HOME_STATE = 'Tamil Nadu';
const GST_STATE_CODE = '33'; // Tamil Nadu

// Supplier inventory. Each company gets a slice of this.
const HOTEL_CATALOG = [
  { name: 'Lagoon Pearl Resort & Spa', city: 'Baa Atoll', stars: 5, group: 'Lagoon Pearl', rate: 55000, rooms: ['Overwater Villa', 'Beach Pool Villa'] },
  { name: 'Coral Bay Water Villas', city: 'Ari Atoll', stars: 5, group: 'Coral Bay', rate: 42000, rooms: ['Water Villa', 'Sunset Water Villa'] },
  { name: 'Azure Sands Maldives', city: 'South Malé Atoll', stars: 5, group: 'Azure', rate: 38000, rooms: ['Beach Villa', 'Garden Villa'] },
  { name: 'Reef Horizon Resort', city: 'Vaavu Atoll', stars: 4, group: 'Reef Horizon', rate: 24000, rooms: ['Ocean Suite', 'Deluxe Beach Room'] },
  { name: 'Turquoise Bay Resort', city: 'Dhigurah', stars: 4, group: 'Turquoise', rate: 22000, rooms: ['Sea View Room', 'Family Suite'] },
  { name: 'Sunset Atoll Retreat', city: 'Rasdhoo', stars: 4, group: 'Sunset Atoll', rate: 19500, rooms: ['Lagoon Room', 'Deluxe Room'] },
  { name: 'Blue Lagoon Beach Hotel', city: 'Maafushi', stars: 4, group: 'Blue Lagoon', rate: 12500, rooms: ['Superior Room', 'Standard Room'] },
  { name: 'Manta Reef Lodge', city: 'Fulidhoo', stars: 3, group: 'Manta Reef', rate: 9800, rooms: ['Deluxe Room', 'Twin Room'] },
  { name: 'Harbour View Inn', city: 'Hulhumalé', stars: 3, group: 'Harbour View', rate: 8500, rooms: ['Standard Room', 'City View Room'] },
  { name: 'Ocean Breeze Guest House', city: 'Thulusdhoo', stars: 3, group: 'Ocean Breeze', rate: 7200, rooms: ['Standard Room'] },
];

const TRANSPORT_CATALOG = [
  { name: 'Velana Airport Arrival', from: 'Velana International Airport', to: 'Malé Hotel', items: ['Airport Meet & Greet', 'Speedboat Transfer to Hotel', 'Malé City Orientation Walk'] },
  { name: 'Malé to Maafushi', from: 'Malé', to: 'Maafushi', items: ['Shared Speedboat Transfer', 'Local Island Orientation'] },
  { name: 'Resort Transfer by Seaplane', from: 'Malé', to: 'Resort Island', items: ['Seaplane Transfer', 'Seaplane Lounge Access'] },
  { name: 'Island Hopping Day Trip', from: 'Maafushi', to: 'Maafushi', items: ['Sandbank Visit', 'Local Island Walk', 'Beach BBQ Lunch'] },
  { name: 'Maafushi to Ari Atoll', from: 'Maafushi', to: 'Ari Atoll', items: ['Speedboat Transfer', 'Snorkel Stop En Route'] },
  { name: 'Departure Transfer', from: 'Resort Island', to: 'Velana International Airport', items: ['Speedboat to Airport', 'Airport Drop & Check-in Assistance'] },
];

const ACTIVITY_CATALOG = [
  { name: 'Malé to Maafushi Transfer', kind: 'ticket', tickets: ['Shared Speedboat', 'Private Speedboat', 'Public Ferry'], adult: 2200, child: 1600 },
  { name: 'Seaplane Scenic Flight', kind: 'ticket', tickets: ['Scenic Flight'], adult: 9500, child: 7000 },
  { name: 'Snorkelling with Turtles', kind: 'activity', tickets: ['Half Day', 'Full Day'], adult: 3200, child: 2400 },
  { name: 'Scuba Diving Discovery', kind: 'activity', tickets: ['Shore Dive', 'Boat Dive'], adult: 7500, child: 5500 },
  { name: 'Dolphin Sunset Cruise', kind: 'activity', tickets: ['Shared Cruise', 'Private Cruise'], adult: 2800, child: 2000 },
  { name: 'Sandbank Picnic', kind: 'activity', tickets: ['Shared Trip', 'Private Trip'], adult: 4200, child: 3000 },
  { name: 'Manta Ray Snorkelling Trip', kind: 'activity', tickets: ['Standard Trip'], adult: 6800, child: 4800 },
  { name: 'Whale Shark Excursion', kind: 'activity', tickets: ['Full Day Excursion'], adult: 8500, child: 6000 },
];

// Transfers here float rather than drive, so a "vehicle" is a boat seat.
const VEHICLES = ['Shared Speedboat', 'Private Speedboat', 'Public Ferry'];
const PAYMENT_MODES = ['UPI', 'Bank Transfer', 'Card', 'Cash', 'Cheque'];
const TRIP_TAGS = ['honeymoon', 'family', 'group', 'luxury', 'budget'];
const LOST_REASONS = ['Budget too high', 'Chose another operator', 'Trip postponed indefinitely',
  'No response after follow-ups', 'Booked directly with the resort', 'Flight fares went up'];
const LEAD_NOTES = ['Honeymoon couple, wants an overwater villa and a candle-light dinner.',
  'Family of four, needs connecting rooms and a child-friendly itinerary.',
  'Corporate group offsite — needs GST invoice and a single consolidated bill.',
  'Repeat guest from last season, asked for the same resort in Ari Atoll.',
  'Budget-conscious, prefers a local island stay over a private resort.',
  'Wants scuba diving for two and a private speedboat throughout.',
  'Senior citizens travelling — asked for a seaplane transfer instead of a long boat ride.',
  'Shortlisting three operators, comparing quotes this week.'];

/* --------------------------------------------------------- platform catalog */
const PLANS = [
  {
    name: 'Starter',
    price: 7500,
    durationMonths: 3,
    description: 'Trips, bookings and hotel inventory. For a single-branch agency finding its feet.',
    modules: ['trips', 'bookings', 'hotels'],
  },
  {
    name: 'Professional',
    price: 24000,
    durationMonths: 12,
    description: 'Everything in Starter plus accounting, tasks, transport and activities.',
    modules: ['trips', 'bookings', 'accounting', 'tasks', 'hotels', 'transport', 'activities', 'whatsapp'],
  },
  {
    name: 'Enterprise',
    price: 48000,
    durationMonths: 12,
    description: 'The full CRM with unlimited staff accounts and priority support.',
    modules: [...MODULE_KEYS],
  },
];

// One entry per tenant company. The spread across plan / subscription state /
// size is deliberate — it is what makes the owner panel worth looking at.
const COMPANIES = [
  {
    name: 'Irshad Travels',
    brand: 'Irshad Travels',
    domain: 'irshadtravels.com',
    plan: 'Enterprise',
    expiresInDays: 264,
    renewals: 3,
    leads: 74,
    inventory: { hotels: 10, transport: 6, activities: 8 },
    staff: [
      ['Irshad Ahmed', 'admin', 'Inbound Sales'],
      ['Divya Krishnan', 'manager', 'Inbound Sales'],
      ['Arun Prasad', 'sales', 'Inbound Sales'],
      ['Nithya Balaji', 'sales', 'Outbound Sales'],
      ['Vijay Anand', 'operations', 'Operations'],
      ['Sangeetha Raman', 'accounts', 'Accounts'],
      ['Mohan Das', 'sales', 'Outbound Sales'],
    ],
  },
  {
    name: 'Coral Reef Holidays',
    brand: 'Coral Reef Holidays',
    domain: 'coralreefholidays.in',
    plan: 'Professional',
    expiresInDays: 97,
    renewals: 2,
    leads: 46,
    inventory: { hotels: 7, transport: 5, activities: 6 },
    staff: [
      ['Farhan Qureshi', 'admin', 'Sales'],
      ['Shalini Pillai', 'manager', 'Sales'],
      ['Deepak Nair', 'sales', 'Sales'],
      ['Reshma Thomas', 'operations', 'Operations'],
      ['Ganesh Iyer', 'accounts', 'Accounts'],
    ],
  },
  {
    name: 'Sunrise Island Tours',
    brand: 'Sunrise Island Tours',
    domain: 'sunriseislandtours.com',
    plan: 'Starter',
    expiresInDays: 11, // inside the 30-day renewal window → "Expiring soon"
    renewals: 1,
    leads: 22,
    inventory: { hotels: 5, transport: 4, activities: 4 },
    staff: [
      ['Pradeep Varma', 'admin', 'Sales'],
      ['Anitha Ravi', 'sales', 'Sales'],
      ['Sathish Kumar', 'operations', 'Operations'],
    ],
  },
  {
    name: 'Blue Horizon Travels',
    brand: 'Blue Horizon Travels',
    domain: 'bluehorizontravels.co.in',
    plan: 'Professional',
    expiresInDays: -24, // lapsed → "Expired"
    renewals: 2,
    leads: 31,
    inventory: { hotels: 6, transport: 4, activities: 5 },
    staff: [
      ['Imran Shaikh', 'admin', 'Sales'],
      ['Preethi Suresh', 'manager', 'Sales'],
      ['Naveen Chandra', 'sales', 'Sales'],
      ['Lakshmi Devi', 'accounts', 'Accounts'],
    ],
  },
  {
    name: 'Lagoon Voyages',
    brand: 'Lagoon Voyages',
    domain: 'lagoonvoyages.com',
    plan: 'Starter',
    expiresInDays: 51,
    renewals: 1,
    leads: 9,
    suspended: true, // account switched off from the owner panel
    inventory: { hotels: 4, transport: 3, activities: 3 },
    staff: [
      ['Joseph Fernandes', 'admin', 'Sales'],
      ['Rekha Menon', 'sales', 'Sales'],
    ],
  },
];

// Pipeline shape. Mirrors a real agency: most leads never convert, and the
// ones that do mostly end up as past trips.
const STATUS_MIX = [
  ['new_query', 16],
  ['in_progress', 21],
  ['converted', 14],
  ['on_trip', 6],
  ['past', 25],
  ['canceled', 8],
  ['dropped', 10],
];

const WON = ['converted', 'on_trip', 'past'];

/* --------------------------------------------------- back-dating collected */
// Mongoose stamps createdAt at save time, and with timestamps enabled it
// treats createdAt as immutable — an ordinary update to it is dropped. So the
// back-dating runs through the raw driver collection, which has no schema and
// no timestamp machinery, in one bulkWrite per model at the end.
const backdates = new Map();
const backdate = (Model, id, at) => {
  if (!backdates.has(Model)) backdates.set(Model, []);
  backdates.get(Model).push({ updateOne: { filter: { _id: id }, update: { $set: { createdAt: at, updatedAt: at } } } });
};
async function flushBackdates() {
  let n = 0;
  for (const [Model, ops] of backdates) {
    for (let i = 0; i < ops.length; i += 500) {
      const res = await Model.collection.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      n += res.modifiedCount || 0;
    }
  }
  backdates.clear();
  return n;
}

/* ------------------------------------------------------------------- people */
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const emailOf = (person, domain) => `${person.split(' ')[0].toLowerCase()}@${domain}`;

const guest = () => {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  return {
    salutation: pick(SALUTATIONS),
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
    location: pick(ORIGIN_CITIES),
    nationality: 'Indian',
    phones: [{ countryCode: '91', number: `${pick('6789')}${int(100000000, 999999999)}`.slice(0, 10), isPrimary: true }],
  };
};

/* ------------------------------------------------------------- quote maker */
// Builds one realistic package: a stay split across islands, the transfers
// that connect them and a couple of tickets/activities.
function buildPackage({ hotels, transports, activities, nights, adults, children }) {
  const stays = [];
  let night = 1;
  const stayHotels = some(hotels, Math.min(hotels.length, nights <= 3 ? 1 : nights <= 5 ? 2 : 3));
  const perStay = Math.max(1, Math.floor(nights / stayHotels.length));
  stayHotels.forEach((h, idx) => {
    const n = idx === stayHotels.length - 1 ? nights - night + 1 : perStay;
    if (n <= 0) return;
    const nightList = Array.from({ length: n }, (_, k) => night + k);
    night += n;
    const rooms = Math.max(1, Math.ceil((adults + children.length) / 3));
    const rt = pick(h.roomTypes);
    const base = h.rate;
    stays.push({
      nights: nightList,
      hotel: h._id,
      hotelName: h.name,
      city: h.city,
      mealPlan: pick(['CP', 'MAP', 'AP']),
      roomType: rt,
      paxPerRoom: 2,
      rooms,
      aweb: adults > rooms * 2 ? adults - rooms * 2 : 0,
      cweb: children.length && chance(0.4) ? 1 : 0,
      cnb: children.length && chance(0.3) ? 1 : 0,
      ratePerNight: base,
      awebRate: r0(base * 0.28),
      cwebRate: r0(base * 0.24),
      cnbRate: r0(base * 0.16),
      cardRate: base,
    });
  });

  // One leg per day, in route order, spread across the length of the trip.
  const legs = someInOrder(transports, Math.min(transports.length, Math.max(2, Math.min(nights + 1, int(3, 5)))));
  const transportRows = legs.map((t, idx) => {
    const vehicle = adults + children.length > 6 ? '17 Seater Tempo Traveller' : pick(VEHICLES);
    const rate = vehicle.startsWith('17') ? int(5200, 7400) : vehicle.startsWith('SUV') ? int(3200, 4600) : int(1800, 2900);
    // First leg on arrival day, last leg on departure day, the rest between.
    const dayNo = legs.length > 1 ? 1 + Math.round((idx * nights) / (legs.length - 1)) : 1;
    return {
      day: dayNo,
      days: [dayNo],
      service: t._id,
      serviceLocation: t.to ? `${t.from} to ${t.to}` : t.from || t.name,
      serviceType: pick(t.items),
      startTime: pick(['07:30', '09:00', '10:15', '14:00']),
      durationMins: int(60, 240),
      items: [{ type: vehicle, qty: 1, rate }],
    };
  });

  const activityRows = some(activities, Math.min(activities.length, int(1, 3))).map((a, idx) => {
    const tt = pick(a.ticketTypes);
    const items = [{ type: 'Adult', qty: adults, rate: a.adult }];
    if (children.length) items.push({ type: 'Child (6-12)', qty: children.length, rate: a.child });
    return {
      days: [Math.min(idx + 2, nights + 1)],
      activity: a._id,
      name: a.name,
      ticketType: tt,
      slot: pick(['08:00', '11:00', '13:30', '15:00']),
      durationMins: int(45, 180),
      items,
    };
  });

  const extras = chance(0.35)
    ? [{ label: pick(['Candle Light Dinner', 'Honeymoon Cake & Room Decoration', 'Early Check-in', 'Photography Session']), price: int(1800, 6500) }]
    : [];

  return {
    name: 'Package',
    hotels: stays,
    inclusions: chance(0.3) ? [{ service: 'Welcome drink on arrival', price: int(300, 900) }] : [],
    transports: transportRows,
    activities: activityRows,
    extras,
    flights: chance(0.25) ? [{ label: `Return airfare ${pick(ORIGIN_CITIES)} → Malé`, cost: (adults + children.length) * int(18500, 32000) }] : [],
    markupType: 'percent',
    markupValue: pick([12, 15, 18, 20, 22]),
    discountType: 'flat',
    discountValue: chance(0.3) ? int(1000, 6000) : 0,
    taxName: 'GST',
    taxPercent: 5,
    taxApplied: true,
    taxOn: 'cost_markup',
    rounding: 10,
    customerRemarks: 'Rates valid for 7 days. Subject to availability at the time of confirmation.',
  };
}

/* ------------------------------------------------------------ org building */
async function buildInventory(spec, destIds) {
  const hotels = [];
  for (const h of HOTEL_CATALOG.slice(0, spec.inventory.hotels)) {
    const doc = await Hotel.create({
      name: h.name,
      groupName: h.group,
      location: { city: h.city, state: h.city, country: DESTINATION, label: `${h.city}, ${DESTINATION}` },
      stars: h.stars,
      mealPlans: ['CP', 'MAP', 'AP', 'Room only'],
      roomTypes: h.rooms.map((name) => ({ name, eb: 1, aweb: 1, cweb: 1, cnb: 1, rooms: int(8, 40) })),
      childEbAge: { from: 6, to: 12 },
      destinations: destIds,
      address: `${h.name}, ${h.city}, ${DESTINATION}`,
      email: `reservations@${slugOf(h.name).slice(0, 18)}.com`,
      phones: [{ countryCode: '91', number: `${int(7000000000, 9999999999)}` }],
      paymentPreference: pick(['25% on Booking Date, 75% 2 days before Checkin Date', '50% advance, 50% on arrival', 'Full payment on booking']),
      contacts: [{ name: `${pick(FIRST)} ${pick(LAST)}`, designation: 'Reservations Manager', phone: `${int(7000000000, 9999999999)}` }],
    });
    // Plain shape for the quote builder — keeps rate/room names at hand
    // without hanging extra properties off a Mongoose document.
    hotels.push({ _id: doc._id, name: h.name, city: h.city, roomTypes: h.rooms, rate: h.rate });

    for (const roomType of h.rooms) {
      for (const mealPlan of ['CP', 'MAP', 'AP']) {
        const bump = mealPlan === 'CP' ? 1 : mealPlan === 'MAP' ? 1.18 : 1.34;
        await HotelPrice.create({
          hotel: doc._id,
          roomType,
          mealPlan,
          startDate: daysAgo(120),
          endDate: daysOut(240),
          persons: 2,
          basePrice: r0(h.rate * bump),
          aweb: r0(h.rate * 0.28),
          cweb: r0(h.rate * 0.24),
          cwoeb: r0(h.rate * 0.16),
        });
      }
    }
  }

  const transports = [];
  for (const t of TRANSPORT_CATALOG.slice(0, spec.inventory.transport)) {
    const doc = await TransportService.create({
      name: t.name,
      from: t.from,
      to: t.to,
      destinations: destIds,
      pickupLocations: [t.from],
      dropLocations: [t.to],
      items: t.items.map((name, i) => ({
        name,
        startTime: pick(['07:30', '09:00', '10:30', '14:00']),
        durationMins: int(60, 240),
        distanceKms: int(5, 60),
        description: `${name} — operated with an air-conditioned vehicle and an English/Hindi speaking driver.`,
        order: i,
      })),
    });
    transports.push({ _id: doc._id, name: t.name, from: t.from, to: t.to, items: t.items });
  }

  const activities = [];
  for (const a of ACTIVITY_CATALOG.slice(0, spec.inventory.activities)) {
    const doc = await TravelActivity.create({
      name: a.name,
      kind: a.kind,
      destinations: destIds,
      ageConfig: 'Adult, Child (6-12)',
      complimentaryAge: 5,
      details: `${a.name} — confirmed subject to weather and operator availability.`,
      ticketTypes: a.tickets.map((name) => ({ name, slots: '08:00, 11:00, 14:00', duration: int(45, 180), durationUnit: 'mins' })),
    });
    activities.push({ _id: doc._id, name: a.name, ticketTypes: a.tickets, adult: a.adult, child: a.child });

    for (const service of a.tickets) {
      for (const [config, price] of [['Adult', a.adult], ['Child (6-12)', a.child]]) {
        await TravelActivityPrice.create({
          activity: doc._id,
          service,
          config,
          startDate: daysAgo(120),
          endDate: daysOut(240),
          price,
        });
      }
    }
  }

  return { hotels, transports, activities };
}

async function buildStaff(spec, orgId) {
  const teamNames = [...new Set(spec.staff.map(([, , team]) => team))];
  const teams = {};
  for (const name of teamNames) {
    teams[name] = await Team.create({ name, description: `${name} desk` });
  }

  const users = [];
  for (const [idx, [name, role, team]] of spec.staff.entries()) {
    const u = await User.create({
      name,
      email: emailOf(name, spec.domain),
      password: 'demo1234',
      phone: `${int(7000000000, 9999999999)}`,
      role,
      team: teams[team]._id,
      // A suspended company's staff haven't logged in lately; everyone else has.
      lastLoginAt: spec.suspended ? daysAgo(int(40, 90)) : daysAgo(int(0, 9)),
      isActive: !(idx === spec.staff.length - 1 && spec.staff.length > 4 && chance(0.6)),
    });
    backdate(User, u._id, daysAgo(int(200, 320)));
    users.push(u);
  }
  // Keep a lead on each team so the org chart isn't hollow.
  for (const name of teamNames) {
    const lead = users.find((u) => ['admin', 'manager'].includes(u.role)) || users[0];
    await Team.updateOne({ _id: teams[name]._id }, { lead: lead._id });
  }
  return { users, teams };
}

async function buildLedger(orgId, users) {
  const admin = users[0];
  const accounts = [
    { name: 'Cash in Hand', kind: 'company', openingBalance: int(20000, 60000) },
    { name: 'HDFC Current Account', kind: 'bank', openingBalance: int(250000, 900000) },
    { name: 'Razorpay Settlement', kind: 'gateway', openingBalance: 0 },
    { name: 'Hotel Suppliers', kind: 'third_party', openingBalance: 0 },
    { name: 'Ferry & Transport Suppliers', kind: 'third_party', openingBalance: 0 },
  ];
  for (const a of accounts) await Account.create({ ...a, createdBy: admin._id, tags: ['demo'] });
  for (const u of users.filter((x) => ['sales', 'manager'].includes(x.role))) {
    await Account.create({ name: `${u.name} — Salary`, kind: 'employee', user: u._id, createdBy: admin._id });
  }
}

/* ------------------------------------------------------------ trip pipeline */
async function buildPipeline(spec, { users, hotels, transports, activities, sources, tags, destIds }) {
  const sellers = users.filter((u) => ['sales', 'manager', 'admin'].includes(u.role));
  const admin = users.find((u) => u.role === 'admin') || users[0];
  const accountant = users.find((u) => u.role === 'accounts') || admin;
  const tally = { queries: 0, quotes: 0, bookings: 0, payments: 0, installments: 0, invoices: 0, booked: 0, collected: 0 };

  for (let i = 0; i < spec.leads; i += 1) {
    const status = weighted(STATUS_MIX);
    // How old a lead is depends on where it got to. Deals that closed recently
    // matter: the sales report scopes revenue and conversion % by the query's
    // createdAt, so with every won lead pushed into the distant past the
    // dashboard's "This month" view would read ₹0 / 0%.
    const ageDays = int(...({
      new_query: [0, 14],
      in_progress: [0, 30],
      converted: [1, 70],
      on_trip: [10, 80],
      past: [60, 300],
      canceled: [10, 180],
      dropped: [5, 200],
    }[status]));
    const createdAt = daysAgo(ageDays);
    const nights = int(2, 7);
    const adults = int(1, 6);
    const children = Array.from({ length: chance(0.4) ? int(1, 2) : 0 }, () => ({ age: int(2, 14) }));
    // A finished trip started before today, a confirmed one is still ahead, and
    // a trip in progress straddles today.
    const startDate = status === 'past' ? addDays(createdAt, int(12, 45))
      : status === 'on_trip' ? daysAgo(int(1, Math.max(1, nights - 1)))
      : status === 'converted' ? daysOut(int(3, 75))
      : ['new_query', 'in_progress'].includes(status) ? daysOut(int(10, 120))
      : addDays(createdAt, int(18, 90));
    const owner = pick(sellers);
    const g = guest();

    const q = await Query.create({
      source: pick(sources)._id,
      referenceId: `DEMO-${slugOf(spec.name).slice(0, 4).toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
      salesTeam: owner.team,
      tags: some(tags, int(0, 2)).map((t) => t._id),
      destinations: destIds,
      startDate,
      nights,
      pax: { adults, children },
      guest: g,
      comments: pick(LEAD_NOTES),
      status,
      owner: owner._id,
      createdBy: owner._id,
      reminderOn: status === 'in_progress' && chance(0.5) ? daysOut(int(1, 10)) : undefined,
      lostReason: ['canceled', 'dropped'].includes(status) ? pick(LOST_REASONS) : undefined,
      arrival: chance(0.5)
        ? { mode: 'Flight', reference: `${pick(['6E', 'AI', 'UK'])}-${int(100, 899)}`, date: startDate, time: pick(['08:40', '11:25', '13:10']) }
        : undefined,
      departure: chance(0.5)
        ? { mode: 'Flight', reference: `${pick(['6E', 'AI', 'UK'])}-${int(100, 899)}`, date: addDays(startDate, nights), time: pick(['14:20', '16:05', '18:45']) }
        : undefined,
    });
    backdate(Query, q._id, createdAt);
    tally.queries += 1;

    // A brand-new lead has no quote yet; everything else has at least one.
    if (status === 'new_query') continue;

    const won = WON.includes(status);
    const pkg = buildPackage({ hotels, transports, activities, nights, adults, children });
    const quotedAt = clampPast(addDays(createdAt, int(1, 4)));
    const quote = await Quote.create({
      query: q._id,
      title: `${nights}N/${nights + 1}D ${DESTINATION} — ${g.name}`,
      status: won ? 'accepted' : status === 'in_progress' ? pick(['draft', 'sent', 'sent']) : 'rejected',
      startDate,
      nights,
      pax: { adults, children },
      packages: [pkg],
      totalFoc: 0,
      selectedPackageIndex: 0,
      inclusions: ['Accommodation on the mentioned meal plan', 'All island transfers by speedboat as per itinerary', 'Seaplane transfer where mentioned', 'All applicable taxes'],
      exclusions: ['Airfare', 'Personal expenses, tips and laundry', 'Anything not mentioned in inclusions'],
      terms: 'Payment: 25% on confirmation, balance 2 days before arrival. Cancellation as per policy.',
      createdBy: owner._id,
    });
    backdate(Quote, quote._id, quotedAt);
    tally.quotes += 1;

    const total = quote.pricing?.total || 0;
    const cost = quote.pricing?.subtotal || 0;
    const profit = r0(total - cost - (quote.pricing?.tax || 0));

    await Query.updateOne(
      { _id: q._id },
      { quotedAmount: total, bookedAmount: won ? total : 0, profit: won ? profit : 0 },
      { timestamps: false }
    );

    if (!won && status !== 'canceled') continue;

    /* ---- booking ---- */
    const bookingStatus = status === 'past' ? 'completed' : status === 'on_trip' ? 'on_trip' : status === 'canceled' ? 'cancelled' : 'confirmed';
    const bookedAt = clampPast(addDays(quotedAt, int(1, 6)));
    // How much of the package has actually been collected by now.
    const paidRatio = bookingStatus === 'completed' ? 1
      : bookingStatus === 'on_trip' ? (chance(0.7) ? 1 : 0.75)
      : bookingStatus === 'cancelled' ? pick([0, 0.25, 0.25])
      : pick([0.25, 0.4, 0.5, 1]);
    const paidAmount = r0(total * paidRatio);

    const booking = await Booking.create({
      query: q._id,
      quote: quote._id,
      title: quote.title,
      guest: { salutation: g.salutation, name: g.name, email: g.email, location: g.location, phones: g.phones },
      destinations: destIds,
      startDate,
      nights,
      pax: { adults, children },
      status: bookingStatus,
      days: (quote.days || []).map((d) => ({ dayNumber: d.dayNumber, date: addDays(startDate, d.dayNumber - 1), title: d.title, description: d.description })),
      costItems: (quote.costItems || []).map((c) => ({ category: c.category, label: c.label, meta: c.meta, qty: c.qty, rate: c.rate, amount: c.amount })),
      totalAmount: total,
      paidAmount,
      owner: owner._id,
      createdBy: owner._id,
    });
    backdate(Booking, booking._id, bookedAt);
    tally.bookings += 1;
    tally.booked += total;
    tally.collected += paidAmount;

    /* ---- customer collections ---- */
    const slices = paidRatio >= 1 ? [0.25, 0.75] : paidRatio > 0 ? [paidRatio] : [];
    let collected = 0;
    const paidInstallments = [];
    for (const [k, frac] of slices.entries()) {
      const amount = k === slices.length - 1 && paidRatio >= 1 ? r0(total - collected) : r0(total * frac);
      collected += amount;
      const when = clampPast(addDays(bookedAt, k === 0 ? int(0, 2) : int(8, 30)));
      const mode = pick(PAYMENT_MODES);
      const payment = await Payment.create({
        party: 'customer',
        booking: booking._id,
        query: q._id,
        amount,
        mode,
        reference: `${mode === 'UPI' ? 'UPI' : 'TXN'}${int(100000, 999999)}`,
        date: when,
        notes: k === 0 ? 'Booking advance' : 'Balance payment',
        createdBy: accountant._id,
      });
      backdate(Payment, payment._id, when);
      tally.payments += 1;

      const inst = await Installment.create({
        direction: 'incoming',
        booking: booking._id,
        query: q._id,
        tripId: String(q.queryNumber),
        guest: { salutation: g.salutation, name: g.name, phones: g.phones },
        destinations: [DESTINATION],
        startDate,
        endDate: addDays(startDate, nights),
        amount,
        dueDate: when,
        paid: true,
        verified: true,
        verifiedBy: accountant._id,
        verifiedAt: when,
        paidAmount: amount,
        paidOn: when,
        reference: payment.reference,
        payment: payment._id,
        debitAccount: 'HDFC Current Account',
        creditAccount: `${g.name} — Trip ${q.queryNumber}`,
        createdBy: accountant._id,
      });
      backdate(Installment, inst._id, when);
      tally.installments += 1;
      paidInstallments.push({ inst, payment, amount, when });
    }

    // Whatever is still outstanding stays on the books as a due instalment —
    // some of them already past their due date, which is what the owner
    // panel's "overdue" count reads.
    const balance = r0(total - collected);
    if (balance > 0 && bookingStatus !== 'cancelled') {
      const overdue = chance(0.35);
      const due = overdue ? daysAgo(int(2, 25)) : daysOut(int(3, 40));
      const inst = await Installment.create({
        direction: 'incoming',
        booking: booking._id,
        query: q._id,
        tripId: String(q.queryNumber),
        guest: { salutation: g.salutation, name: g.name, phones: g.phones },
        destinations: [DESTINATION],
        startDate,
        endDate: addDays(startDate, nights),
        amount: balance,
        dueDate: due,
        paid: false,
        createdBy: accountant._id,
      });
      backdate(Installment, inst._id, addDays(bookedAt, 1));
      tally.installments += 1;
    }

    /* ---- supplier payouts ---- */
    if (bookingStatus !== 'cancelled') {
      const supplierHotel = pick(hotels);
      // A finished trip is usually settled, but not always — a final supplier
      // bill still open is normal, and it's what keeps "payable" realistic.
      const payoutRatio = bookingStatus === 'completed' ? (chance(0.75) ? 1 : 0.85)
        : bookingStatus === 'on_trip' ? 0.8
        : pick([0.3, 0.5]);
      const payout = r0(cost * payoutRatio);
      if (payout > 0) {
        const when = clampPast(addDays(bookedAt, int(2, 20)));
        const p = await Payment.create({
          party: 'supplier',
          booking: booking._id,
          query: q._id,
          supplier: { kind: 'hotel', refId: supplierHotel._id, name: supplierHotel.name },
          amount: payout,
          mode: pick(['Bank Transfer', 'UPI', 'Cheque']),
          reference: `SUP${int(100000, 999999)}`,
          date: when,
          notes: `Advance to ${supplierHotel.name}`,
          createdBy: accountant._id,
        });
        backdate(Payment, p._id, when);
        tally.payments += 1;
      }
      const owing = r0(cost - payout);
      if (owing > 0) {
        const inst = await Installment.create({
          direction: 'outgoing',
          booking: booking._id,
          query: q._id,
          tripId: String(q.queryNumber),
          supplierName: supplierHotel.name,
          destinations: [DESTINATION],
          startDate,
          endDate: addDays(startDate, nights),
          amount: owing,
          dueDate: chance(0.3) ? daysAgo(int(1, 15)) : daysOut(int(2, 30)),
          paid: false,
          debitAccount: 'Hotel Suppliers',
          creditAccount: 'HDFC Current Account',
          createdBy: accountant._id,
        });
        backdate(Installment, inst._id, addDays(bookedAt, 2));
        tally.installments += 1;
      }
    }

    /* ---- GST invoice against a collected payment ---- */
    if (paidInstallments.length && (bookingStatus === 'completed' || chance(0.4))) {
      const last = paidInstallments[paidInstallments.length - 1];
      const taxable = r0(last.amount / 1.05);
      const interState = g.location !== HOME_CITY;
      const invoice = await GstInvoice.create({
        query: q._id,
        booking: booking._id,
        installment: last.inst._id,
        invoiceDate: last.when,
        seller: {
          name: spec.brand,
          address: `${spec.brand}, 121 Anna Salai, ${HOME_CITY} 600006, ${HOME_STATE}`,
          phone: '+91 44 4567 8900',
          email: `accounts@${spec.domain}`,
          gstin: `${GST_STATE_CODE}AABC${int(1000, 9999)}A1Z${int(0, 9)}`,
          pan: `AABC${int(1000, 9999)}A`,
        },
        buyer: { name: g.name, address: g.location, email: g.email },
        placeOfSupply: interState ? g.location : HOME_STATE,
        paymentDate: last.when,
        paymentMode: last.payment.mode,
        particulars: `Tour package — ${nights}N/${nights + 1}D ${DESTINATION} (Trip ${q.queryNumber})`,
        hsn: '998555',
        taxableValue: taxable,
        gstPercent: 5,
        taxType: interState ? 'inter' : 'intra',
        amountReceived: last.amount,
        terms: 'This is a computer-generated invoice. Payment already received.',
        createdBy: accountant._id,
      });
      backdate(GstInvoice, invoice._id, last.when);
      tally.invoices += 1;
    }
  }

  return tally;
}

/* ------------------------------------------------------------------ company */
async function seedCompany(spec, plan, ownerUser) {
  const existing = await Organization.findOne({ name: spec.name });
  if (existing) {
    console.log(`[demo] ${spec.name} already exists — skipped.`);
    return null;
  }

  const expiresAt = daysOut(spec.expiresInDays);
  const org = await Organization.create({
    name: spec.name,
    isActive: !spec.suspended,
    createdBy: ownerUser._id,
    subscription: { plan: plan._id, planName: plan.name, expiresAt, modules: plan.modules },
  });

  // The subscription history is counted back from the expiry date, one term per
  // renewal, so the onboarding payment lands where the client actually signed
  // up — and "Client since" is dated just before it rather than independently,
  // which would otherwise read as a payment taken before the company existed.
  const firstPaidOn = new Date(expiresAt);
  firstPaidOn.setMonth(firstPaidOn.getMonth() - spec.renewals * plan.durationMonths);
  backdate(Organization, org._id, addDays(firstPaidOn, -int(2, 9)));

  await OrgProfile.getFor(org._id);
  await OrgProfile.updateOne(
    { organization: org._id },
    {
      officialName: `${spec.brand} Pvt Ltd`,
      brandName: spec.brand,
      website: `https://www.${spec.domain}`,
      emails: [`info@${spec.domain}`, `accounts@${spec.domain}`],
      supportPhones: ['+91 44 4567 8900', `+91 ${int(70000, 99999)} ${int(10000, 99999)}`],
      brandPrefixCode: slugOf(spec.brand).split('-').map((w) => w[0]).join('').toUpperCase(),
      contactAddresses: [{ label: 'Head Office', address: `${spec.brand}\n2nd Floor, Gemini Towers, 121 Anna Salai\n${HOME_CITY} 600006, ${HOME_STATE}`, phone: '+91 44 4567 8900', email: `info@${spec.domain}`, primary: true }],
      billingAddresses: [{ label: 'Billing', address: `${spec.brand} Pvt Ltd\n121 Anna Salai, ${HOME_CITY} 600006`, gstin: `${GST_STATE_CODE}AABC${int(1000, 9999)}A1Z${int(0, 9)}`, primary: true }],
      bankAccounts: [{ holder: `${spec.brand} Pvt Ltd`, bank: 'HDFC Bank', branch: HOME_CITY, ifsc: `HDFC000${int(1000, 9999)}`, accNo: `${int(10000000000, 99999999999)}`, currency: 'INR' }],
    }
  );

  await seedMasterData(org._id);

  const tally = await runWithTenant(org._id, async () => {
    const destinations = await Destination.find();
    const destIds = destinations.filter((d) => d.name === DESTINATION).map((d) => d._id);
    const sources = await QuerySource.find();
    const tags = await Tag.find({ name: { $in: TRIP_TAGS } });

    const { users } = await buildStaff(spec, org._id);
    const { hotels, transports, activities } = await buildInventory(spec, destIds);
    await buildLedger(org._id, users);
    return buildPipeline(spec, { users, hotels, transports, activities, sources, tags, destIds });
  });

  // Subscription history — the renewals that got the company to `expiresAt`.
  const paidOn = new Date(firstPaidOn);
  for (let r = 0; r < spec.renewals; r += 1) {
    await SubscriptionPayment.create({
      organization: org._id,
      plan: plan._id,
      planName: plan.name,
      amount: plan.price,
      months: plan.durationMonths,
      modules: plan.modules,
      paidOn: new Date(paidOn),
      notes: r === 0 ? 'Initial onboarding payment' : `Renewal #${r} — received by bank transfer`,
      recordedBy: ownerUser._id,
    });
    paidOn.setMonth(paidOn.getMonth() + plan.durationMonths);
  }

  console.log(
    `[demo] ${spec.name.padEnd(22)} ${plan.name.padEnd(13)} ` +
      `${String(tally.queries).padStart(3)} leads · ${String(tally.quotes).padStart(3)} quotes · ` +
      `${String(tally.bookings).padStart(3)} bookings · ${inr(tally.booked).padStart(13)} booked · ${inr(tally.collected).padStart(13)} collected`
  );
  return { org, tally };
}

/* --------------------------------------------------------- reset / re-seed */
// OrgProfile is listed separately below: it carries `organization` itself and
// is not covered by tenantPlugin, so it can't be cleared by tenant context.
const TENANT_MODELS = [Query, Quote, Booking, Payment, Installment, GstInvoice, Account, Hotel, HotelPrice,
  TransportService, TravelActivity, TravelActivityPrice, Destination, QuerySource, Tag, Option, Team];

async function reset() {
  console.log('[demo] --reset: clearing tenant data, companies, plans and staff users…');
  for (const Model of [...TENANT_MODELS, OrgProfile]) await Model.deleteMany({});
  await User.deleteMany({ role: { $ne: 'owner' } });
  await SubscriptionPayment.deleteMany({});
  await Organization.deleteMany({});
  await Plan.deleteMany({});
  await Counter.deleteMany({});
}

// Removes exactly one company so it can be seeded again. The tenant-owned
// collections are cleared inside that company's tenant context, so
// tenantPlugin scopes every delete to it — no other client can be touched.
async function dropCompany(match) {
  const org = await Organization.findOne({ name: new RegExp(match, 'i') });
  if (!org) {
    console.log(`[demo] --drop=${match}: no company matched, nothing removed.`);
    return;
  }
  await runWithTenant(org._id, async () => {
    for (const Model of TENANT_MODELS) await Model.deleteMany({});
    await User.deleteMany({});
  });
  await OrgProfile.deleteMany({ organization: org._id });
  await SubscriptionPayment.deleteMany({ organization: org._id });
  await Counter.deleteMany({ _id: new RegExp(`^${org._id}:`) });
  await Organization.deleteOne({ _id: org._id });
  console.log(`[demo] --drop: removed ${org.name} and its data.`);
}

/* ---------------------------------------------------------------------- run */
async function run() {
  await connectDB();
  const argOf = (flag) => process.argv.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  if (process.argv.includes('--reset')) await reset();
  // --drop takes one name or a comma-separated list, so re-theming the whole
  // demo doesn't need the all-or-nothing --reset.
  for (const name of (argOf('--drop') || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    await dropCompany(name);
  }

  // The platform owner — the login for the super-admin panel.
  const ownerEmail = (env.owner.email || 'owner@travelcrm.test').toLowerCase();
  let ownerUser = await User.findOne({ email: ownerEmail });
  if (!ownerUser) {
    ownerUser = await User.create({
      name: env.owner.name || 'Platform Owner',
      email: ownerEmail,
      password: env.owner.password || 'owner123',
      role: 'owner',
    });
    console.log(`[demo] Platform owner created: ${ownerEmail}`);
  } else {
    console.log(`[demo] Platform owner already present: ${ownerEmail}`);
  }

  const plans = {};
  for (const p of PLANS) {
    plans[p.name] = await Plan.findOneAndUpdate({ name: p.name }, p, { upsert: true, new: true, setDefaultsOnInsert: true });
  }
  console.log(`[demo] Plans ready: ${PLANS.map((p) => `${p.name} (${inr(p.price)}/${p.durationMonths}mo)`).join(', ')}`);

  // --only=<substring> seeds a single company and --leads=<n> caps the
  // pipeline size, which is what makes a quick smoke run practical.
  const only = argOf('--only')?.toLowerCase();
  const leadCap = Number(argOf('--leads')) || 0;

  const done = [];
  for (const spec of COMPANIES) {
    if (only && !spec.name.toLowerCase().includes(only)) continue;
    const scoped = leadCap ? { ...spec, leads: Math.min(spec.leads, leadCap) } : spec;
    const result = await seedCompany(scoped, plans[spec.plan], ownerUser);
    if (result) done.push(result);
  }

  const backdated = await flushBackdates();
  if (backdated) console.log(`[demo] Back-dated ${backdated} documents so the history isn't all stamped today.`);

  if (done.length) {
    const sum = (f) => done.reduce((a, d) => a + f(d.tally), 0);
    console.log('\n[demo] ---------------------------------------------------------------');
    console.log(`[demo] ${done.length} companies · ${sum((t) => t.queries)} leads · ${sum((t) => t.quotes)} quotes · ` +
      `${sum((t) => t.bookings)} bookings · ${sum((t) => t.payments)} payments · ` +
      `${sum((t) => t.installments)} instalments · ${sum((t) => t.invoices)} GST invoices`);
    console.log(`[demo] Booked value ${inr(sum((t) => t.booked))} · collected ${inr(sum((t) => t.collected))}`);
    console.log('[demo] Staff logins: see the emails above, password "demo1234" for every demo user.');
    console.log('[demo] ---------------------------------------------------------------');
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('[demo] Failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
