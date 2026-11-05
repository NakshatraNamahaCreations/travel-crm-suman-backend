import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import { hotelRate, activityRate, transportRate } from '../controllers/lookup.controller.js';

const router = Router();
router.use(protect);

router.get('/hotel-rate', hotelRate);
router.get('/activity-rate', activityRate);
router.get('/transport-rate', transportRate);

export default router;
