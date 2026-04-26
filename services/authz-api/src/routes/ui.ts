import { Router } from 'express';
import { pool } from '../db';
import { handleApiError } from '../lib/request-helpers';

/**
 * Generic UI metadata endpoints.
 * Descriptors are page-agnostic — any component can fetch its section
 * definitions by page_id from authz_ui_descriptor.
 */
export const uiRouter = Router();

// GET /api/ui/descriptors/:page_id — UI descriptors for any page
uiRouter.get('/descriptors/:page_id', async (req, res) => {
  const pageId = req.params.page_id;

  // SEC: validate page_id format (prevent SQL injection via invalid identifiers)
  if (!/^[a-z][a-z0-9_]*$/.test(pageId)) {
    return res.status(400).json({ error: 'Invalid page_id format' });
  }

  try {
    const result = await pool.query(
      'SELECT fn_ui_descriptors($1) AS descriptors',
      [pageId]
    );
    res.json(result.rows[0]?.descriptors || []);
  } catch (err) {
    handleApiError(res, err);
  }
});

// GET /api/ui/render-tokens — Tier B Curator-owned UI tokens (V053).
// Returns active rows from authz_ui_render_token grouped by category:
//   { icon: { 'package': 'Package', ... },
//     status_color: { 'active': 'bg-emerald-100 text-emerald-700', ... },
//     phase_color: { ... }, gate_color: { ... } }
// Frontend caches once at app mount; falls back to hardcoded defaults if
// this endpoint fails (so the UI never breaks on missing tokens).
uiRouter.get('/render-tokens', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT category, token_key, value
         FROM authz_ui_render_token
        WHERE is_active = TRUE
        ORDER BY category, sort_order, token_key`
    );
    const tokens: Record<string, Record<string, string>> = {};
    for (const row of result.rows) {
      if (!tokens[row.category]) tokens[row.category] = {};
      tokens[row.category][row.token_key] = row.value;
    }
    res.json(tokens);
  } catch (err) {
    handleApiError(res, err);
  }
});
