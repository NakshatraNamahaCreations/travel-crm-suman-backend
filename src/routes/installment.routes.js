import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import {
  listInstallments,
  installmentSummary,
  accountOptions,
  createInstallment,
  logPayment,
  editPayment,
  undoPayment,
  receiptPdf,
  sendPaymentTemplate,
  verifyInstallment,
  addComment,
  deleteInstallment,
} from '../controllers/installment.controller.js';

const router = Router();
router.use(protect);

router.get('/', listInstallments);
router.get('/summary', installmentSummary);
router.get('/accounts', accountOptions);
router.post('/', createInstallment);
router.post('/:id/log-payment', logPayment);
router.patch('/:id/payment', authorize('admin'), editPayment);
router.delete('/:id/payment', authorize('admin'), undoPayment);
router.get('/:id/receipt', receiptPdf);
router.post('/:id/whatsapp-template', sendPaymentTemplate);
router.patch('/:id/verify', authorize('admin'), verifyInstallment);
router.post('/:id/comments', addComment);
router.delete('/:id', deleteInstallment);

export default router;
