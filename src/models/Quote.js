import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { shareTokenField } from '../utils/shareToken.js';

const round = (n, to = 1) => {
  const r = Math.round(n / to) * to;
  return Math.round(r * 100) / 100;
};

/* ---------- Package sub-schemas ---------- */

// A hotel stay row: which nights, room/meal config, occupancy, and rates.
const hotelRowSchema = new mongoose.Schema(
  {
    nights: [{ type: Number }], // night numbers this stay covers, e.g. [1,2]
    hotel: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel' },
    hotelName: { type: String, trim: true },
    city: { type: String, trim: true },
    mealPlan: { type: String, trim: true },
    roomType: { type: String, trim: true },
    paxPerRoom: { type: Number, default: 2 }, // without extra bed (WoEB)
    rooms: { type: Number, default: 1 },
    aweb: { type: Number, default: 0 }, // adult w/ extra bed count
    cweb: { type: Number, default: 0 }, // child w/ extra bed count
    cnb: { type: Number, default: 0 }, // child no bed count
    ratePerNight: { type: Number, default: 0 }, // base room cost/night
    awebRate: { type: Number, default: 0 },
    cwebRate: { type: Number, default: 0 },
    cnbRate: { type: Number, default: 0 },
    givenPerNight: { type: Number, default: 0 }, // selling override (0 = use cost)
    cardRate: { type: Number, default: 0 }, // supplier card rate shown as "cost" in the builder
    amount: { type: Number, default: 0 }, // computed cost
    // Alternative hotel option for the same night(s) — "Hotel A OR Hotel B".
    // Not counted in package totals; the primary (non-alternative) row is.
    isAlternative: { type: Boolean, default: false },
  },
  { _id: true }
);

const inclusionSchema = new mongoose.Schema(
  {
    service: { type: String, trim: true },
    hotelName: { type: String, trim: true },
    night: { type: Number },
    price: { type: Number, default: 0 },
    comments: { type: String, trim: true },
  },
  { _id: true }
);

const transportItemSchema = new mongoose.Schema(
  {
    type: { type: String, trim: true }, // e.g. "17 Seater Tempo Traveller"
    qty: { type: Number, default: 1 },
    rate: { type: Number, default: 0 },
    given: { type: Number, default: 0 }, // selling override (0 = use cost)
    amount: { type: Number, default: 0 },
  },
  { _id: false }
);

const transportDaySchema = new mongoose.Schema(
  {
    day: { type: Number, default: 1 },
    days: [{ type: Number }], // all day numbers this service covers, e.g. [1,2]
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'TransportService' }, // master link for rate lookup
    serviceLocation: { type: String, trim: true }, // "Port Blair to Havelock"
    serviceType: { type: String, trim: true }, // "Transfer and Radhanagar Beach"
    startTime: { type: String, trim: true },
    durationMins: { type: Number },
    items: [transportItemSchema],
  },
  { _id: true }
);

// Activity/Ticket rows inside "Transports & Activities" (Sembark parity).
const activityRowSchema = new mongoose.Schema(
  {
    days: [{ type: Number }],
    activity: { type: mongoose.Schema.Types.ObjectId, ref: 'TravelActivity' }, // master link for rate lookup
    name: { type: String, trim: true }, // "Port Blair To Havelock"
    ticketType: { type: String, trim: true }, // "Scuba Diving" — the activity's ticket/package type
    slot: { type: String, trim: true }, // "14:00"
    durationMins: { type: Number },
    // Service type this ticket belongs to (added via the 🎟 button on a
    // transport service) — keeps the ticket rendered under its service in
    // both the builder and the PDF itinerary.
    forService: { type: String, trim: true },
    items: [transportItemSchema], // { type: 'Adult' | 'Child (6-12)', qty, rate, given }
  },
  { _id: true }
);

const extraSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    price: { type: Number, default: 0 },
    date: { type: Date },
    comments: { type: String, trim: true },
  },
  { _id: true }
);

