const express = require("express");
const router = express.Router();
const mongo = require("../db/mongo");
const { log, err } = require("../utils/logger");

/**
 * Template document shape:
 * {
 *   name: string,
 *   description: string,
 *   prompt: string,
 *   meta: object,            // default meta like owner/repo/repoUrl
 *   defaultFields: object,   // optional other default fields (testCommand, sandboxImage, autoCreatePR)
 *   createdBy, createdAt, updatedAt
 * }
 */

// GET /api/templates  -> list templates
router.get("/", async (req, res) => {
  try {
    const templates = await mongo.findTemplates({}, 200);
    res.json({ success: true, templates });
  } catch (e) {
    err("templates:list error", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/templates/:id
router.get("/:id", async (req, res) => {
  try {
    const t = await mongo.findTemplateById(req.params.id);
    if (!t) return res.status(404).json({ success: false, error: "not found" });
    res.json({ success: true, template: t });
  } catch (e) {
    err("templates:get error", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/templates  -> create
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.prompt) return res.status(400).json({ success: false, error: "name and prompt required" });

    const templateDoc = {
      name: body.name,
      description: body.description || "",
      prompt: body.prompt,
      meta: body.meta || {},
      defaultFields: body.defaultFields || {},
      createdBy: body.createdBy || "ui",
    };
    const id = await mongo.insertTemplate(templateDoc);
    const newT = await mongo.findTemplateById(id);
    res.json({ success: true, template: newT });
  } catch (e) {
    err("templates:create error", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/templates/:id -> update
router.put("/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    if (body.name) update.name = body.name;
    if (body.description) update.description = body.description;
    if (body.prompt) update.prompt = body.prompt;
    if (body.meta) update.meta = body.meta;
    if (body.defaultFields) update.defaultFields = body.defaultFields;
    const updated = await mongo.updateTemplate(req.params.id, update);
    res.json({ success: true, template: updated });
  } catch (e) {
    err("templates:update error", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/templates/:id
router.delete("/:id", async (req, res) => {
  try {
    const ok = await mongo.deleteTemplate(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: "not found" });
    res.json({ success: true });
  } catch (e) {
    err("templates:delete error", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
