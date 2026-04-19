import express from 'express';
import cors from 'cors';
import { pool } from './db';
import { resolveRouter } from './routes/resolve';
import { checkRouter } from './routes/check';
import { filterRouter } from './routes/filter';
import { matrixRouter } from './routes/matrix';
import { rlsRouter } from './routes/rls-simulate';
import { browseReadRouter } from './routes/browse-read';
import { browseAdminRouter } from './routes/browse-admin';
import { poolRouter } from './routes/pool';
import { datasourceRouter } from './routes/datasource';
import { oracleExecRouter } from './routes/oracle-exec';
import { configExecRouter } from './routes/config-exec';
import { configSnapshotRouter } from './routes/config-snapshot';
import { configBulkRouter } from './routes/config-bulk';
import { modulesRouter } from './routes/modules';
import { uiRouter } from './routes/ui';
import { requireRole, requireAuth } from './middleware/authz';
import { optionalJWT, buildJWTConfig } from './middleware/jwt';
import { verifyCryptoKey } from './lib/crypto';
import { startResourceEventListener } from './lib/resource-events';

const app = express();
const PORT = parseInt(process.env.PORT || '13001');

app.use(cors());
app.use(express.json());

// JWT/OIDC authentication — validates Bearer tokens when JWT_ISSUER is set,
// otherwise skips (dev mode fallback to X-User-Id headers)
app.use(optionalJWT(buildJWTConfig()));

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', message: String(err) });
  }
});

// Public APIs (no auth required for POC — dashboard calls these directly)
app.use('/api/resolve', resolveRouter);
app.use('/api/check', checkRouter);
app.use('/api/filter', filterRouter);
app.use('/api/matrix', matrixRouter);
app.use('/api/rls', rlsRouter);
app.use('/api/browse', browseReadRouter);
app.use('/api/browse', requireRole('ADMIN', 'AUTHZ_ADMIN'), browseAdminRouter);

// Config-Driven UI (requires auth — fine-grained checks done internally)
app.use('/api/config-exec', requireAuth, configExecRouter);

// Admin APIs (require ADMIN or AUTHZ_ADMIN role via X-User-Id header)
app.use('/api/pool', requireRole('ADMIN', 'AUTHZ_ADMIN', 'DBA'), poolRouter);
app.use('/api/datasources', requireRole('ADMIN', 'AUTHZ_ADMIN', 'DBA'), datasourceRouter);
// Modules: read open to all authenticated users (per-resource authz_check inside),
// write operations (DELETE) protected by requireRole inside the router
app.use('/api/modules', requireAuth, modulesRouter);
// UI metadata (descriptors) — any authenticated user can fetch
app.use('/api/ui', requireAuth, uiRouter);
app.use('/api/oracle-exec', requireAuth, oracleExecRouter);

// Config snapshot & bulk import (admin-only)
app.use('/api/config/snapshot', requireRole('ADMIN', 'AUTHZ_ADMIN'), configSnapshotRouter);
app.use('/api/config/bulk', requireRole('ADMIN', 'AUTHZ_ADMIN'), configBulkRouter);

app.listen(PORT, () => {
  verifyCryptoKey();
  startResourceEventListener();
  console.log(`authz-api listening on http://localhost:${PORT}`);
});
