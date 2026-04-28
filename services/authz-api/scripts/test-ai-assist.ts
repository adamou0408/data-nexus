// Integration smoke test for /api/ai-assist (dogfood, AC-10).
//
// Spins up a fake OpenAI-compatible chat endpoint on a random port, inserts a
// temporary `ai:_test_authoring` provider pointing at it, then exercises the
// three live ai-assist endpoints against the running authz-api process.
//
// Usage:
//   1) Make sure authz-api is running on http://localhost:13001
//   2) From repo root: npx tsx services/authz-api/scripts/test-ai-assist.ts
//
// Cleans up the test provider + every authz_ai_usage / authz_admin_audit_log
// row it created before exiting.

import express from 'express';
import { Server } from 'http';
import { Pool } from 'pg';

const API_BASE = process.env.AUTHZ_API_BASE || 'http://localhost:13001';
const TEST_PROVIDER_ID = 'ai:_test_authoring';
const FAKE_MODEL = 'fake-gpt-test';
const TEST_USER = process.env.TEST_USER || 'adam_ou';
const TEST_GROUPS = process.env.TEST_GROUPS || 'AUTHZ_ADMIN';
// pg connect uses the same env layout as services/authz-api/src/db.ts.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '15432'),
  database: process.env.DB_NAME || 'nexus_authz',
  user: process.env.DB_USER || 'nexus_admin',
  password: process.env.DB_PASSWORD || 'nexus_dev_password',
});

const FAKE_SQL = `\`\`\`sql
CREATE OR REPLACE FUNCTION public.fn_ai_smoke(p_key text)
RETURNS TABLE(col_a text, col_b numeric)
LANGUAGE sql STABLE AS $$
  SELECT 'sample'::text, 1::numeric WHERE p_key IS NOT NULL
$$;
\`\`\``;

function startFakeProvider(): Promise<{ url: string; close: () => Promise<void>; calls: number; lastBody: any }> {
  return new Promise((resolve) => {
    let calls = 0;
    let lastBody: any = null;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.post('/chat/completions', (req, res) => {
      calls += 1;
      lastBody = req.body;
      const isExplain = req.body?.messages?.[1]?.content?.includes('Explain this PostgreSQL function');
      const content = isExplain
        ? '## Purpose\nSmoke-test stub.\n## Parameters\n- p_key text\n## Returns\nTABLE(col_a text, col_b numeric)\n## Notes\nfake provider response.\n## Test Query\n`SELECT * FROM public.fn_ai_smoke(\'X\');`'
        : FAKE_SQL;
      res.json({
        id: 'chatcmpl-fake',
        model: req.body?.model ?? FAKE_MODEL,
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 50, completion_tokens: 75 },
      });
    });
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls: 0,
        lastBody: null,
        close: () => new Promise<void>((r) => server.close(() => r())),
        get calls() { return calls; },
        get lastBody() { return lastBody; },
      } as any);
    });
  });
}

async function ensureProvider(baseUrl: string) {
  await pool.query(`DELETE FROM authz_ai_provider WHERE provider_id = $1`, [TEST_PROVIDER_ID]);
  await pool.query(
    `INSERT INTO authz_ai_provider (
       provider_id, display_name, provider_kind, base_url,
       default_model, available_models, default_temperature, default_max_tokens,
       timeout_ms, pricing, purpose_tags, is_active, registered_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12)`,
    [
      TEST_PROVIDER_ID,
      'AI Authoring (smoke test)',
      'custom_oai',
      baseUrl,
      FAKE_MODEL,
      [FAKE_MODEL],
      0.2,
      512,
      10000,
      JSON.stringify({ [FAKE_MODEL]: { input: 1.0, output: 2.0 } }),
      ['sql_authoring', 'chat'],
      'smoke-test',
    ],
  );
}

async function cleanupProvider() {
  await pool.query(`DELETE FROM authz_ai_usage WHERE provider_id = $1`, [TEST_PROVIDER_ID]);
  await pool.query(`DELETE FROM authz_admin_audit_log WHERE resource_id = $1 AND action LIKE 'AI_ASSIST_%'`, [TEST_PROVIDER_ID]);
  await pool.query(`DELETE FROM authz_ai_provider WHERE provider_id = $1`, [TEST_PROVIDER_ID]);
}

async function call(path: string, body: unknown) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': TEST_USER,
      'X-User-Groups': TEST_GROUPS,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep as text */ }
  return { status: r.status, json, text };
}

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`✗ ASSERT: ${msg}`);
    process.exitCode = 1;
    throw new Error(`assert failed: ${msg}`);
  }
  console.log(`✓ ${msg}`);
}

async function pickDataSource(): Promise<string> {
  // Use any active DS — schema context is best-effort and falls back gracefully.
  const r = await pool.query(`SELECT source_id FROM authz_data_source WHERE is_active = TRUE ORDER BY source_id LIMIT 1`);
  if (r.rows.length === 0) throw new Error('No active data source found — seed one before running smoke test.');
  return r.rows[0].source_id;
}

