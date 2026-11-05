/* Starter master data for a tenant organization: option lists, query sources,
   tags and destinations. Used by the owner "create company" flow and by the
   seed scripts. Expects an open mongoose connection; wraps its own tenant
   context so every upsert is stamped with the target organization. */
import { runWithTenant } from '../tenant/context.js';
import { Option } from '../models/Option.js';
import { QuerySource } from '../models/QuerySource.js';
import { Tag } from '../models/Tag.js';
import { Destination } from '../models/Destination.js';
import { seedWhatsappTemplates } from '../controllers/whatsappTemplate.controller.js';
import { LeadSettings } from '../models/LeadSettings.js';
import { AssignmentRule } from '../models/AssignmentRule.js';

export const DEFAULT_OPTIONS = {
  city: [
    'Malé', 'Hulhumalé', 'Maafushi', 'Thulusdhoo',
    'Dhigurah', 'Fulidhoo', 'Rasdhoo', 'Ukulhas',
    'Ari Atoll', 'Baa Atoll', 'Vaavu Atoll',
    'South Malé Atoll', 'North Malé Atoll',
  ],
  state: ['Kaafu Atoll', 'Alif Dhaal Atoll', 'Baa Atoll', 'Vaavu Atoll'],
  country: ['Maldives', 'India'],
  mealPlan: ['Room only', 'BB', 'HB', 'FB', 'All Inclusive'],
  salutation: ['Mr.', 'Mrs.', 'Ms.'],
  currency: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'THB'],
  paymentMode: ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'],
  vehicleType: [
    'Sedan (Dzire/Etios)', 'SUV (Xylo/Ertiga)',
    '17 Seater Tempo Traveller', '26 Seater Tempo Traveller',
  ],
  paxConfig: ['Adult', 'Child (2-12)', 'Child (6-12)', 'Child (1-2)', 'Infant'],
  hotelGroup: ['Lagoon Pearl', 'Coral Bay', 'Azure', 'Reef Horizon', 'Turquoise', 'Sunset Atoll', 'Blue Lagoon', 'Manta Reef'],
  hotelService: [
    'Candle Light Dinner', 'Beach Side Candle Light Dinner', 'Gala Dinner',
    'Honeymoon Cake', 'Flower Bed Decoration', 'Fruit Basket', 'Early Check-in', 'Late Check-out',
  ],
  tripService: [
    'Cake and Room Decoration', 'Candle Light Dinner', 'Candle Light Dinner (Pool Side)',
    'Sandbank Dinner', 'Sunset Fishing', 'Beach BBQ', 'Photography / Videography', 'Scuba Diving',
  ],
  paymentPreference: [
    '25% on Booking Date, 75% 1 day after Checkin Date',
    '25% on Booking Date, 75% 2 days before Checkin Date',
    'Full payment on booking',
    '50% advance, 50% on arrival',
  ],
};

// 'Meta Ads' and 'Google Ads' are the names the lead ingest maps its channels onto (see
// config/leadChannels.js), so they are seeded here — otherwise the first captured ad lead
// creates them, and a tenant finds master data appearing without having added it.
const DEFAULT_QUERY_SOURCES = ['Website', 'B2B', 'WhatsApp', 'Referral', 'Walk-in', 'Instagram', 'Google Ads', 'Meta Ads'];
const DEFAULT_TAGS = ['honeymoon', 'family', 'group', 'luxury', 'budget'];
const DEFAULT_DESTINATIONS = [
  { name: 'Maldives', country: 'Maldives', region: 'Indian Ocean' },
  { name: 'Maldives — Ari Atoll', country: 'Maldives', region: 'Ari Atoll' },
];

export async function seedMasterData(orgId) {
  return runWithTenant(orgId, async () => {
    for (const [category, values] of Object.entries(DEFAULT_OPTIONS)) {
      for (let i = 0; i < values.length; i++) {
        await Option.findOneAndUpdate(
          { category, value: values[i] },
          { category, value: values[i], label: values[i], order: i },
          { upsert: true, setDefaultsOnInsert: true }
        );
      }
    }
    for (const name of DEFAULT_QUERY_SOURCES) {
      await QuerySource.findOneAndUpdate({ name }, { name }, { upsert: true, setDefaultsOnInsert: true });
    }
    for (const name of DEFAULT_TAGS) {
      await Tag.findOneAndUpdate({ name }, { name }, { upsert: true, setDefaultsOnInsert: true });
    }
    for (const d of DEFAULT_DESTINATIONS) {
      await Destination.findOneAndUpdate({ name: d.name }, d, { upsert: true, setDefaultsOnInsert: true });
    }
    // Starter WhatsApp copy, so the module isn't an empty page on day one.
    await seedWhatsappTemplates();
    await seedAssignmentRules();
  });
}

// Starter lead-routing rules.
//
// Deliberately only two, and neither names a person or a team: a seeded rule pointing at a
// team that does not exist yet is a rule that never matches, and a manager reading the list
// cannot tell it apart from one that is simply not firing. These two work on day one with
// whatever staff the organization has, and the rest are built on the Assignment page.
//
// The fallback is seeded because the engine refuses to assign a lead that matches nothing:
// without it, switching automatic assignment on would route nothing at all.
const DEFAULT_ASSIGNMENT_RULES = [
  {
    label: 'Paid ad leads — call fast',
    order: 1,
    match: 'any',
    conditions: [{ field: 'channel', op: 'in', value: ['google_ads', 'meta_ads'] }],
    targetType: 'any',
    method: 'least_busy',
    // Tighter than the default: a lead you paid for going cold costs money twice.
    slaMinutes: 10,
  },
  {
    label: 'Everything else',
    order: 99,
    conditions: [],
    targetType: 'any',
    method: 'least_busy',
    isFallback: true,
  },
];

async function seedAssignmentRules() {
  // Settings are created here rather than on first page load so the ingest token exists before
  // anyone opens the UTM Capture page and wants the snippet.
  await LeadSettings.getFor();
  for (const rule of DEFAULT_ASSIGNMENT_RULES) {
    // Keyed on the label: re-running the seed must not add a second copy, and a tenant who has
    // edited or deleted a starter rule should keep their decision.
    await AssignmentRule.findOneAndUpdate(
      { label: rule.label },
      { $setOnInsert: rule },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
}
