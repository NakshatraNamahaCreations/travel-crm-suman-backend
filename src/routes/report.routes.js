import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import { salesReport, salesBreakdown, dashboard, tripsReport, tripCheckInOutReport } from '../controllers/report.controller.js';

const router = Router();
router.use(protect);

router.get('/sales', salesReport);
router.get('/sales/breakdown', salesBreakdown);
router.get('/dashboard', dashboard);
router.get('/trips', tripsReport);
router.get('/trip-check-in-out', tripCheckInOutReport);

export default router;
