import { ProformaInvoice } from '../models/ProformaInvoice.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/apiResponse.js';
import { proformaHtml } from '../pdf/proformaHtml.js';
import { htmlToPdf } from '../pdf/renderPdf.js';

const POPULATE = [
  { path: 'createdBy', select: 'name' },
  { path: 'query', select: 'queryNumber guest' },
];

// GET /api/proforma-invoices?query=<id>
export const listProformaInvoices = asyncHandler(async (req, res) => {
  if (!req.query.query) throw ApiError.badRequest('query id is required');
  const items = await ProformaInvoice.find({ query: req.query.query }).populate(POPULATE).sort('-createdAt');
  return ok(res, items);
});

// POST /api/proforma-invoices
export const createProformaInvoice = asyncHandler(async (req, res) => {
  const doc = await ProformaInvoice.create({ ...req.body, createdBy: req.user._id });
  const item = await ProformaInvoice.findById(doc._id).populate(POPULATE);
  return created(res, item);
});

// PATCH /api/proforma-invoices/:id
export const updateProformaInvoice = asyncHandler(async (req, res) => {
  const doc = await ProformaInvoice.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Proforma invoice not found');
  const { query, invoiceNumber, createdBy, ...patch } = req.body; // immutable fields
  Object.assign(doc, patch);
  await doc.save();
  const item = await ProformaInvoice.findById(doc._id).populate(POPULATE);
  return ok(res, item);
});

// DELETE /api/proforma-invoices/:id
export const deleteProformaInvoice = asyncHandler(async (req, res) => {
  const doc = await ProformaInvoice.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Proforma invoice not found');
  return ok(res, { id: req.params.id });
});

// GET /api/proforma-invoices/:id/pdf — server-rendered PDF (inline)
export const proformaPdf = asyncHandler(async (req, res) => {
  const doc = await ProformaInvoice.findById(req.params.id).populate(POPULATE);
  if (!doc) throw ApiError.notFound('Proforma invoice not found');
  const org = await OrgProfile.getFor(req.organizationId).catch(() => null);
  const pdf = await htmlToPdf(proformaHtml(doc.toObject(), org?.toObject()));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ProformaInvoice-${doc.invoiceNumber}.pdf"`);
  return res.send(pdf);
});
