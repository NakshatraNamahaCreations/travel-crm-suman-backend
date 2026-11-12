import mongoose from 'mongoose';
import { company } from '../config/company.js';

// Per-organization profile — the editable version of the static company
// config (one document per tenant, auto-created from the config template on
// first read). Documents that render seller / bank blocks (e.g. proforma
// invoices) read from here so admins can update details without a code change.
const addressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    address: { type: String, trim: true }, // multiline
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    gstin: { type: String, trim: true }, // billing addresses only
    primary: { type: Boolean, default: false },
  },
  { _id: true }
);

const bankAccountSchema = new mongoose.Schema(
  {
    holder: { type: String, trim: true },
    bank: { type: String, trim: true },
    branch: { type: String, trim: true },
    ifsc: { type: String, trim: true },
    accNo: { type: String, trim: true },
    currency: { type: String, trim: true, default: 'INR' },
  },
  { _id: true }
);

// A cover banner, chosen per destination when a quotation is rendered.
//
// Keyed by `match` keywords rather than only a Destination id: a quotation's cover is picked
// from the hotel cities it actually covers, which are free text and need not correspond to a
// Destination row. "kashmir|srinagar|gulmarg" catches the trip whichever of those the agent
// typed, and the id is still honoured when one is set.
const quoteBannerSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, required: true }, // 'Kashmir', shown in the picker
    destination: { type: mongoose.Schema.Types.ObjectId, ref: 'Destination' },
    match: { type: String, trim: true }, // pipe-separated keywords, case-insensitive
    image: { type: String }, // CDN url (or data URI when Cloudinary is not configured)
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

// One numbered Terms & Conditions block. Mirrors the shape the static config has always used
// (heading / intro / table / items), so an organization that has not customised anything keeps
// rendering exactly what it rendered before.
const quoteTermsSchema = new mongoose.Schema(
  {
    heading: { type: String, trim: true, required: true }, // '1. Booking Policy'
    intro: { type: String, trim: true },
    boxTitle: { type: String, trim: true },
    table: {
      headers: [{ type: String, trim: true }],
      rows: [[{ type: String, trim: true }]],
    },
    items: [{ type: String, trim: true }],
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

const orgProfileSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
    officialName: { type: String, trim: true },
    brandName: { type: String, trim: true },
    supportPhones: [{ type: String, trim: true }],
    emails: [{ type: String, trim: true }],
    website: { type: String, trim: true },
    brandPrefixCode: { type: String, trim: true },
    colorTheme: { type: String, trim: true, default: '#1e56d6' },
    autoLockDays: { type: Number, default: 0 }, // 0 = not active

    // Brand images stored as data URIs (small, downscaled client-side) so
    // they inline directly into generated PDFs with no static hosting.
    images: {
      logo: { type: String },
      headerBanner: { type: String }, // branded PDF header/letterhead
      footerBanner: { type: String }, // branded PDF footer
      headerBannerPlain: { type: String }, // used when Hide Branding is on
      footerBannerPlain: { type: String },
    },
    contactAddresses: [addressSchema],
    billingAddresses: [addressSchema],
    bankAccounts: [bankAccountSchema],

    // How this organization's quotation PDF looks. Every field is optional: anything left
    // unset falls back to the static config the document used before this existed, so an
    // organization that never opens the editor sees no change at all.
    quotation: {
      colors: {
        primary: { type: String, trim: true }, // headings, section bars, cover text
        accent: { type: String, trim: true }, // price highlights, call-outs
        text: { type: String, trim: true }, // body copy
        soft: { type: String, trim: true }, // hairline borders
        tint: { type: String, trim: true }, // pale panel fills
      },
      banners: { type: [quoteBannerSchema], default: undefined },
      // Used when no banner's destination or keywords match the trip.
      defaultBanner: { type: String },
      terms: { type: [quoteTermsSchema], default: undefined },
      bookingTerms: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

// Fetch (or lazily create from the config template) the profile of one org.
orgProfileSchema.statics.getFor = async function getFor(orgId) {
  if (!orgId) throw new Error('OrgProfile.getFor: organization id is required');
  const existing = await this.findOne({ organization: orgId });
  if (existing) return existing;
  return this.create({
    organization: orgId,
    officialName: company.name,
    brandName: company.name,
    supportPhones: company.phones || [],
    emails: company.emails || [],
    website: company.website || '',
    contactAddresses: [
      { label: 'Address', address: (company.address || []).join('\n'), phone: company.phones?.[0] || '', email: company.emails?.[0] || '', primary: true },
    ],
    billingAddresses: [
      { label: 'Registered Office', address: (company.address || []).join('\n'), phone: company.phones?.[0] || '', email: company.emails?.[0] || '', gstin: company.gstin || '', primary: true },
    ],
    bankAccounts: company.bank
      ? [{ holder: company.bank.holder, bank: company.bank.bank, branch: company.bank.address, ifsc: company.bank.ifsc, accNo: company.bank.accNo, currency: 'INR' }]
      : [],
  });
};

export const OrgProfile = mongoose.model('OrgProfile', orgProfileSchema);
