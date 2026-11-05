import { Router } from 'express';
import multer from 'multer';
import {
  listQueries,
  queryStats,
  getQuery,
  createQuery,
  updateQuery,
  updateStatus,
  deleteQuery,
  uploadQueriesCsv,
  sendQueryWhatsAppTemplate,
} from '../controllers/query.controller.js';
import { protect, can } from '../middleware/auth.js';
import { retenant } from '../tenant/middleware.js';
import { validate } from '../middleware/validate.js';
import { createQuerySchema, updateQuerySchema } from '../validators/query.validator.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();
router.use(protect);

router.get('/stats', queryStats);
router.get('/', listQueries);
router.post('/upload-csv', can('trips.create'), upload.single('file'), retenant, uploadQueriesCsv);
router.get('/:id', getQuery);
router.post('/', can('trips.create'), validate(createQuerySchema), createQuery);
router.put('/:id', can('trips.edit'), validate(updateQuerySchema), updateQuery);
router.patch('/:id/status', updateStatus);
router.post('/:id/whatsapp-template', sendQueryWhatsAppTemplate);
router.delete('/:id', can('trips.delete'), deleteQuery);

export default router;
