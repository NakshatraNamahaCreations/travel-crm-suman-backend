import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// A single bookable service line within a trip (one hotel stay or one operational
// service). Created from the accepted quote, then worked through a status workflow
// with its own price, tag and comments.
//
// Status is a one-way progression: 'initialized' can move to 'in_progress',
// 'booked' or 'changed'; 'in_progress'/'changed' can move to each other or to
// 'booked'; 'booked' (== finalized/confirmed with the supplier) can only move
// to 'cancelled' ("Dropped") — dropping isn't offered before a line is booked.
// See UpdateBookingStatusModal.jsx on the client for the enforced transitions.
export const SERVICE_BOOKING_KINDS = ['hotel', 'operational', 'flight'];
export const SERVICE_BOOKING_STATUSES = ['initialized', 'in_progress', 'booked', 'changed', 'cancelled'];

const serviceBookingSchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required: true, index: true },
    quote: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    kind: { type: String, enum: SERVICE_BOOKING_KINDS, required: true, index: true },

    // Display snapshot (copied from the quote at generation time).
    hotelRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel' }, // master hotel record (address/check-in policy)
    name: { type: String, trim: true }, // hotel name / service title / flight label
    city: { type: String, trim: true },
    stars: { type: Number },
    roomType: { type: String, trim: true },
    mealPlan: { type: String, trim: true },
    rooms: { type: Number },
    paxPerRoom: { type: Number, default: 2 }, // without extra bed (WoEB)
    aweb: { type: Number, default: 0 },
    cweb: { type: Number, default: 0 },
    cnb: { type: Number, default: 0 }, // child no bed (comp, upto 5y)
    nights: [{ type: Number }],
    day: { type: Number }, // trip day number (operational services)
    checkIn: { type: Date },
    checkOut: { type: Date },
    detail: { type: String, trim: true }, // free-text "Stay and Services" breakdown

    // One row per stay night — the Prices panel in the edit modal.
    nightRates: [
      {
        _id: false,
        date: { type: Date },
        given: { type: Number, default: 0 }, // quoted/sell rate (reference)
        booked: { type: Number, default: 0 }, // actual rate booked with the hotel
      },
    ],

    status: { type: String, enum: SERVICE_BOOKING_STATUSES, default: 'initialized', index: true },
    price: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 }, // paid to the supplier so far, against `price`
    currency: { type: String, default: 'INR' },
    tag: { type: String, trim: true },
    comment: { type: String, trim: true },
    flagged: { type: Boolean, default: false },

    // Hotel confirmation voucher (per-stay) — Bookings > Hotel Check-Ins "Generate".
    confirmationNumber: { type: String, trim: true },
    voucherContact: { type: String, trim: true },
    voucherNotes: { type: String, trim: true },
    voucherGeneratedAt: { type: Date },

    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

serviceBookingSchema.set('toJSON', { virtuals: true });

serviceBookingSchema.plugin(tenantPlugin);

export const ServiceBooking = mongoose.model('ServiceBooking', serviceBookingSchema);
