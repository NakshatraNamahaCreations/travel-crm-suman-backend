import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  clearAll,
} from '../controllers/notification.controller.js';

const router = Router();
router.use(protect);

router.get('/unread-count', unreadCount);
router.get('/', listNotifications);
router.patch('/read-all', markAllRead);
router.delete('/clear-all', clearAll);
router.patch('/:id/read', markRead);
router.delete('/:id', deleteNotification);

export default router;
