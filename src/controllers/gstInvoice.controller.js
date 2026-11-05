import { GstInvoice } from '../models/GstInvoice.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { gstInvoiceHtml } from '../pdf/gstInvoiceHtml.js';
import { htmlToPdf } from '../pdf/renderPdf.js';

const POPULATE = [
  { path: 'createdBy', select: 'name' },
  { path: 'query', select: 'queryNumber guest' },
];

// GET /api/gst-invoices?query=<id>&installment=<id>
export const listGstInvoices = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.query) filter.query = req.query.query;
  if (req.query.installment) filter.installment = req.query.installment;
  if (!filter.query && !filter.installment) throw ApiError.badRequest('query or installment id is required');
  const items = await GstInvoice.find(filter).populate(POPULATE).sort('-createdAt');
  return ok(res, items);
});

// POST /api/gst-invoices
export const createGstInvoice = asyncHandler(async (req, res) => {
  const doc = await GstInvoice.create({ ...req.body, createdBy: req.user._id });
  const item = await GstInvoice.findById(doc._id).populate(POPULATE);
  return created(res, item);
});

// PATCH /api/gst-invoices/:id
export const updateGstInvoice = asyncHandler(async (req, res) => {
  const doc = await GstInvoice.findById(req.params.id);
  if (!doc) throw ApiError.notFound('GST invoice not found');
  const { query, installment, invoiceNumber, createdBy, ...patch } = req.body; // immutable fields
  Object.assign(doc, patch);
  await doc.save();
  const item = await GstInvoice.findById(doc._id).populate(POPULATE);
  return ok(res, item);
});

// DELETE /api/gst-invoices/:id
export const deleteGstInvoice = asyncHandler(async (req, res) => {
  const doc = await GstInvoice.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('GST invoice not found');
  return ok(res, { id: req.params.id });
});

// Builds the GST invoice PDF. Shared by the authenticated route below and
// the public (tokenised) share link.
export async function buildGstInvoicePdf(id, orgId) {
  const doc = await GstInvoice.findById(id).populate(POPULATE);
  if (!doc) throw ApiError.notFound('GST invoice not found');
  const org = await OrgProfile.getFor(orgId).catch(() => null);
  const pdf = await htmlToPdf(gstInvoiceHtml(doc.toObject(), org?.toObject()));
  return { pdf, filename: `GSTInvoice-${doc.invoiceNumber}.pdf` };
}

// GET /api/gst-invoices/:id/pdf — server-rendered PDF (inline)
export const gstInvoicePdf = asyncHandler(async (req, res) => {
  const { pdf, filename } = await buildGstInvoicePdf(req.params.id, req.organizationId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  return res.send(pdf);
});
