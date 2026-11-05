import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import {
  getConnection,
  connect,
  getQr,
  disconnect,
  removeConnection,
} from '../controllers/whatsappConnection.controller.js';

// The organization's own linked WhatsApp number. Mounted behind requireModule('whatsapp') in
// routes/index.js. Reading the state is open to anyone in the module (an agent benefits from
// seeing that sending is live); linking or unlinking the company's number changes who every
// guest hears from, so it takes the whatsapp.edit permission.
const router = Router();
router.use(protect);

router.get('/', getConnection);
router.get('/qr', can('whatsapp.edit'), getQr);
router.post('/connect', can('whatsapp.edit'), connect);
router.post('/disconnect', can('whatsapp.edit'), disconnect);
router.delete('/', can('whatsapp.delete'), removeConnection);

export default router;
