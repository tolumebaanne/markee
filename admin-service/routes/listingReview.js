/**
 * Listing Review — /admin/listing-review/*
 *
 * Comment Template CRUD and Assignment log endpoints.
 * State transitions (approve / disapprove / reject / etc.) live in
 * catalog-service because that service owns the Product model.
 */
const express                  = require('express');
const router                   = express.Router();
const crypto                   = require('crypto');

const ReviewTemplate           = require('../models/ReviewTemplate');
const ReviewAssignment         = require('../models/ReviewAssignment');
const requireAdminAuth         = require('../middleware/requireAdminAuth');
const requireReviewPermission  = require('../middleware/requireReviewPermission');
const sessionActivity          = require('../middleware/sessionActivity');
const auditLog                 = require('../middleware/auditLog');
const errorResponse            = require('../../shared/utils/errorResponse');

router.use(requireAdminAuth, sessionActivity);

// ═══════════════════════════════════════════════════════════════════════════════
// COMMENT TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /admin/listing-review/comment-templates ───────────────────────────────
// Returns all active templates (any reviewer) or all templates (superuser).
router.get('/comment-templates',
  requireReviewPermission('canUseTemplates'),
  async (req, res) => {
    try {
      const filter = req.admin.isSuperuser ? {} : { isActive: true };
      if (req.query.category) filter.category = req.query.category;

      const templates = await ReviewTemplate.model
        .find(filter)
        .select('-__v')
        .sort({ category: 1, title: 1 });

      res.json(templates);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── GET /admin/listing-review/comment-templates/:id ───────────────────────────
router.get('/comment-templates/:id',
  requireReviewPermission('canUseTemplates'),
  async (req, res) => {
    try {
      const t = await ReviewTemplate.model.findById(req.params.id).select('-__v');
      if (!t) return errorResponse(res, 404, 'Template not found');
      res.json(t);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/listing-review/comment-templates — create template ─────────────
router.post('/comment-templates',
  requireReviewPermission('canUseTemplates'),
  auditLog('reviewTemplate.create', 'ReviewTemplate'),
  async (req, res) => {
    const { title, body, category } = req.body;
    if (!title || !title.trim()) return errorResponse(res, 400, 'title required');
    if (!body  || body.trim().length < 10) return errorResponse(res, 400, 'body must be at least 10 characters');

    try {
      const t = await ReviewTemplate.model.create({
        title: title.trim(),
        body:  body.trim(),
        category: (category || '').trim(),
        createdBy: req.admin.id
      });
      res.status(201).json(t);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── PUT /admin/listing-review/comment-templates/:id ───────────────────────────
router.put('/comment-templates/:id',
  requireReviewPermission('canUseTemplates'),
  auditLog('reviewTemplate.update', 'ReviewTemplate'),
  async (req, res) => {
    const { title, body, category, isActive } = req.body;
    if (body !== undefined && body.trim().length < 10) {
      return errorResponse(res, 400, 'body must be at least 10 characters');
    }
    try {
      const t = await ReviewTemplate.model.findById(req.params.id);
      if (!t) return errorResponse(res, 404, 'Template not found');

      const updates = { updatedAt: new Date() };
      if (title    !== undefined) updates.title    = title.trim();
      if (body     !== undefined) updates.body     = body.trim();
      if (category !== undefined) updates.category = category.trim();
      if (isActive !== undefined) updates.isActive = Boolean(isActive);

      const updated = await ReviewTemplate.model.findByIdAndUpdate(
        req.params.id, updates, { new: true }
      );
      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── DELETE /admin/listing-review/comment-templates/:id ────────────────────────
// Superuser only.
router.delete('/comment-templates/:id',
  requireReviewPermission('canUseTemplates'),
  auditLog('reviewTemplate.delete', 'ReviewTemplate'),
  async (req, res) => {
    if (!req.admin.isSuperuser) {
      return errorResponse(res, 403, 'Only the Superuser can permanently delete templates');
    }
    try {
      const t = await ReviewTemplate.model.findByIdAndDelete(req.params.id);
      if (!t) return errorResponse(res, 404, 'Template not found');
      res.json({ success: true });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/listing-review/comment-templates/:id/use ─────────────────────
// Increments usageCount when a reviewer selects a template.
router.post('/comment-templates/:id/use',
  requireReviewPermission('canUseTemplates'),
  async (req, res) => {
    try {
      await ReviewTemplate.model.findByIdAndUpdate(
        req.params.id,
        { $inc: { usageCount: 1 } }
      );
      res.json({ success: true });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// ASSIGNMENT LOG
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /admin/listing-review/assignment-log ───────────────────────────────────
// Paginated history of all assignment actions. Super only.
router.get('/assignment-log',
  async (req, res) => {
    if (!req.admin.isSuperuser) {
      return errorResponse(res, 403, 'Assignment log is Super-only');
    }
    try {
      const page  = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 25);
      const skip  = (page - 1) * limit;

      const filter = {};
      if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
      if (req.query.type)       filter.type       = req.query.type;
      if (req.query.batchId)    filter.batchId    = req.query.batchId;

      const [entries, total] = await Promise.all([
        ReviewAssignment.model
          .find(filter)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit)
          .select('-__v'),
        ReviewAssignment.model.countDocuments(filter)
      ]);

      res.json({ entries, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/listing-review/assignment-log — record a batch action ─────────
// Called internally by catalog-service state machine routes after
// assign / reassign / pullback operations, to persist the audit record.
// Also callable directly from the API if needed.
router.post('/assignment-log',
  async (req, res) => {
    if (!req.admin.isSuperuser) {
      return errorResponse(res, 403, 'Assignment log write is Super-only');
    }
    const { type, assignedTo, listings, note } = req.body;
    if (!type)                    return errorResponse(res, 400, 'type required');
    if (!listings?.length)        return errorResponse(res, 400, 'listings array required');
    if (!['assign','reassign','pullback','return'].includes(type)) {
      return errorResponse(res, 400, 'Invalid type');
    }

    try {
      const entry = await ReviewAssignment.model.create({
        type,
        assignedBy:   req.admin.id,
        assignedTo:   assignedTo || null,
        listings,
        listingCount: listings.length,
        note:         note || '',
        batchId:      crypto.randomBytes(8).toString('hex')
      });
      res.status(201).json(entry);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── GET /admin/listing-review/my-activity ─────────────────────────────────────
// Reviewer's own assignment history — scoped to req.admin.id.
router.get('/my-activity',
  requireReviewPermission('canViewOwnActivityLog'),
  async (req, res) => {
    try {
      const page  = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, parseInt(req.query.limit) || 20);
      const skip  = (page - 1) * limit;

      const [entries, total] = await Promise.all([
        ReviewAssignment.model
          .find({ assignedTo: req.admin.id })
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit)
          .select('-__v'),
        ReviewAssignment.model.countDocuments({ assignedTo: req.admin.id })
      ]);

      res.json({ entries, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

module.exports = router;
