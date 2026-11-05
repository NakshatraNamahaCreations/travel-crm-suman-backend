import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { QUERY_STATUS_VALUES } from '../constants/queryStatus.js';
import { LEAD_CHANNEL_KEYS } from '../config/leadChannels.js';
import { leadTouchSchema } from './leadTouchSchema.js';

const childSchema = new mongoose.Schema({ age: { type: Number, min: 0, max: 17 } }, { _id: false });

const phoneSchema = new mongoose.Schema(
  {
    countryCode: { type: String, default: '91' },
    number: { type: String, required: true, trim: true },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false }
);

const guestSchema = new mongoose.Schema(
  {
    salutation: { type: String, trim: true },
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    location: { type: String, trim: true }, // origin city/state
    nationality: { type: String, trim: true },
    phones: [phoneSchema],
  },
  { _id: false }
);

// Where the lead actually came from, as recorded by the website tracking script.
//
// Sits ALONGSIDE `source` rather than replacing it. `source` is the editable list an agent
// picks from by hand and every existing report breaks down by; this block is what the
// machinery captured, at a granularity (campaign, ad, keyword) that would turn QuerySource
// into hundreds of junk rows if it were stored there. The ingest sets both: `channel` is
// mapped onto a QuerySource name so the existing sales report keeps working untouched.
const attributionSchema = new mongoose.Schema(
  {
    // The credited channel, chosen per the tenant's touchMode setting (first or last visit).
    channel: { type: String, enum: LEAD_CHANNEL_KEYS },
    // Both ends kept regardless of which one is credited, so the Lead Sources page can switch
    // between "what created the interest" and "what closed the enquiry" without re-ingesting.
    firstChannel: { type: String, enum: LEAD_CHANNEL_KEYS },
    lastChannel: { type: String, enum: LEAD_CHANNEL_KEYS },
    first: { type: leadTouchSchema, default: undefined },
    last: { type: leadTouchSchema, default: undefined },
    // The full journey, copied off the visitor record at enquiry time.
    touches: { type: [leadTouchSchema], default: undefined },

    visitorId: { type: String, trim: true, index: true },
    visitCount: { type: Number },
    firstSeenAt: { type: Date },
    device: { type: String, trim: true },
    visitorCity: { type: String, trim: true },
    conversionPage: { type: String, trim: true },
    formName: { type: String, trim: true },
    gaClientId: { type: String, trim: true },
    trackingLink: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingLink' },

    // False when nothing identified the visit. Drives the "untracked" badge and the tracking
    // health figure — a blank source and a genuinely direct visit are different problems, and
    // conflating them hides a broken form behind a plausible-looking channel.
    tracked: { type: Boolean, default: false },
    // The submitted payload, verbatim. Parameters the tenant has not mapped are still here, so
    // switching one on later does not mean the data was lost in the meantime.
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const querySchema = new mongoose.Schema(
  {
    queryNumber: { type: Number, index: true }, // unique per-org (compound index below)

    // Source block
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'QuerySource' },
    referenceId: { type: String, trim: true },
    salesTeam: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],
    attribution: { type: attributionSchema, default: undefined },

    // Destination & duration
    destinations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],
    startDate: { type: Date },
    nights: { type: Number, default: 1, min: 0 },
    pax: {
      adults: { type: Number, default: 1, min: 1 },
      children: [childSchema],
    },
    foc: { type: Number, default: 0, min: 0 }, // free-of-cost pax

    // Guest
    guest: { type: guestSchema, default: () => ({}) },

    comments: { type: String, trim: true },

    // Pipeline
    status: { type: String, enum: QUERY_STATUS_VALUES, default: 'new_query', index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // assigned salesperson
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Financials (populated as the query progresses through quote/booking)
    quotedAmount: { type: Number, default: 0 },
    bookedAmount: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },

    lostReason: { type: String, trim: true },
    reminderOn: { type: Date }, // contact reminder for postponed / rescheduled leads

    // Arrival / departure logistics (flight/train details for the trip).
    arrival: { mode: String, reference: String, date: Date, time: String, notes: String },
    departure: { mode: String, reference: String, date: Date, time: String, notes: String },
  },
  { timestamps: true }
);

// Derived: total nights/days label, total pax
querySchema.virtual('days').get(function () {
  return (this.nights || 0) + 1;
});
querySchema.virtual('totalPax').get(function () {
  return (this.pax?.adults || 0) + (this.pax?.children?.length || 0);
});

// Tenant scoping — registered BEFORE assignNumber so this.organization is
// stamped when the counter key is built.
querySchema.plugin(tenantPlugin);
querySchema.index({ organization: 1, queryNumber: 1 }, { unique: true });

// Assign a human-friendly sequential query number on first save (starts at 1 → shown as 0001).
querySchema.pre('save', async function assignNumber(next) {
  if (this.isNew && !this.queryNumber) {
    this.queryNumber = await Counter.nextFor(this.organization, 'query', 1);
  }
  next();
});

querySchema.set('toJSON', { virtuals: true });
querySchema.set('toObject', { virtuals: true });

// Helpful compound index for the pipeline list (status + recency).
querySchema.index({ status: 1, createdAt: -1 });
// Every panel of the Lead Sources page filters by organization and a created-at range, then
// groups by channel — without this the channel cards scan the whole trips collection.
querySchema.index({ organization: 1, 'attribution.channel': 1, createdAt: -1 });

export const Query = mongoose.model('Query', querySchema);
