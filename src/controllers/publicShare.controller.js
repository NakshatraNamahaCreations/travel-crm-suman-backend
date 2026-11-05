import { Quote } from '../models/Quote.js';
import { Installment } from '../models/Installment.js';
import { GstInvoice } from '../models/GstInvoice.js';
import { OrgProfile } from '../models/OrgProfile.js';
import { loadFullQuote } from './quote.controller.js';
import { buildReceiptPdf } from './installment.controller.js';
import { buildGstInvoicePdf } from './gstInvoice.controller.js';
import { quotationHtml } from '../pdf/quotationHtml.js';
import { voucherHtml } from '../pdf/voucherHtml.js';
import { htmlToPdf } from '../pdf/renderPdf.js';
import { runWithTenant } from '../tenant/context.js';
import { ensureShareToken } from '../utils/shareToken.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { env } from '../config/env.js';

/* ------------------------- customer-facing (public) ------------------------ */
// These routes are mounted OUTSIDE the auth/tenant wall so a guest can open
// the document from a WhatsApp/email link. The random token IS the
// credential: it is looked up globally (no tenant context, so tenantPlugin is
// a deliberate no-op), then the rest of the work runs inside that document's
// own organization so branding and related lookups behave exactly as they do
// for a logged-in agent. Clearing `shareToken` revokes the link.

const KINDS = {
  quote: {
    model: Quote,
    build: async (doc) => {
      const quote = await loadFullQuote(doc._id);
      const org = await OrgProfile.getFor(doc.organization).catch(() => null);
      const pdf = await htmlToPdf(quotationHtml(quote.toObject(), org?.toObject()));
      return { pdf, filename: `Quotation-${quote.quoteNumber}.pdf` };
    },
  },
  // Trip voucher — the "final travel documents" a guest carries. Shares the
  // Quote's token: one link per quote, two renderings of it.
  voucher: {
    model: Quote,
    build: async (doc) => {
      const quote = await loadFullQuote(doc._id);
      const org = await OrgProfile.getFor(doc.organization).catch(() => null);
      const html = voucherHtml(quote.toObject(), { org: org?.toObject(), type: 'trip', options: { tnc: true } });
      const pdf = await htmlToPdf(html);
      return { pdf, filename: `TravelDocuments-${quote.quoteNumber}.pdf` };
    },
  },
  receipt: {
    model: Installment,
    build: (doc) => buildReceiptPdf(doc._id, doc.organization),
  },
  invoice: {
    model: GstInvoice,
    build: (doc) => buildGstInvoicePdf(doc._id, doc.organization),
  },
};

// GET /api/public/:kind/:token — streams the document as an inline PDF.
export const publicDocument = asyncHandler(async (req, res) => {
  const spec = KINDS[req.params.kind];
  if (!spec) throw ApiError.notFound('Unknown document type');

  const token = String(req.params.token || '');
  // Guard against a blank/short token matching documents with no token set.
  if (token.length < 32) throw ApiError.notFound('This link is not valid');

  const doc = await spec.model.findOne({ shareToken: token }).select('_id organization');
  if (!doc) throw ApiError.notFound('This link is no longer valid');

  const { pdf, filename } = await runWithTenant(doc.organization, () => spec.build(doc));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  // Public but private-to-the-recipient: never let shared caches keep it.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.send(pdf);
});

/* --------------------------- staff-side (authed) --------------------------- */

const publicBase = () => (env.publicBaseUrl || '').replace(/\/+$/, '');

export const shareUrlFor = (kind, token) => `${publicBase()}/api/public/${kind}/${token}`;

// POST /api/share-links  { kind: 'quote'|'receipt'|'invoice', id }
// Mints (or returns) the customer-facing link for one document.
export const createShareLink = asyncHandler(async (req, res) => {
  const { kind, id } = req.body;
  const spec = KINDS[kind];
  if (!spec) throw ApiError.badRequest(`kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  if (!id) throw ApiError.badRequest('id is required');

  const doc = await spec.model.findById(id);
  if (!doc) throw ApiError.notFound('Document not found');

  const token = await ensureShareToken(doc);
  return ok(res, { kind, id, token, url: shareUrlFor(kind, token) });
});

// DELETE /api/share-links  { kind, id } — revokes any link already shared.
export const revokeShareLink = asyncHandler(async (req, res) => {
  const { kind, id } = req.body;
  const spec = KINDS[kind];
  if (!spec) throw ApiError.badRequest(`kind must be one of: ${Object.keys(KINDS).join(', ')}`);

  const doc = await spec.model.findById(id);
  if (!doc) throw ApiError.notFound('Document not found');
  doc.shareToken = undefined;
  await doc.save();
  return ok(res, { kind, id, revoked: true });
});
