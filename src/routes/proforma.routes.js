import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import {
  listProformaInvoices,
  createProformaInvoice,
  updateProformaInvoice,
  deleteProformaInvoice,
  proformaPdf,
} from '../controllers/proforma.controller.js';

const router = Router();
router.use(protect);

router.get('/', listProformaInvoices);
router.post('/', can('invoices.create'), createProformaInvoice);
router.get('/:id/pdf', proformaPdf);
router.patch('/:id', can('invoices.edit'), updateProformaInvoice);
router.delete('/:id', can('invoices.delete'), deleteProformaInvoice);

export default router;
