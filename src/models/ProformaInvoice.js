import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { tenantPlugin } from '../tenant/tenantPlugin.js';

// One proforma invoice raised against a trip (query). Seller/buyer blocks are
// snapshotted at creation so later company-config edits don't rewrite old
// invoices.
const itemSchema = new mongoose.Schema(
  {
    particular: { type: String, trim: true },
    qty: { type: Number, default: 1 },
    amount: { type: Number, default: 0 },
    hsn: { type: String, trim: true }, // HSN/SAC code
    total: { type: Number, default: 0 }, // computed qty × amount
  },
  { _id: false }
);

const proformaInvoiceSchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required: true, index: true },
    invoiceNumber: { type: Number, index: true },

    seller: {
      name: { type: String, trim: true },
      address: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true },
      gstin: { type: String, trim: true },
    },
    buyer: {
      name: { type: String, trim: true },
      address: { type: String, trim: true },
    },

    placeOfSupply: { type: String, trim: true },
    bankAccount: { type: String, trim: true }, // display label, e.g. "IDBI - **8013 - INR"
    // Bank details snapshot (from the org profile at creation time).
    bank: {
      holder: { type: String, trim: true },
      bank: { type: String, trim: true },
      branch: { type: String, trim: true },
      ifsc: { type: String, trim: true },
      accNo: { type: String, trim: true },
    },
    dueDate: { type: Date },
    overview: { type: String, trim: true },

    items: [itemSchema],
    hideTaxBreakup: { type: Boolean, default: true },
    specialNotes: { type: String, trim: true },
    terms: { type: String, trim: true },

    total: { type: Number, default: 0 }, // computed
    currency: { type: String, default: 'INR' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

proformaInvoiceSchema.pre('validate', function compute(next) {
  let total = 0;
  for (const it of this.items || []) {
    it.total = Math.round(((it.qty || 0) * (it.amount || 0)) * 100) / 100;
    total += it.total;
  }
  this.total = Math.round(total * 100) / 100;
  next();
});

// Tenant scoping — registered BEFORE assignNumber so this.organization is
// stamped when the counter key is built.
proformaInvoiceSchema.plugin(tenantPlugin);
proformaInvoiceSchema.index({ organization: 1, invoiceNumber: 1 }, { unique: true });

proformaInvoiceSchema.pre('save', async function assignNumber(next) {
  if (this.isNew && !this.invoiceNumber) this.invoiceNumber = await Counter.nextFor(this.organization, 'proformaInvoice', 1);
  next();
});

export const ProformaInvoice = mongoose.model('ProformaInvoice', proformaInvoiceSchema);
