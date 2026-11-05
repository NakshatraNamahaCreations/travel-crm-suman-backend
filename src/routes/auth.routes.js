import { Router } from 'express';
import { login, logout, me, updateProfile, forgotPassword, resetPassword } from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { protect } from '../middleware/auth.js';
import { loginSchema } from '../validators/auth.validator.js';

const router = Router();

// No public /register — companies are created by the platform owner and the
// owner account is bootstrapped via `npm run bootstrap:owner`.
router.post('/login', validate(loginSchema), login);
router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/me', protect, me);
router.patch('/profile', protect, updateProfile);

export default router;
