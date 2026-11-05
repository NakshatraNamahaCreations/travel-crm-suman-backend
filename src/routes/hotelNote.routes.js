import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import { listHotelNotes, createHotelNote, updateHotelNote, deleteHotelNote } from '../controllers/hotelNote.controller.js';

const router = Router();
router.use(protect);

router.get('/', listHotelNotes);
router.post('/', createHotelNote);
router.patch('/:id', updateHotelNote);
router.delete('/:id', deleteHotelNote);

export default router;
