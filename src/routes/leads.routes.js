import { Router } from 'express';
import { protect, authorize, can } from '../middleware/auth.js';
import {
  leadReport, recentLeads, leadCampaigns, leadJourney, leadHealth, leadSetup,
} from '../controllers/leadReport.controller.js';
import {
  getCapture, updateCapture, testCapture, getInstall, rotateIngestToken,
} from '../controllers/leadCapture.controller.js';
import {
  previewLink, createLink, listLinks, updateLink, removeLink,
} from '../controllers/trackingLink.controller.js';
import { listAdSpend, saveAdSpend } from '../controllers/adSpend.controller.js';
import {
  getAssignmentSettings, updateAssignmentSettings,
  listRules, createRule, updateRule, removeRule, reorderRules,
  assignmentMeta, simulateAssignment,
  listTeamLoad, updateRepAvailability,
  assignmentLog, reassignLead, runSweep,
} from '../controllers/leadAssignment.controller.js';

// Lead Sources & Assignment. Mounted inside the tenant wall, gated on the `leads` module.
//
// Reading is open to every signed-in role: a salesperson should be able to see where their own
// leads came from, and ownScope already limits them to their own records. WRITING is admin or
// manager (or an explicit leads.edit grant), because these settings do not change one record
// — they silently change where every future enquiry goes, and a mistake is only visible later
// as leads that went to the wrong person or arrived with no source at all.
const router = Router();
router.use(protect);

const edit = [can('leads.edit')];
const assign = [can('leads.assign')];

/* ── Reporting ── */
router.get('/report', leadReport);
router.get('/recent', recentLeads);
router.get('/campaigns', leadCampaigns);
router.get('/health', leadHealth);
router.get('/setup', leadSetup);

/* ── UTM capture ── */
router.get('/capture', authorize('admin', 'manager'), getCapture);
router.patch('/capture', edit, updateCapture);
router.post('/capture/test', authorize('admin', 'manager'), testCapture);
router.get('/capture/install', authorize('admin', 'manager'), getInstall);
router.post('/capture/rotate-token', edit, rotateIngestToken);

/* ── Tracking links ── */
router.get('/tracking-links', listLinks);
router.post('/tracking-links/preview', previewLink);
router.post('/tracking-links', edit, createLink);
router.patch('/tracking-links/:id', edit, updateLink);
router.delete('/tracking-links/:id', edit, removeLink);

/* ── Ad spend ── */
router.get('/ad-spend', listAdSpend);
router.put('/ad-spend', edit, saveAdSpend);

/* ── Assignment ── */
router.get('/assignment/settings', authorize('admin', 'manager'), getAssignmentSettings);
router.patch('/assignment/settings', edit, updateAssignmentSettings);
router.get('/assignment/meta', authorize('admin', 'manager'), assignmentMeta);
// Declared before '/assignment/rules/:id' so "reorder" is not read as a rule id.
router.patch('/assignment/rules/reorder', edit, reorderRules);
router.get('/assignment/rules', authorize('admin', 'manager'), listRules);
router.post('/assignment/rules', edit, createRule);
router.patch('/assignment/rules/:id', edit, updateRule);
router.delete('/assignment/rules/:id', edit, removeRule);
router.post('/assignment/simulate', authorize('admin', 'manager'), simulateAssignment);
router.get('/assignment/team', authorize('admin', 'manager'), listTeamLoad);
router.patch('/assignment/team/:userId', edit, updateRepAvailability);
router.get('/assignment/log', authorize('admin', 'manager'), assignmentLog);
router.post('/assignment/reassign/:queryId', assign, reassignLead);
router.post('/assignment/sweep', authorize('admin', 'manager'), runSweep);

// Last: a bare ':id' would otherwise swallow every path above it.
router.get('/:id/journey', leadJourney);

export default router;
