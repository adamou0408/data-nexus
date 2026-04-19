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
