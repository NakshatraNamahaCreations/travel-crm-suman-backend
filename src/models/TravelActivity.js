import mongoose from 'mongoose';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

const intervalSchema = new mongoose.Schema({ start: { type: Date }, end: { type: Date } }, { _id: false });

// A ticket/package option within an activity (e.g. "Makruzz Ferry: Premium").
const ticketTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    internalRefCode: { type: String, trim: true }, // supplier / hidden reference
    // Transport service type this ticket belongs to (e.g. "Cellular Jail
    // Visit with Sound & Light Show") — quotes picking this ticket auto-link
    // it so the PDF nests the ticket under that service.
    forService: { type: String, trim: true },
    slots: { type: String, trim: true }, // e.g. "11:00, 13:00"
    duration: { type: Number }, // numeric duration
    durationUnit: { type: String, trim: true, default: 'mins' }, // mins / hours / days
    details: { type: String, trim: true }, // itinerary / inclusions (markdown)
    imageUrl: { type: String }, // per-ticket photo (e.g. each ferry operator/class has its own)
    // Per-ticket closing (used when the activity does not share closing across tickets).
    closedDays: [{ type: String, trim: true }],
    closedDates: [intervalSchema],
    isActive: { type: Boolean, default: true },
  },
  { _id: true }
);

const travelActivitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // 'ticket' = ferry / entry tickets (Makruzz classes, Cellular Jail entry…),
    // 'activity' = experiences (scuba, jet ski, banana ride…).
    kind: { type: String, enum: ['activity', 'ticket'], default: 'activity', index: true },
    details: { type: String, trim: true }, // activity-level itinerary / details
    destinations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],
    imageUrl: { type: String },

    // Pickup / drop configuration (mirrors transport services).
    useSamePickDrop: { type: Boolean, default: true },
    pickupLocations: [{ type: String, trim: true }],
    dropLocations: [{ type: String, trim: true }],
    useCheckinAsPickup: { type: Boolean, default: false },
    useCheckinAsDrop: { type: Boolean, default: false },

    ageConfig: { type: String, trim: true, default: 'Adult, Child (6-12)' },
    complimentaryAge: { type: Number },

    // Closing days/dates shared across all ticket types (when useSameClosing).
    useSameClosing: { type: Boolean, default: true },
    closedDays: [{ type: String, trim: true }],
    closedDates: [intervalSchema],

    ticketTypes: [ticketTypeSchema],
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

travelActivitySchema.set('toJSON', { virtuals: true });

travelActivitySchema.plugin(tenantPlugin);

export const TravelActivity = mongoose.model('TravelActivity', travelActivitySchema);