const flightSchema = new mongoose.Schema(
  { label: { type: String, trim: true }, cost: { type: Number, default: 0 }, given: { type: Number, default: 0 } },
  { _id: true }
);

const packageSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: 'Package' },
    hotels: [hotelRowSchema],
    inclusions: [inclusionSchema],
    transports: [transportDaySchema],
    activities: [activityRowSchema],
    extras: [extraSchema],
    flights: [flightSchema],

    // Shared cab config ("Same Cab Type for All" in the builder)
    sameCabType: { type: Boolean, default: false },
    sharedCabItems: [{ type: { type: String, trim: true }, qty: { type: Number, default: 1 }, _id: false }],

    markupType: { type: String, enum: ['percent', 'flat'], default: 'percent' },
    markupValue: { type: Number, default: 0 },
    // Discount applied on Cost + Markup, before tax.
    discountType: { type: String, enum: ['percent', 'flat'], default: 'flat' },
    discountValue: { type: Number, default: 0 },
    taxName: { type: String, default: 'GST' },
    taxPercent: { type: Number, default: 5 },
    taxApplied: { type: Boolean, default: true },
    taxOn: { type: String, enum: ['cost_markup', 'markup'], default: 'cost_markup' },
    rounding: { type: Number, default: 1 },

    internalComments: { type: String, trim: true },
    customerRemarks: { type: String, trim: true },

    // computed
    costPrice: { type: Number, default: 0 },
    markupAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
  },
  { _id: true }
);

/* ---------- Legacy flat sub-schemas (kept for booking/invoice/report compat) ---------- */
const itineraryDaySchema = new mongoose.Schema(
  { dayNumber: Number, date: Date, destination: { type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }, title: String, description: String, sightseeing: String },
  { _id: true }
);
const costItemSchema = new mongoose.Schema(
  { category: String, refId: mongoose.Schema.Types.ObjectId, label: String, meta: String, qty: Number, rate: Number, amount: Number },
  { _id: true }
);

const quoteSchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required: true, index: true },
    quoteNumber: { type: Number, index: true }, // unique per-org (compound index below)
    title: { type: String, trim: true },
    status: { type: String, enum: ['draft', 'sent', 'accepted', 'rejected'], default: 'draft', index: true },
    currency: { type: String, default: 'INR' },
    startDate: { type: Date },
    nights: { type: Number, default: 0 },
    pax: { adults: { type: Number, default: 1 }, children: [{ age: Number }] },

    // Rich multi-option structure (Sembark-style)
    packages: [packageSchema],
    pricingStrategy: { type: String, enum: ['overall', 'per-service'], default: 'overall' },
    totalFoc: { type: Number, default: 0 },
    selectedPackageIndex: { type: Number, default: 0 },

    // Flattened mirror of the selected package (legacy consumers)
    days: [itineraryDaySchema],
    costItems: [costItemSchema],
    markupType: { type: String, enum: ['percent', 'flat'], default: 'percent' },
    markupValue: { type: Number, default: 0 },
    taxPercent: { type: Number, default: 0 },
    pricing: {
      subtotal: { type: Number, default: 0 },
      markup: { type: Number, default: 0 },
      discount: { type: Number, default: 0 },
      tax: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    inclusions: [{ type: String }],
    exclusions: [{ type: String }],
    terms: { type: String, trim: true },
    // Set when the day-wise schedule was hand-edited on the itinerary page —
    // stops the pre-validate hook from rebuilding days from the packages.
    daysCustomized: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ...shareTokenField,
  },
  { timestamps: true }
);

// Per-night = room price * rooms + extra-bed prices * their counts; * #nights.
function hotelRowCost(h) {
  const perNight =
    (h.ratePerNight || 0) * (h.rooms || 0) +
    (h.awebRate || 0) * (h.aweb || 0) +
    (h.cwebRate || 0) * (h.cweb || 0) +
    (h.cnbRate || 0) * (h.cnb || 0);
  const nights = Math.max(1, (h.nights || []).length || 1);
  return round(perNight * nights);
}

