import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// A room type and how many extra beds of each kind it allows.
const roomTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    eb: { type: Number, default: 0 }, // allowed extra beds
    aweb: { type: Number, default: 0 }, // adult with extra bed
    cweb: { type: Number, default: 0 }, // child with extra bed
    cnb: { type: Number, default: 0 }, // child no bed
    rooms: { type: Number, default: 0 }, // no. of rooms
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    designation: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
  },
  { _id: false }
);

const phoneSchema = new mongoose.Schema(
  { countryCode: { type: String, default: '91' }, number: { type: String, trim: true } },
  { _id: false }
);

const intervalSchema = new mongoose.Schema(
  { start: { type: Date }, end: { type: Date } },
  { _id: false }
);

const hotelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    groupName: { type: String, trim: true },
    location: {
      label: { type: String, trim: true }, // "city location" used for matching/filters
      city: { type: String, trim: true },   // plain string (kept for search/display)
      cityRef: { type: mongoose.Schema.Types.ObjectId, ref: 'City' },
      state: { type: String, trim: true },  // plain string (kept for search/display)
      stateRef: { type: mongoose.Schema.Types.ObjectId, ref: 'State' },
      country: { type: String, trim: true, default: 'India' },
      pin: { type: String, trim: true },
      street: { type: String, trim: true },
      locality: { type: String, trim: true },
      landmark: { type: String, trim: true },
    },
    stars: { type: Number, min: 1, max: 5, default: 3 },
    mealPlans: [{ type: String, trim: true }],
    roomTypes: [roomTypeSchema],

    // Stop sale / blackout / soldout
    applyRestrictionsToAll: { type: Boolean, default: true },
    restrictionRoomTypes: [{ type: String, trim: true }], // when not applying to all
    soldoutDates: [intervalSchema],
    blackoutDates: [intervalSchema],

    checkIn: { type: String, default: '12:00' },
    checkOut: { type: String, default: '11:59' },
    childEbAge: { from: { type: Number, default: 6 }, to: { type: Number, default: 12 } },

    paymentPreference: { type: String, trim: true },

    destinations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],
    address: { type: String, trim: true },
    imageUrl: { type: String },
    detailsLink: { type: String, trim: true },
    notes: { type: String, trim: true },

    phones: [phoneSchema],
    email: { type: String, trim: true },
    contacts: [contactSchema],

    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

hotelSchema.virtual('locationLabel').get(function () {
  return (
    this.location?.label ||
    [this.location?.city, this.location?.state, this.location?.country].filter(Boolean).join(', ')
  );
});

hotelSchema.index({ name: 'text', 'location.city': 'text' });
hotelSchema.set('toJSON', { virtuals: true });
hotelSchema.set('toObject', { virtuals: true });

hotelSchema.plugin(tenantPlugin);

export const Hotel = mongoose.model('Hotel', hotelSchema);
