import { Router } from 'express';
import { listComments, listTasks, createComment, updateComment, deleteComment } from '../controllers/comment.controller.js';
import { protect } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/tasks', listTasks);
router.get('/', listComments);
router.post('/', createComment);
router.patch('/:id', updateComment);
router.delete('/:id', deleteComment);

export default router;
