import { Router } from 'express';
import {
  listBookings,
  getBooking,
  createFromQuote,
  updateBookingStatus,
  deleteBooking,
  updateInstalmentSchedule,
  addBookingExtra,
  removeBookingExtra,
} from '../controllers/booking.controller.js';
import {
  hotelBookings,
  hotelCheckins,
  operationalBookings,
  quoteBookingsDiff,
} from '../controllers/bookingViews.controller.js';
import { protect, can, authorize } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/', listBookings);
// Derived views (must precede '/:id').
router.get('/views/hotels', hotelBookings);
router.get('/views/hotel-checkins', hotelCheckins);
router.get('/views/operational', operationalBookings);
router.get('/views/quote-diff', quoteBookingsDiff);
router.get('/:id', getBooking);
router.post('/from-quote/:quoteId', can('bookings.create'), createFromQuote);
router.patch('/:id/status', updateBookingStatus);
router.put('/:id/instalment-schedule', updateInstalmentSchedule);
// Extra charges on top of the package — admin only.
router.post('/:id/extras', authorize('admin'), addBookingExtra);
router.delete('/:id/extras/:extraId', authorize('admin'), removeBookingExtra);
router.delete('/:id', can('bookings.cancel'), deleteBooking);

export default router;