function computePackage(pkg) {
  let cost = 0;
  // Alternatives ("Hotel A OR Hotel B" on the same nights) bill at the
  // HIGHEST rate in their night group, so the quote covers whichever
  // option the guest picks.
  const hotelRows = pkg.hotels || [];
  const nightsOverlap = (a, b) => (a.nights || []).some((n) => (b.nights || []).includes(n));
  for (const h of hotelRows) h.amount = hotelRowCost(h);
  for (const h of hotelRows) {
    if (h.isAlternative) {
      // Orphan alternative (its primary row was removed) still bills itself.
      if (!hotelRows.some((p) => !p.isAlternative && nightsOverlap(p, h))) cost += h.amount;
    } else {
      const altCosts = hotelRows.filter((x) => x.isAlternative && nightsOverlap(h, x)).map((x) => x.amount);
      cost += Math.max(h.amount, ...altCosts);
    }
  }
  for (const inc of pkg.inclusions || []) cost += inc.price || 0;
  for (const t of pkg.transports || []) {
    // A service selected on N days is charged for each of those days.
    const daysCount = Math.max(1, (Array.isArray(t.days) && t.days.length ? t.days : [t.day || 1]).length);
    for (const it of t.items || []) {
      it.amount = round((it.qty || 0) * (it.rate || 0) * daysCount);
      cost += it.amount;
    }
  }
  for (const a of pkg.activities || []) {
    const daysCount = Math.max(1, (Array.isArray(a.days) && a.days.length ? a.days : [1]).length);
    for (const it of a.items || []) {
      it.amount = round((it.qty || 0) * (it.rate || 0) * daysCount);
      cost += it.amount;
    }
  }
  for (const e of pkg.extras || []) cost += e.price || 0;
  for (const f of pkg.flights || []) cost += f.cost || 0;

  const markup = pkg.markupType === 'flat' ? pkg.markupValue || 0 : round((cost * (pkg.markupValue || 0)) / 100);
  // Discount comes off Cost + Markup before tax (capped so totals never go negative).
  const preDiscount = cost + markup;
  let discount = pkg.discountType === 'percent'
    ? round((preDiscount * (pkg.discountValue || 0)) / 100)
    : (pkg.discountValue || 0);
  discount = Math.min(round(discount), preDiscount);
  const taxBase = pkg.taxOn === 'markup' ? markup : preDiscount - discount;
  const tax = pkg.taxApplied ? round((taxBase * (pkg.taxPercent || 0)) / 100) : 0;
  pkg.costPrice = round(cost);
  pkg.markupAmount = markup;
  pkg.discountAmount = discount;
  pkg.taxAmount = tax;
  pkg.sellingPrice = round(cost + markup - discount + tax, pkg.rounding || 1);
}

// Flatten the selected package into legacy costItems/days/pricing.
// Day-wise text auto-written from a package's services:
// dayNo -> { title, lines[] }. Used to build the itinerary, and to tell
// auto-written lines apart from hand-typed ones in a customised itinerary.
export function autoDayPlan(pkg) {
  const byDay = new Map();
  const push = (dayNo, title, line) => {
    if (!byDay.has(dayNo)) byDay.set(dayNo, { title: '', lines: [] });
    const d = byDay.get(dayNo);
    if (!d.title && title) d.title = title;
    if (line) d.lines.push(line);
  };
  for (const t of pkg?.transports || []) {
    const days = (Array.isArray(t.days) && t.days.length ? t.days : [t.day || 1]);
    for (const dayNo of days) push(dayNo, t.serviceLocation, [t.serviceType, t.startTime].filter(Boolean).join(' · ') || t.serviceLocation);
  }
  for (const a of pkg?.activities || []) {
    const days = (Array.isArray(a.days) && a.days.length ? a.days : [1]);
    for (const dayNo of days) push(dayNo, a.name, [[a.name, a.ticketType].filter(Boolean).join(' — '), a.slot].filter(Boolean).join(' · '));
  }
  return byDay;
}

const lineKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A hand-customised itinerary keeps its saved day text when services change,
 * so lines that were auto-written from a service the package no longer has
 * would linger (e.g. "Experience the World-Famous Radhanagar Beach" after
 * Day 1 moved to Corbyn's Cove). Remove exactly those: lines that came from
 * the previous services and are not produced by the new ones. Hand-typed
 * lines and titles are left alone. Mutates and returns `days`.
 */
export function pruneStaleAutoLines(days, prevPkg, nextPkg) {
  const prev = autoDayPlan(prevPkg);
  const next = autoDayPlan(nextPkg);
  for (const d of days || []) {
    const was = prev.get(d.dayNumber);
    if (!was) continue;
    const stale = new Set(was.lines.map(lineKey));
    for (const l of next.get(d.dayNumber)?.lines || []) stale.delete(lineKey(l));
    if (!stale.size) continue;
    const kept = String(d.description || '').split('\n').filter((l) => !stale.has(lineKey(l)));
    d.description = kept.join('\n');
    // A title that was just the old service's location/name goes too.
    const nextTitle = next.get(d.dayNumber)?.title || '';
    if (d.title && lineKey(d.title) === lineKey(was.title) && lineKey(d.title) !== lineKey(nextTitle)) d.title = nextTitle;
  }
  return days;
}

function flattenSelected(doc) {
  const pkg = (doc.packages || [])[doc.selectedPackageIndex || 0];
  if (!pkg) return;
  const items = [];
  for (const h of pkg.hotels || []) {
    if (h.isAlternative) continue; // legacy costItems mirror bills only primary hotels
    items.push({
      category: 'hotel', refId: h.hotel,
      label: `${h.hotelName || 'Hotel'}${h.roomType ? ` — ${h.roomType}` : ''}${h.mealPlan ? ` (${h.mealPlan})` : ''}`,
      meta: `${(h.nights || []).length || 1} night(s) × ${h.rooms || 1} room(s)`,
      qty: (h.rooms || 1) * Math.max(1, (h.nights || []).length || 1),
      rate: h.ratePerNight || 0, amount: h.amount || 0,
    });
  }
  for (const inc of pkg.inclusions || []) items.push({ category: 'other', label: inc.service || 'Inclusion', meta: inc.hotelName, qty: 1, rate: inc.price || 0, amount: inc.price || 0 });
  for (const t of pkg.transports || []) {
    const daysCount = Math.max(1, (Array.isArray(t.days) && t.days.length ? t.days : [t.day || 1]).length);
    for (const it of t.items || []) items.push({ category: 'transport', label: `${t.serviceLocation || ''} — ${it.type || 'Transport'}`.trim(), meta: [t.serviceType, daysCount > 1 ? `${daysCount} day(s)` : ''].filter(Boolean).join(' · '), qty: (it.qty || 1) * daysCount, rate: it.rate || 0, amount: it.amount || 0 });
  }
  for (const a of pkg.activities || []) {
    const daysCount = Math.max(1, (Array.isArray(a.days) && a.days.length ? a.days : [1]).length);
    for (const it of a.items || []) items.push({ category: 'activity', refId: a.activity, label: `${a.name || 'Activity'}${a.ticketType ? ` — ${a.ticketType}` : ''} (${it.type || 'Ticket'})`, meta: [a.slot, daysCount > 1 ? `${daysCount} day(s)` : ''].filter(Boolean).join(' · '), qty: (it.qty || 1) * daysCount, rate: it.rate || 0, amount: it.amount || 0 });
  }
  for (const e of pkg.extras || []) items.push({ category: 'other', label: e.label || 'Service', qty: 1, rate: e.price || 0, amount: e.price || 0 });
  for (const f of pkg.flights || []) items.push({ category: 'other', label: f.label || 'Flight', qty: 1, rate: f.cost || 0, amount: f.cost || 0 });
  doc.costItems = items;

  // Build the day-wise itinerary from transports + activities, covering EVERY
  // day of the trip — unless the schedule was hand-edited (daysCustomized).
  if (!doc.daysCustomized) {
    const byDay = autoDayPlan(pkg);
    if (byDay.size) {
      const totalDays = Math.max((doc.nights || 0) + 1, ...byDay.keys());
      doc.days = Array.from({ length: totalDays }, (_, i) => {
        const dayNo = i + 1;
        const d = byDay.get(dayNo);
        return {
          dayNumber: dayNo,
          title: d?.title || `Day ${dayNo}`,
          description: (d?.lines || []).join('\n'),
        };
      });
    }
  }

  doc.markupType = pkg.markupType;
  doc.markupValue = pkg.markupValue;
  doc.taxPercent = pkg.taxApplied ? pkg.taxPercent : 0;
  doc.pricing = { subtotal: pkg.costPrice, markup: pkg.markupAmount, discount: pkg.discountAmount || 0, tax: pkg.taxAmount, total: pkg.sellingPrice };
}

quoteSchema.pre('validate', function compute(next) {
  if (this.packages?.length) {
    // `days[]` is the real schedule; keep the legacy single `day` in step so
    // nothing that still reads it shows a service on a day it was moved off.
    for (const pkg of this.packages) {
      for (const t of pkg.transports || []) {
        if (Array.isArray(t.days) && t.days.length && t.day !== t.days[0]) t.day = t.days[0];
      }
    }
    for (const pkg of this.packages) computePackage(pkg);
    if ((this.selectedPackageIndex || 0) >= this.packages.length) this.selectedPackageIndex = 0;
    flattenSelected(this);
    // Growing "nights" elsewhere (e.g. Edit Basic Details) doesn't rewrite a
    // hand-customized itinerary (flattenSelected skips it — see
    // daysCustomized above) — top up with blank day entries so newly added
    // nights still show up in the itinerary/PDF instead of silently
    // vanishing. Never trims: shrinking nights doesn't delete authored days.
    const wantDays = (this.nights || 0) + 1;
    if ((this.days || []).length < wantDays) {
      const existing = new Set((this.days || []).map((d) => d.dayNumber));
      for (let i = 1; i <= wantDays; i++) {
        if (!existing.has(i)) this.days.push({ dayNumber: i, title: '', description: '' });
      }
      this.days.sort((a, b) => a.dayNumber - b.dayNumber);
    }
  } else {
    // Legacy path: compute from flat costItems.
    let subtotal = 0;
    for (const it of this.costItems || []) {
      it.amount = round((it.qty || 0) * (it.rate || 0));
      subtotal += it.amount;
    }
    const markup = this.markupType === 'flat' ? this.markupValue || 0 : round((subtotal * (this.markupValue || 0)) / 100);
    const taxable = subtotal + markup;
    const tax = round((taxable * (this.taxPercent || 0)) / 100);
    this.pricing = { subtotal, markup, tax, total: taxable + tax };
  }
  next();
});

// Tenant scoping — registered BEFORE assignNumber so this.organization is
// stamped when the counter key is built.
quoteSchema.plugin(tenantPlugin);
quoteSchema.index({ organization: 1, quoteNumber: 1 }, { unique: true });

quoteSchema.pre('save', async function assignNumber(next) {
  if (this.isNew && !this.quoteNumber) this.quoteNumber = await Counter.nextFor(this.organization, 'quote', 5100000);
  next();
});

quoteSchema.set('toJSON', { virtuals: true });

export const Quote = mongoose.model('Quote', quoteSchema);
