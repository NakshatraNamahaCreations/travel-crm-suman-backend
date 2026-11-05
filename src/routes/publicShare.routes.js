import { Router } from 'express';
import { publicDocument, createShareLink, revokeShareLink } from '../controllers/publicShare.controller.js';
import { protect } from '../middleware/auth.js';
import { tenantContext } from '../tenant/middleware.js';

// Unauthenticated: the token in the URL is the credential. Mounted before the
// global protect/tenantContext wall in routes/index.js.
export const publicDocRoutes = Router();
publicDocRoutes.get('/:kind/:token', publicDocument);

// Authenticated: staff mint / revoke the links.
export const shareLinkRoutes = Router();
shareLinkRoutes.use(protect, tenantContext);
shareLinkRoutes.post('/', createShareLink);
shareLinkRoutes.delete('/', revokeShareLink);
