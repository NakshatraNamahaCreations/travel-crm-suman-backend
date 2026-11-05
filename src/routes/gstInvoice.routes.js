import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import {
  listGstInvoices,
  createGstInvoice,
  updateGstInvoice,
  deleteGstInvoice,
  gstInvoicePdf,
} from '../controllers/gstInvoice.controller.js';

const router = Router();
router.use(protect);

router.get('/', listGstInvoices);
router.post('/', can('invoices.create'), createGstInvoice);
router.get('/:id/pdf', gstInvoicePdf);
router.patch('/:id', can('invoices.edit'), updateGstInvoice);
router.delete('/:id', can('invoices.delete'), deleteGstInvoice);

export default router;
