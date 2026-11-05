import { Router } from 'express';
import { listOptions, optionUsage, createOption, updateOption, bulkDeleteUnused, deleteOption } from '../controllers/option.controller.js';
import { protect, authorize } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/', listOptions);
router.get('/usage', optionUsage);
router.post('/', createOption); // any authenticated user can add an option inline
router.post('/bulk-delete-unused', authorize('admin', 'manager'), bulkDeleteUnused);
router.patch('/:id', authorize('admin', 'manager'), updateOption);
router.delete('/:id', authorize('admin', 'manager'), deleteOption);

export default router;
