import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import {
  listOrganizations,
  createOrganization,
  getOrganization,
  updateOrganization,
  recordSubscriptionPayment,
  listPlans,
  createPlan,
  updatePlan,
  listModules,
  getOrgWhatsapp,
  connectOrgWhatsapp,
  getOrgWhatsappQr,
  disconnectOrgWhatsapp,
  removeOrgWhatsapp,
} from '../controllers/owner.controller.js';
import { platformOverview } from '../controllers/ownerOverview.controller.js';

// Platform-owner panel. NOT tenant-scoped — mounted before the tenantContext
// middleware in routes/index.js and restricted to the 'owner' role.
const router = Router();
router.use(protect, authorize('owner'));

router.get('/overview', platformOverview);
router.get('/modules', listModules);

router.get('/organizations', listOrganizations);
router.post('/organizations', createOrganization);
router.get('/organizations/:id', getOrganization);
router.patch('/organizations/:id', updateOrganization);
router.post('/organizations/:id/subscription', recordSubscriptionPayment);

// A company's own WhatsApp number, linked by the owner on its behalf. Each runs inside that
// company's tenant context, so the session belongs to it and not to the platform.
router.get('/organizations/:id/whatsapp', getOrgWhatsapp);
router.get('/organizations/:id/whatsapp/qr', getOrgWhatsappQr);
router.post('/organizations/:id/whatsapp/connect', connectOrgWhatsapp);
router.post('/organizations/:id/whatsapp/disconnect', disconnectOrgWhatsapp);
router.delete('/organizations/:id/whatsapp', removeOrgWhatsapp);

router.get('/plans', listPlans);
router.post('/plans', createPlan);
router.patch('/plans/:id', updatePlan);

export default router;
