import { Router } from 'express';
import authRoutes from './auth.routes.js';
import ownerRoutes from './owner.routes.js';
import { publicDocRoutes, shareLinkRoutes } from './publicShare.routes.js';
import { protect, requireModule } from '../middleware/auth.js';
import { tenantContext } from '../tenant/middleware.js';
import userRoutes from './user.routes.js';
import { teamRoutes } from './team.routes.js';
import {
  destinationRoutes,
  querySourceRoutes,
  tagRoutes,
  inclusionExclusionRoutes,
} from './masterData.routes.js';
import queryRoutes from './query.routes.js';
import leadRoutes from './leads.routes.js';
import leadIngestRoutes from './leadIngest.routes.js';
import quoteRoutes from './quote.routes.js';
import lookupRoutes from './lookup.routes.js';
import reportRoutes from './report.routes.js';
import bookingRoutes from './booking.routes.js';
import serviceBookingRoutes from './serviceBooking.routes.js';
import paymentRoutes from './payment.routes.js';
import installmentRoutes from './installment.routes.js';
import accountRoutes from './account.routes.js';
import proformaRoutes from './proforma.routes.js';
import gstInvoiceRoutes from './gstInvoice.routes.js';
import orgProfileRoutes from './orgProfile.routes.js';
import transactionRoutes from './transaction.routes.js';
import gatewayRoutes from './gateway.routes.js';
import activityLogRoutes from './activity.routes.js';
import importRoutes from './import.routes.js';
import commentRoutes from './comment.routes.js';
import notificationRoutes from './notification.routes.js';
import optionRoutes from './option.routes.js';
import whatsappTemplateRoutes from './whatsappTemplate.routes.js';
import whatsappConnectionRoutes from './whatsappConnection.routes.js';
import hotelNoteRoutes from './hotelNote.routes.js';
import uploadRoutes from './upload.routes.js';
import { cityRoutes, stateRoutes } from './location.routes.js';
import {
  hotelRoutes,
  hotelPriceRoutes,
  transportRoutes,
  transportPriceRoutes,
  activityRoutes,
  activityPriceRoutes,
} from './services.routes.js';

const router = Router();

router.get('/', (req, res) =>
  res.json({ name: 'Travel CRM API', version: '0.1.0', status: 'ok' })
);

// Outside the tenant wall: login/me handle org themselves; the owner panel is
// deliberately unscoped (its handlers filter by organization explicitly).
router.use('/auth', authRoutes);
router.use('/owner', ownerRoutes);
// Customer-facing document links (quotation / receipt / GST invoice). No auth
// by design — the random token in the URL is the credential, and the handler
// resolves the document's own organization before rendering.
// Website lead ingest — called by a visitor's browser with no account. The token in the path
// is the credential and each handler resolves the organization from it before touching
// anything.
//
// MUST stay above publicDocRoutes: that router ends in a two-segment catch-all
// ('/:kind/:token'), which would otherwise swallow GET /public/r/<code> as a document request
// for a document type called "r" and answer a live short link with "Unknown document type".
router.use('/public', leadIngestRoutes);
router.use('/public', publicDocRoutes);
router.use('/share-links', shareLinkRoutes);

// Everything below runs inside the caller's tenant context — tenantPlugin
// scopes every DB query to req.user's organization (owners are rejected).
router.use(protect, tenantContext);

router.use('/users', userRoutes);
router.use('/teams', teamRoutes);
router.use('/destinations', destinationRoutes);
router.use('/query-sources', querySourceRoutes);
router.use('/tags', tagRoutes);
router.use('/inclusion-exclusions', inclusionExclusionRoutes);
router.use('/queries', requireModule('trips'), queryRoutes);
router.use('/leads', requireModule('leads'), leadRoutes);
router.use('/quotes', requireModule('trips'), quoteRoutes);
// Tasks are a view over comments; gate that sub-path only, not trip comments.
router.use('/comments/tasks', requireModule('tasks'));
router.use('/comments', commentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/options', optionRoutes);
router.use('/lookups', lookupRoutes);
router.use('/reports', requireModule('trips', 'bookings'), reportRoutes);
router.use('/bookings', requireModule('bookings'), bookingRoutes);
router.use('/service-bookings', requireModule('bookings'), serviceBookingRoutes);
router.use('/payments', requireModule('accounting'), paymentRoutes);
router.use('/installments', requireModule('accounting'), installmentRoutes);
router.use('/accounts', requireModule('accounting'), accountRoutes);
router.use('/proforma-invoices', requireModule('accounting'), proformaRoutes);
router.use('/gst-invoices', requireModule('accounting'), gstInvoiceRoutes);
router.use('/whatsapp-templates', requireModule('whatsapp'), whatsappTemplateRoutes);
router.use('/whatsapp-connection', requireModule('whatsapp'), whatsappConnectionRoutes);
router.use('/org-profile', orgProfileRoutes);
router.use('/transactions', requireModule('accounting'), transactionRoutes);
router.use('/gateways', requireModule('accounting'), gatewayRoutes);
router.use('/activity-log', activityLogRoutes);
router.use('/uploads', uploadRoutes);

// Location master data
router.use('/states', stateRoutes);
router.use('/cities', cityRoutes);

// Services / supplier inventory
router.use('/hotels', requireModule('hotels'), hotelRoutes);
router.use('/hotel-notes', requireModule('hotels'), hotelNoteRoutes);
router.use('/hotel-prices', requireModule('hotels'), hotelPriceRoutes);
router.use('/transport-services', requireModule('transport'), transportRoutes);
router.use('/transport-prices', requireModule('transport'), transportPriceRoutes);
router.use('/travel-activities', requireModule('activities'), activityRoutes);
router.use('/travel-activity-prices', requireModule('activities'), activityPriceRoutes);
router.use('/services/import', importRoutes);

export default router;
