import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { tenantPlugin } from '../tenant/tenantPlugin.js';
import { shareTokenField } from '../utils/shareToken.js';

// A GST tax invoice raised against a specific customer payment (instalment) —
// one invoice per payment received, matching how GST is normally documented
// for a service already rendered/paid for. Seller/buyer blocks are
// snapshotted at creation so later company-config edits don't rewrite old
// invoices.
//
// Tax is added ON TOP of taxableValue (not backed out), same convention the
// quote's own pricing already uses. taxType decides the split:
//   'intra' (same state as seller) → CGST + SGST, each half of gstPercent
//   'inter' (different state)      → IGST, the full gstPercent
const gstInvoiceSchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required: true, index: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
    installment: { type: mongoose.Schema.Types.ObjectId, ref: 'Installment', index: true },
    invoiceNumber: { type: Number, index: true },
    invoiceDate: { type: Date, default: Date.now },

    seller: {
      name: { type: String, trim: true },
      address: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true },
      gstin: { type: String, trim: true },
      pan: { type: String, trim: true },
    },
    buyer: {
      name: { type: String, trim: true },
      address: { type: String, trim: true },
      email: { type: String, trim: true },
      gstin: { type: String, trim: true },
    },

    placeOfSupply: { type: String, trim: true },
    paymentDate: { type: Date }, // when the payment this invoice documents was actually received
    paymentMode: { type: String, trim: true },
    particulars: { type: String, trim: true },
    hsn: { type: String, trim: true }, // HSN/SAC code

    taxableValue: { type: Number, default: 0 }, // agent-entered base amount
    gstPercent: { type: Number, default: 5 },
    taxType: { type: String, enum: ['intra', 'inter'], default: 'intra' },
    cgst: { type: Number, default: 0 }, // computed
    sgst: { type: Number, default: 0 }, // computed
    igst: { type: Number, default: 0 }, // computed
    amount: { type: Number, default: 0 }, // computed grand total

    amountReceived: { type: Number, default: 0 }, // usually = amount (invoice raised against a payment already collected)

    terms: { type: String, trim: true },
    specialNotes: { type: String, trim: true },
    currency: { type: String, default: 'INR' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ...shareTokenField,
  },
  { timestamps: true }
);

gstInvoiceSchema.pre('validate', function compute(next) {
  const base = Math.round((this.taxableValue || 0) * 100) / 100;
  const pct = this.gstPercent || 0;
  this.taxableValue = base;
  if (this.taxType === 'inter') {
    this.igst = Math.round(base * (pct / 100) * 100) / 100;
    this.cgst = 0;
    this.sgst = 0;
  } else {
    this.cgst = Math.round(base * (pct / 200) * 100) / 100;
    this.sgst = this.cgst;
    this.igst = 0;
  }
  this.amount = Math.round((base + this.cgst + this.sgst + this.igst) * 100) / 100;
  if (this.amountReceived == null) this.amountReceived = this.amount;
  next();
});

// Tenant scoping — registered BEFORE assignNumber so this.organization is
// stamped when the counter key is built.
gstInvoiceSchema.plugin(tenantPlugin);
gstInvoiceSchema.index({ organization: 1, invoiceNumber: 1 }, { unique: true });

gstInvoiceSchema.pre('save', async function assignNumber(next) {
  if (this.isNew && !this.invoiceNumber) this.invoiceNumber = await Counter.nextFor(this.organization, 'gstInvoice', 1);
  next();
});

export const GstInvoice = mongoose.model('GstInvoice', gstInvoiceSchema);