async function main() {
  console.log(`[smoke] API target: ${API_BASE}`);
  const fake = await startFakeProvider();
  console.log(`[smoke] fake provider: ${fake.url}`);
  await ensureProvider(fake.url);
  const dsId = await pickDataSource();
  console.log(`[smoke] using data source: ${dsId}`);

  try {
    // ─── draft ─────────────────────────────────────────
    const draft = await call('/api/ai-assist/function-draft', {
      data_source_id: dsId,
      prompt: 'smoke test: a function that returns sample rows for a key',
    });
    assert(draft.status === 200, `draft returns 200 (got ${draft.status}: ${draft.text.slice(0, 200)})`);
    assert(draft.json?.sql?.includes('CREATE OR REPLACE FUNCTION'), 'draft response contains CREATE OR REPLACE FUNCTION');
    assert(draft.json?.provider_id === TEST_PROVIDER_ID, 'draft response provider_id matches');
    assert(draft.json?.model_id === FAKE_MODEL, 'draft response model_id matches');
    assert(typeof draft.json?.usage?.latency_ms === 'number', 'draft response includes usage.latency_ms');

    // ─── refine ────────────────────────────────────────
    const refine = await call('/api/ai-assist/function-refine', {
      data_source_id: dsId,
      current_sql: draft.json.sql,
      instruction: 'add a LIMIT 100 clause',
    });
    assert(refine.status === 200, `refine returns 200 (got ${refine.status}: ${refine.text.slice(0, 200)})`);
    assert(refine.json?.sql?.includes('CREATE OR REPLACE FUNCTION'), 'refine response contains CREATE OR REPLACE FUNCTION');

    // ─── explain ───────────────────────────────────────
    const explain = await call('/api/ai-assist/function-explain', { sql: draft.json.sql });
    assert(explain.status === 200, `explain returns 200 (got ${explain.status}: ${explain.text.slice(0, 200)})`);
    assert(explain.json?.markdown?.includes('## Purpose'), 'explain response contains "## Purpose" heading');

    // ─── ledger checks ─────────────────────────────────
    const usageRows = await pool.query(
      `SELECT status, model_id, prompt_tokens, completion_tokens, feature_tag
         FROM authz_ai_usage
        WHERE provider_id = $1
          AND called_at > now() - interval '5 minutes'
        ORDER BY usage_id DESC`,
      [TEST_PROVIDER_ID],
    );
    assert(usageRows.rows.length >= 3, `authz_ai_usage has >= 3 rows for this provider (saw ${usageRows.rows.length})`);
    assert(usageRows.rows.every((r: any) => r.status === 'ok'), 'every usage row status=ok');
    assert(usageRows.rows.every((r: any) => r.feature_tag === 'pg_function_authoring'), 'every usage row feature_tag=pg_function_authoring');
    assert(usageRows.rows.every((r: any) => r.prompt_tokens === 50 && r.completion_tokens === 75), 'usage rows record token counts from provider response');

    const auditRows = await pool.query(
      `SELECT action, actor_type, agent_id, model_id, consent_given
         FROM authz_admin_audit_log
        WHERE resource_id = $1
          AND timestamp > now() - interval '5 minutes'
        ORDER BY id DESC`,
      [TEST_PROVIDER_ID],
    );
    const actions = auditRows.rows.map((r: any) => r.action);
    assert(actions.includes('AI_ASSIST_FUNCTION_DRAFT'), 'audit log has AI_ASSIST_FUNCTION_DRAFT');
    assert(actions.includes('AI_ASSIST_FUNCTION_REFINE'), 'audit log has AI_ASSIST_FUNCTION_REFINE');
    assert(actions.includes('AI_ASSIST_FUNCTION_EXPLAIN'), 'audit log has AI_ASSIST_FUNCTION_EXPLAIN');
    assert(auditRows.rows.every((r: any) => r.actor_type === 'ai_agent'), 'audit rows actor_type=ai_agent');
    assert(auditRows.rows.every((r: any) => r.agent_id === TEST_PROVIDER_ID), 'audit rows agent_id matches provider');
    assert(auditRows.rows.every((r: any) => r.consent_given === 'human_explicit'), 'audit rows consent_given=human_explicit');

    // ─── destructive guard ─────────────────────────────
    // Hot-swap fake provider to return a DROP statement. Easiest path: tear
    // the existing fake down and start a new one that emits a destructive
    // payload, then point the test provider at the new URL.
    await fake.close();
    const malicious = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const app = express();
      app.use(express.json());
      app.post('/chat/completions', (_req, res) => {
        res.json({
          id: 'chatcmpl-mal',
          model: FAKE_MODEL,
          choices: [{ message: { role: 'assistant', content: '```sql\nDROP TABLE public.azf_file;\n```' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        });
      });
      const s: Server = app.listen(0, '127.0.0.1', () => {
        const port = (s.address() as any).port;
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => s.close(() => r())) });
      });
    });
    await pool.query(`UPDATE authz_ai_provider SET base_url = $1 WHERE provider_id = $2`, [malicious.url, TEST_PROVIDER_ID]);
    const blocked = await call('/api/ai-assist/function-draft', { data_source_id: dsId, prompt: 'test destructive guard' });
    assert(blocked.status === 422, `destructive output rejected with 422 (got ${blocked.status})`);
    assert(/DROP/i.test(String(blocked.json?.detail || '')), 'destructive guard mentions DROP keyword in detail');
    await malicious.close();

    // ─── no-provider 503 ───────────────────────────────
    await pool.query(`UPDATE authz_ai_provider SET is_active = FALSE WHERE provider_id = $1`, [TEST_PROVIDER_ID]);
    const noProv = await call('/api/ai-assist/function-explain', { sql: draft.json.sql });
    assert(noProv.status === 503, `no-provider returns 503 (got ${noProv.status})`);

    console.log('\n[smoke] ✅ all assertions passed');
  } finally {
    await cleanupProvider();
    await pool.end().catch(() => {});
    console.log('[smoke] cleanup done');
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
