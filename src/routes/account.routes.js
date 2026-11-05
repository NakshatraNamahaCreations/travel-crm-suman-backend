import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
} from '../controllers/account.controller.js';

const router = Router();
router.use(protect);

// Fine-grained: admins/managers hold every key by default, so this keeps
// the previous access while letting it be granted per user.
const W = (k) => can(k);

router.get('/', listAccounts);
router.get('/:id', getAccount);
router.post('/', W('accounting.create'), createAccount);
router.patch('/:id', W('accounting.edit'), updateAccount);
router.delete('/:id', W('accounting.delete'), deleteAccount);

export default router;
