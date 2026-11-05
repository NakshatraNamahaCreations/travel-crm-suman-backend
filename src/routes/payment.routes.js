import { Router } from 'express';
import {
  listPayments,
  paymentsSummary,
  createPayment,
  updatePayment,
  deletePayment,
  supplierLedger,
} from '../controllers/payment.controller.js';
import { protect, can } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/summary', paymentsSummary);
router.get('/supplier-ledger', supplierLedger);
router.get('/', listPayments);
router.post('/', can('payments.create'), createPayment);
router.patch('/:id', can('payments.create'), updatePayment);
router.delete('/:id', can('payments.cancel'), deletePayment);

export default router;
