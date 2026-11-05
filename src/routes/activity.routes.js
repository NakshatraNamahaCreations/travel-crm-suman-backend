import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import { listActivities } from '../controllers/activity.controller.js';

const router = Router();
router.use(protect);

router.get('/', listActivities);

export default router;
