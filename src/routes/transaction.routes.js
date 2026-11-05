import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import {
  listTransactions,
  transactionsSummary,
  createTransaction,
  deleteTransaction,
} from '../controllers/transaction.controller.js';

const router = Router();
router.use(protect);

// Fine-grained: admins/managers hold every key by default, so this keeps
// the previous access while letting it be granted per user.
const W = (k) => can(k);

router.get('/', listTransactions);
router.get('/summary', transactionsSummary);
router.post('/', W('accounting.create'), createTransaction);
router.delete('/:id', W('accounting.delete'), deleteTransaction);

export default router;
