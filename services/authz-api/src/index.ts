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
import { datasourceRouter, listDataSourcesLite } from './routes/datasource';
import { aiProviderRouter, listAIProvidersLite } from './routes/ai-provider';
import { aiAssistRouter } from './routes/ai-assist';
import { oracleExecRouter } from './routes/oracle-exec';
import { dataQueryRouter } from './routes/data-query';
import { dagRouter } from './routes/dag';
import { discoverRouter } from './routes/discover';
import { configExecRouter } from './routes/config-exec';
import { configSnapshotRouter } from './routes/config-snapshot';
import { configBulkRouter } from './routes/config-bulk';
import { modulesRouter } from './routes/modules';
import { uiRouter } from './routes/ui';
import { workflowRouter } from './routes/workflow';
import { savedViewRouter } from './routes/saved-view';
import { feedbackRouter } from './routes/feedback';
import { businessTermRouter } from './routes/business-term';
import { requireRole, requireAuth } from './middleware/authz';
import { optionalJWT, buildJWTConfig } from './middleware/jwt';
import { verifyCryptoKey } from './lib/crypto';
import { startResourceEventListener } from './lib/resource-events';
import { startPolicyEventListener } from './lib/policy-events';

// SEC-06e: refuse to boot in production with missing critical secrets, so a
// misconfigured pod fails fast at startup instead of running with predictable
// dev defaults (and silently encrypting data with the dev fallback key).
function validateProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const required: Array<[string, string]> = [
    ['ENCRYPTION_KEY', 'AES-256 key for connector_password ciphertext (64-char hex)'],
    ['DB_PASSWORD', 'AuthZ store password (nexus_authz)'],
  ];
  const missing = required.filter(([k]) => !process.env[k] || process.env[k] === '');
  if (missing.length > 0) {
    const lines = missing.map(([k, why]) => `  - ${k}: ${why}`).join('\n');
    throw new Error(
      `[STARTUP] Refusing to boot in production with missing secrets:\n${lines}\n` +
      'See docs/deployment-checklist.md.'
    );
  }
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length !== 64) {
    throw new Error('[STARTUP] ENCRYPTION_KEY must be exactly 64 hex chars (256-bit).');
  }
}

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
app.use('/api/browse', requireRole('AUTHZ_ADMIN'), browseAdminRouter);

// Config-Driven UI (requires auth — fine-grained checks done internally)
app.use('/api/config-exec', requireAuth, configExecRouter);

// V083 admin APIs (matrix: docs/role-permission-matrix.md)
//   pool / datasources / ai-providers / discover / business-term / modules-write / feedback-inbox → DATA_STEWARD
//   browse-admin / config-snapshot / config-bulk / ai-assist (DDL) → AUTHZ_ADMIN
//   SYSADMIN bypass handled inside requireRole() (allow-side short-circuit).
app.use('/api/pool', requireRole('DATA_STEWARD'), poolRouter);
// Datasource lite list — any authenticated user (Flow Composer, Data Query need DS picker).
// Must be registered BEFORE the admin-gated mount so Express matches it first.
app.get('/api/datasources/list', requireAuth, listDataSourcesLite);
app.use('/api/datasources', requireRole('DATA_STEWARD'), datasourceRouter);
// AI providers lite list — any authenticated user (sidebar copilot needs to pick a provider).
// Registered BEFORE the admin-gated mount so Express matches it first.
app.get('/api/ai-providers/list', requireAuth, listAIProvidersLite);
app.use('/api/ai-providers', requireRole('DATA_STEWARD'), aiProviderRouter);
// AI-assisted authoring (dogfood): draft / refine / explain PG functions.
// AUTHZ_ADMIN-gated to mirror function deploy permissions; Constitution §11.3
// keeps Deploy human-clicked, so this endpoint never executes generated SQL.
app.use('/api/ai-assist', requireRole('AUTHZ_ADMIN', 'DATA_STEWARD'), aiAssistRouter);
// Modules: read open to all authenticated users (per-resource authz_check inside),
// write operations (DELETE) protected by requireRole inside the router
app.use('/api/modules', requireAuth, modulesRouter);
// UI metadata (descriptors) — any authenticated user can fetch
app.use('/api/ui', requireAuth, uiRouter);
app.use('/api/oracle-exec', requireAuth, oracleExecRouter);
app.use('/api/data-query', requireAuth, dataQueryRouter);
app.use('/api/dag', requireAuth, dagRouter);
app.use('/api/discover', requireRole('DATA_STEWARD'), discoverRouter);

// Composite-action workflow runtime (V075 + V076). requireAuth lives inside
// the router; per-decision gating uses authz_check + chain-step role match.
app.use('/api/workflow', workflowRouter);

// Tier A primitive #2: per-user saved view CRUD (V080). Self-scope only —
// every query filters on user_id = current user; cross-user 404.
app.use('/api/saved-view', requireAuth, savedViewRouter);

// Tier A primitive #3: per-user feedback (V082). POST/GET-mine for any
// authenticated user; GET /inbox + PATCH /:id/status are gated by
// requireRole('DATA_STEWARD') inside the router (V083 curator surface).
app.use('/api/feedback', requireAuth, feedbackRouter);

// Tier A gate-prep: business-term admin (V044 semantic-layer columns on
// authz_resource). DATA_STEWARD-only per V083 (curator workflow under Govern).
// Closes the schema-without-tooling gap that blocks §3.4 C primitive's
// blessed_term ≥ 10 gate.
app.use('/api/business-term', requireRole('DATA_STEWARD'), businessTermRouter);

// Config snapshot & bulk import — AUTHZ_ADMIN per V083 (Govern stage).
app.use('/api/config/snapshot', requireRole('AUTHZ_ADMIN'), configSnapshotRouter);
app.use('/api/config/bulk', requireRole('AUTHZ_ADMIN'), configBulkRouter);

validateProductionEnv();

app.listen(PORT, () => {
  verifyCryptoKey();
  startResourceEventListener();
  startPolicyEventListener();
  console.log(`authz-api listening on http://localhost:${PORT}`);
});
