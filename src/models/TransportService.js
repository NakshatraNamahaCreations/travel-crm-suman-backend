import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const intervalSchema = new mongoose.Schema({ start: { type: Date }, end: { type: Date } }, { _id: false });

// One service offered within a transport route (e.g. "Cellular Jail Visit").
const transportItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    serviceCode: { type: String, trim: true }, // supplier / hidden, non-customer-shareable
    distanceKms: { type: Number, default: 0 },
    startTime: { type: String, trim: true }, // default start time for the service
    durationMins: { type: Number, default: 60 },
    closedDays: [{ type: String, trim: true }], // weekdays the service is non-operational
    closedDates: [intervalSchema], // date intervals the service is non-operational
    description: { type: String, trim: true },
    imageUrl: { type: String },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { _id: true, timestamps: true }
);

// A transport route grouping (Start City → End City) with one or more service items.
const transportServiceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    from: { type: String, trim: true }, // start city
    to: { type: String, trim: true }, // end city
    shortCode: { type: String, trim: true },
    destinations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],

    // Pickup / drop configuration
    useSamePickDrop: { type: Boolean, default: true },
    pickupLocations: [{ type: String, trim: true }],
    dropLocations: [{ type: String, trim: true }],
    useCheckinAsPickup: { type: Boolean, default: false },
    useCheckinAsDrop: { type: Boolean, default: false },

    imageUrl: { type: String },
    items: [transportItemSchema],
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

transportServiceSchema.virtual('routeLabel').get(function () {
  return this.to ? `${this.from || this.name} → ${this.to}` : this.from || this.name;
});

transportServiceSchema.set('toJSON', { virtuals: true });
transportServiceSchema.set('toObject', { virtuals: true });

transportServiceSchema.plugin(tenantPlugin);

export const TransportService = mongoose.model('TransportService', transportServiceSchema);
