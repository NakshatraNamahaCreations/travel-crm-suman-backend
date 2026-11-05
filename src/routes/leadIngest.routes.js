import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  trackVisit, submitLead, serveScript, redirectLink, pingToken, formConfig,
} from '../controllers/leadIngest.controller.js';

// PUBLIC lead ingest. Mounted outside the auth and tenant wall — a visitor's browser calls
// these with no account, and the token in the path is the credential.
//
// Everything here is reachable by anyone on the internet, so each route carries its own rate
// limit well below the app-wide one. The limits are per IP: a busy website has many visitors
// but each browser only reports its own visits, so a legitimate client never approaches them,
// while a single machine trying to stuff the lead table is stopped at the door.
const router = Router();

const limit = (max, windowMs, message) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message },
});

// Page views: generous, since a visitor legitimately reports one per page.
const visitLimiter = limit(120, 5 * 60 * 1000, 'Too many visits reported from this address.');
// Form submissions: tight. A person does not fill in ten enquiry forms in five minutes, and
// every one of these creates a real query and messages a real guest.
const leadLimiter = limit(10, 5 * 60 * 1000, 'Too many enquiries from this address. Please try again shortly.');
// The script and the redirect are cheap and cacheable, but still bounded.
const scriptLimiter = limit(300, 5 * 60 * 1000, 'Too many requests.');

router.get('/form/:token', scriptLimiter, formConfig);
router.get('/track/:token/t.js', scriptLimiter, serveScript);
router.get('/track/:token/ping', scriptLimiter, pingToken);
router.post('/track/:token', visitLimiter, trackVisit);
router.post('/leads/:token', leadLimiter, submitLead);
router.get('/r/:code', scriptLimiter, redirectLink);

export default router;
