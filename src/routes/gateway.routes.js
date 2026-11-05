import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import {
  listGateways,
  createGateway,
  listGatewayTransactions,
  gatewaySummary,
} from '../controllers/gateway.controller.js';

const router = Router();
router.use(protect);

router.get('/', listGateways);
router.get('/transactions', listGatewayTransactions);
router.get('/summary', gatewaySummary);
router.post('/', authorize('admin', 'manager', 'accounts'), createGateway);

export default router;
