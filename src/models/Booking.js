import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const guestSnap = new mongoose.Schema(
  {
    salutation: String,
    name: String,
    email: String,
    location: String,
    phones: [{ countryCode: String, number: String, isPrimary: Boolean }],
  },
  { _id: false }
);

const bookingSchema = new mongoose.Schema(
  {
    bookingNumber: { type: Number, index: true }, // unique per-org (compound index below)
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', index: true },
    quote: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },

    title: { type: String, trim: true },
    guest: guestSnap,
    destinations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],

    startDate: { type: Date },
    endDate: { type: Date },
    nights: { type: Number, default: 0 },
    pax: { adults: Number, children: [{ age: Number }] },

    status: {
      type: String,
      enum: ['confirmed', 'on_trip', 'completed', 'cancelled'],
      default: 'confirmed',
      index: true,
    },

    // Itinerary + cost snapshot copied from the accepted quote.
    days: [{ dayNumber: Number, date: Date, title: String, description: String }],
    costItems: [{ category: String, label: String, meta: String, qty: Number, rate: Number, amount: Number }],

    currency: { type: String, default: 'INR' },
    // Package price from the accepted quote PLUS any extras below.
    totalAmount: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 }, // maintained by the accounting module

    // Admin-added charges on top of the package (a late add-on activity, a
    // room upgrade, an extra transfer…). Each one is collected through its
    // own incoming instalment and is never touched by quote re-syncs.
    extras: [
      {
        label: { type: String, trim: true, required: true },
        amount: { type: Number, required: true, min: 0 },
        note: { type: String, trim: true },
        installment: { type: mongoose.Schema.Types.ObjectId, ref: 'Installment' },
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

bookingSchema.virtual('balanceDue').get(function () {
  return Math.round(Math.max(0, (this.totalAmount || 0) - (this.paidAmount || 0)) * 100) / 100;
});
bookingSchema.virtual('days_count').get(function () {
  return (this.nights || 0) + 1;
});

bookingSchema.pre('validate', function computeEnd(next) {
  if (this.startDate && this.nights != null && !this.endDate) {
    const end = new Date(this.startDate);
    end.setDate(end.getDate() + this.nights);
    this.endDate = end;
  }
  next();
});

// Tenant scoping — registered BEFORE assignNumber so this.organization is
// stamped when the counter key is built.
bookingSchema.plugin(tenantPlugin);
bookingSchema.index({ organization: 1, bookingNumber: 1 }, { unique: true });

bookingSchema.pre('save', async function assignNumber(next) {
  if (this.isNew && !this.bookingNumber) {
    this.bookingNumber = await Counter.nextFor(this.organization, 'booking', 7100000);
  }
  next();
});

bookingSchema.set('toJSON', { virtuals: true });
bookingSchema.set('toObject', { virtuals: true });

export const Booking = mongoose.model('Booking', bookingSchema);
