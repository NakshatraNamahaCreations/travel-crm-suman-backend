import { Router } from 'express';
import {
  listQuotes,
  getQuote,
  createQuote,
  updateQuote,
  reviseQuote,
  updateQuoteStatus,
  deleteQuote,
  quotePdf,
  quoteVoucher,
  emailQuote,
  shareEmail,
  emailStatus,
  whatsappStatus,
  shareWhatsApp,
  quoteSuggestions,
  cloneQuote,
} from '../controllers/quote.controller.js';
import { protect, authorize, can } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/email-status', emailStatus);
router.get('/whatsapp-status', whatsappStatus);
router.get('/suggestions', quoteSuggestions);
router.get('/', listQuotes);
router.post('/:id/clone', cloneQuote);
router.get('/:id', getQuote);
router.get('/:id/pdf', quotePdf);
router.get('/:id/voucher', quoteVoucher);
router.post('/:id/email', emailQuote);
router.post('/:id/share-email', shareEmail);
router.post('/:id/whatsapp-share', shareWhatsApp);
router.post('/', can('quotes.create'), createQuote);
router.put('/:id', can('quotes.edit'), updateQuote);
router.post('/:id/revise', can('quotes.edit'), reviseQuote);
router.patch('/:id/status', updateQuoteStatus);
router.delete('/:id', can('quotes.delete'), deleteQuote);

export default router;
