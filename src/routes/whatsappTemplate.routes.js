import { Router } from 'express';
import { protect, can } from '../middleware/auth.js';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  removeTemplate,
  templateMeta,
  seedDefaults,
  duplicateTemplate,
} from '../controllers/whatsappTemplate.controller.js';

// WhatsApp message templates. Mounted behind requireModule('whatsapp') in
// routes/index.js; writes additionally need the whatsapp.* permissions.
const router = Router();
router.use(protect);

router.get('/meta', templateMeta);
router.post('/seed-defaults', can('whatsapp.create'), seedDefaults);

router.get('/', listTemplates);
router.post('/', can('whatsapp.create'), createTemplate);
router.get('/:id', getTemplate);
router.put('/:id', can('whatsapp.edit'), updateTemplate);
router.delete('/:id', can('whatsapp.delete'), removeTemplate);
router.post('/:id/duplicate', can('whatsapp.create'), duplicateTemplate);

export default router;
