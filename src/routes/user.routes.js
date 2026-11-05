import { Router } from 'express';
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  setUserStatus,
  deleteUser,
} from '../controllers/user.controller.js';
import { protect, authorize, can } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/', listUsers);
router.get('/:id', getUser);
router.post('/', can('users.create'), createUser);
router.put('/:id', can('users.edit'), updateUser);
router.patch('/:id/status', authorize('admin'), setUserStatus);
router.delete('/:id', authorize('admin'), deleteUser);

export default router;
