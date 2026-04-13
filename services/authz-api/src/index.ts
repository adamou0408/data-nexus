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
import { configExecRouter } from './routes/config-exec';
import { requireRole, requireAuth } from './middleware/authz';
import { optionalJWT, buildJWTConfig } from './middleware/jwt';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

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

app.listen(PORT, () => {
  console.log(`authz-api listening on http://localhost:${PORT}`);
});
