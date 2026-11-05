import { Router } from 'express';
import {
  listServiceBookings,
  generateServiceBookings,
  updateServiceBooking,
  deleteServiceBooking,
  generateHotelVoucher,
  getHotelVoucherInfo,
} from '../controllers/serviceBooking.controller.js';
import { protect, can } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/', listServiceBookings);
router.post('/generate', can('bookings.create'), generateServiceBookings);
router.get('/:id/hotel-info', getHotelVoucherInfo);
router.post('/:id/voucher', can('bookings.create'), generateHotelVoucher);
router.patch('/:id', can('bookings.create'), updateServiceBooking);
router.delete('/:id', can('bookings.cancel'), deleteServiceBooking);

export default router;
