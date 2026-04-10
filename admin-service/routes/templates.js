/**
 * Permission Templates — /admin/templates/*
 *
 * CRUD for permission presets. 9 built-in presets (seeded by bootstrap.js)
 * cannot be deleted but can be used as starting points.
 * Custom templates can be created, edited, and deleted.
 */
const express  = require('express');
const router   = express.Router();

const PermissionTemplate = require('../models/PermissionTemplate');
const requireAdminAuth   = require('../middleware/requireAdminAuth');
const requirePermission  = require('../middleware/requirePermission');
const sessionActivity    = require('../middleware/sessionActivity');
const auditLog           = require('../middleware/auditLog');
const errorResponse      = require('../../shared/utils/errorResponse');

router.use(requireAdminAuth, sessionActivity);

// ── GET /admin/templates ──────────────────────────────────────────────────────
router.get('/', requirePermission('auth', 'read'), async (req, res) => {
  try {
    const templates = await PermissionTemplate.model
      .find()
      .select('-__v')
      .sort({ isBuiltIn: -1, name: 1 });
    res.json(templates);
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/templates/:id ──────────────────────────────────────────────────
router.get('/:id', requirePermission('auth', 'read'), async (req, res) => {
  try {
    const t = await PermissionTemplate.model.findById(req.params.id);
    if (!t) return errorResponse(res, 404, 'Template not found');
    res.json(t);
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── POST /admin/templates — create custom template ────────────────────────────
router.post('/',
  requirePermission('auth', 'write'),
  auditLog('template.create', 'PermissionTemplate'),
  async (req, res) => {
    const { name, description, permissions } = req.body;
    if (!name) return errorResponse(res, 400, 'name required');
    if (!permissions) return errorResponse(res, 400, 'permissions required');
    try {
      const t = await PermissionTemplate.model.create({
        name,
        description: description || '',
        isBuiltIn: false,
        permissions,
        createdBy: req.admin.id
      });
      res.status(201).json(t);
    } catch (err) {
      if (err.code === 11000) return errorResponse(res, 409, 'Template name already exists');
      errorResponse(res, 500, err.message);
    }
  }
);

// ── PUT /admin/templates/:id — update a custom template ──────────────────────
router.put('/:id',
  requirePermission('auth', 'write'),
  auditLog('template.update', 'PermissionTemplate'),
  async (req, res) => {
    try {
      const t = await PermissionTemplate.model.findById(req.params.id);
      if (!t) return errorResponse(res, 404, 'Template not found');
      if (t.isBuiltIn && !req.admin.isSuperuser) {
        return errorResponse(res, 403, 'Built-in templates can only be modified by the Superuser');
      }
      const updated = await PermissionTemplate.model.findByIdAndUpdate(
        req.params.id,
        { ...req.body, isBuiltIn: t.isBuiltIn, updatedAt: new Date() },
        { new: true }
      );
      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── DELETE /admin/templates/:id ───────────────────────────────────────────────
router.delete('/:id',
  requirePermission('auth', 'write'),
  auditLog('template.delete', 'PermissionTemplate'),
  async (req, res) => {
    try {
      const t = await PermissionTemplate.model.findById(req.params.id);
      if (!t) return errorResponse(res, 404, 'Template not found');
      if (t.isBuiltIn) return errorResponse(res, 403, 'Built-in templates cannot be deleted');
      await PermissionTemplate.model.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

module.exports = router;
