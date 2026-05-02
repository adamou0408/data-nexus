// Offline capability eval for the configured LLM provider.
//
// Unlike test-ai-assist.ts (which uses a fake provider to exercise the route
// plumbing), this script hits the *real* provider currently routed for
// purpose=sql_authoring. It runs a curated capability set and grades each
// output against the same FN-QUALITY-LINT rules the curator sees in the
// dashboard. The goal is a single number — pass rate — that tells us whether
// the LLM is fit for purpose, without anyone clicking through the UI.
//
// Usage:
//   1) authz-api running on http://localhost:13001
//   2) An active provider with purpose_tag including 'sql_authoring' (or the
//      fallback). This script does NOT install a provider — it tests whatever
//      is currently configured.
//   3) From repo root: npx tsx services/authz-api/scripts/eval-llm-capability.ts
//
// Exits 0 iff every case passes its own assertions; otherwise exits 1 with a
// summary table of which cases failed and why.
//
// Cost note: each case is one real provider call. Default eval set is 5
// drafts + 1 refine = 6 calls. At typical OAI pricing this is well under $0.05
// per run, but be aware before running in tight loops.

import { Pool } from 'pg';

const API_BASE = process.env.AUTHZ_API_BASE || 'http://localhost:13001';
const TEST_USER = process.env.TEST_USER || 'adam_ou';
const TEST_GROUPS = process.env.TEST_GROUPS || 'AUTHZ_ADMIN';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '15432'),
  database: process.env.DB_NAME || 'nexus_authz',
  user: process.env.DB_USER || 'nexus_admin',
  password: process.env.DB_PASSWORD || 'nexus_dev_password',
});

type LintIssue = { severity: 'warn' | 'info'; code: string; message: string; hint: string };
type DraftResp = {
  sql?: string;
  markdown?: string;
  provider_id?: string;
  model_id?: string;
  usage?: { latency_ms?: number; prompt_tokens?: number; completion_tokens?: number; cost_usd?: number };
};

interface EvalCase {
  id: string;
  description: string;
  // What endpoint to hit + the body
  call: () => Promise<{ status: number; resp: DraftResp; raw: string }>;
  // Hard requirements — failing any of these fails the case
  expect: Array<{ name: string; check: (sql: string, lint: LintIssue[]) => boolean }>;
}

async function call(path: string, body: unknown): Promise<{ status: number; resp: any; raw: string }> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': TEST_USER,
      'X-User-Groups': TEST_GROUPS,
    },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let resp: any = null;
  try { resp = JSON.parse(raw); } catch { /* leave as text */ }
  return { status: r.status, resp, raw };
}

async function lintSql(sql: string): Promise<LintIssue[]> {
  // Use the same endpoint the dashboard uses → identical grading.
  const r = await call('/api/data-query/functions/lint', { sql });
  if (r.status !== 200) return []; // header-malformed; expectations will catch this separately
  return Array.isArray(r.resp?.issues) ? r.resp.issues : [];
}

async function pickDataSource(): Promise<string> {
  const r = await pool.query(
    `SELECT source_id FROM authz_data_source WHERE is_active = TRUE ORDER BY source_id LIMIT 1`
  );
  if (r.rows.length === 0) throw new Error('No active data source — seed one before running eval.');
  return r.rows[0].source_id;
}

// ── Reusable expectation builders ──
const hasCreateFunction = {
  name: 'parses as CREATE [OR REPLACE] FUNCTION',
  check: (sql: string) => /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(sql),
};
const hasStable = {
  name: 'declared STABLE (or IMMUTABLE)',
  check: (sql: string) => /\b(STABLE|IMMUTABLE)\b/i.test(sql),
};
const noSelectStar = {
  name: 'no SELECT *',
  check: (_sql: string, lint: LintIssue[]) => !lint.some((i) => i.code === 'FQL-02'),
};
const pPrefixedParams = {
  name: 'parameters use p_ prefix',
  check: (_sql: string, lint: LintIssue[]) => !lint.some((i) => i.code === 'FQL-03'),
};
const cleanLint = {
  name: 'no warn-level lint issues',
  check: (_sql: string, lint: LintIssue[]) => !lint.some((i) => i.severity === 'warn'),
};

// ── The capability set ──
function buildCases(dsId: string): EvalCase[] {
  const SEED_SELECT_STAR = `CREATE OR REPLACE FUNCTION public.fn_search_material(p_keyword text)
RETURNS TABLE(material_no text, name text)
LANGUAGE sql VOLATILE AS $$
  SELECT *
  FROM public.material_master
  WHERE material_no ILIKE '%' || p_keyword || '%'
  LIMIT 50
$$;`;

  return [
    {
      id: 'C1_search_fn',
      description: 'Draft a layer-1 search fn from a flat-prose prompt',
      call: () => call('/api/ai-assist/function-draft', {
        data_source_id: dsId,
        prompt: 'Write a Postgres function fn_search_material(p_keyword text) RETURNS TABLE(material_no text) — search material_master by partial match on material_no.',
      }) as any,
      expect: [hasCreateFunction, hasStable, noSelectStar, pPrefixedParams, cleanLint],
    },
    {
      id: 'C2_summary_fn',
      description: 'Draft a per-entity summary fn (one row per call)',
      call: () => call('/api/ai-assist/function-draft', {
        data_source_id: dsId,
        prompt: 'Write fn_material_summary(p_material_no text) returning one row with total_inbound_qty, total_outbound_qty, distinct_customer_count for the given material_no. Aggregate from inbound and outbound tables.',
      }) as any,
      expect: [hasCreateFunction, hasStable, noSelectStar, pPrefixedParams, cleanLint],
    },
    {
      id: 'C3_aspect_fn',
      description: 'Draft a narrow aspect fn (single concern, multiple rows)',
      call: () => call('/api/ai-assist/function-draft', {
        data_source_id: dsId,
        prompt: 'Write fn_material_inbound(p_material_no text) RETURNS TABLE(material_no text, doc_no text, doc_date date, qty numeric) — return inbound records for the given material_no.',
      }) as any,
      expect: [hasCreateFunction, hasStable, noSelectStar, pPrefixedParams, cleanLint],
    },
    {
      id: 'C4_refine_add_param',
      description: 'Refine: add an optional limit parameter without breaking existing shape',
      call: async () => {
        // Use a known-clean seed so the refine signal is isolated.
        const seed = `CREATE OR REPLACE FUNCTION public.fn_search_material(p_keyword text)
RETURNS TABLE(material_no text)
LANGUAGE sql STABLE AS $$
  SELECT material_no
  FROM public.material_master
  WHERE material_no ILIKE '%' || p_keyword || '%'
$$;`;
        return await call('/api/ai-assist/function-refine', {
          data_source_id: dsId,
          current_sql: seed,
          instruction: 'Add an optional p_limit integer parameter with default 50, applied as LIMIT.',
        }) as any;
      },
      expect: [
        hasCreateFunction, hasStable, pPrefixedParams, cleanLint,
        { name: 'has p_limit parameter', check: (sql) => /\bp_limit\b/i.test(sql) },
        { name: 'has LIMIT clause', check: (sql) => /\bLIMIT\b/i.test(sql) },
      ],
    },
    {
      id: 'C5_refine_fix_select_star',
      description: 'Ask-AI-to-fix: take a FQL-02-flagged seed and refine it clean',
      call: () => call('/api/ai-assist/function-refine', {
        data_source_id: dsId,
        current_sql: SEED_SELECT_STAR,
        instruction: 'Fix these quality issues: FQL-02: SELECT * — list columns explicitly; FQL-01: VOLATILE on read-only fn — should be STABLE',
      }) as any,
      expect: [hasCreateFunction, hasStable, noSelectStar, cleanLint],
    },
    {
      id: 'C6_house_naming',
      description: 'Draft respects house naming pattern (fn_search_*/fn_*_summary/etc.)',
      call: () => call('/api/ai-assist/function-draft', {
        data_source_id: dsId,
        prompt: 'Write a function that, given a part_no, returns a per-aspect view of stock movements (one row per movement with doc_no, doc_date, qty).',
      }) as any,
      // Soft expectation: name should match house pattern → no FQL-04.
      // FQL-04 is info-level, so cleanLint won't catch it; assert directly.
      expect: [
        hasCreateFunction, hasStable, noSelectStar, pPrefixedParams,
        { name: 'name matches house pattern (no FQL-04)', check: (_s, lint) => !lint.some((i) => i.code === 'FQL-04') },
      ],
    },
  ];
}

interface CaseResult {
  id: string;
  description: string;
  status: 'pass' | 'fail' | 'error';
  latency_ms?: number;
  provider_id?: string;
  model_id?: string;
  failed_expectations: string[];
  error?: string;
  sql_excerpt?: string;
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  try {
    const t0 = Date.now();
    const { status, resp } = await c.call();
    const elapsed = Date.now() - t0;
    if (status !== 200) {
      return {
        id: c.id, description: c.description, status: 'error',
        failed_expectations: [],
        error: `HTTP ${status}: ${typeof resp === 'object' ? JSON.stringify(resp).slice(0, 200) : String(resp).slice(0, 200)}`,
      };
    }
    const sql = resp?.sql || '';
    if (!sql) {
      return {
        id: c.id, description: c.description, status: 'error',
        failed_expectations: [],
        error: 'Response missing sql field',
        provider_id: resp?.provider_id, model_id: resp?.model_id,
      };
    }
    const lint = await lintSql(sql);
    const failed: string[] = [];
    for (const exp of c.expect) {
      try {
        if (!exp.check(sql, lint)) failed.push(exp.name);
      } catch (e: any) {
        failed.push(`${exp.name} (threw: ${e?.message || e})`);
      }
    }
    return {
      id: c.id,
      description: c.description,
      status: failed.length === 0 ? 'pass' : 'fail',
      latency_ms: resp?.usage?.latency_ms ?? elapsed,
      provider_id: resp?.provider_id,
      model_id: resp?.model_id,
      failed_expectations: failed,
      sql_excerpt: failed.length > 0 ? sql.slice(0, 400) : undefined,
    };
  } catch (e: any) {
    return {
      id: c.id, description: c.description, status: 'error',
      failed_expectations: [], error: e?.message || String(e),
    };
  }
}

function fmt(n: number | undefined, w = 6) {
  if (n === undefined) return ''.padStart(w);
  return String(n).padStart(w);
}

async function main() {
  console.log(`[eval] API target: ${API_BASE}`);
  const dsId = await pickDataSource();
  console.log(`[eval] data source: ${dsId}`);

  // Probe which provider will actually answer — purely informational; the
  // first real call would surface this anyway, but printing it up front makes
  // the eval result interpretable when reviewed days later.
  const cfg = await pool.query(
    `SELECT provider_id, default_model FROM authz_ai_provider
      WHERE is_active = TRUE
        AND ('sql_authoring' = ANY(purpose_tags) OR is_fallback = TRUE)
      ORDER BY ('sql_authoring' = ANY(purpose_tags)) DESC, provider_id
      LIMIT 1`,
  );
  if (cfg.rows.length === 0) {
    console.error('[eval] No active provider routed for sql_authoring (no purpose match, no fallback). Aborting.');
    await pool.end().catch(() => {});
    process.exit(1);
  }
  console.log(`[eval] provider candidate: ${cfg.rows[0].provider_id} (default_model=${cfg.rows[0].default_model})`);

  const cases = buildCases(dsId);
  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`[eval] ${c.id} … `);
    const r = await runCase(c);
    results.push(r);
    if (r.status === 'pass') {
      console.log(`✓ pass (${r.latency_ms}ms, ${r.model_id ?? '?'})`);
    } else if (r.status === 'fail') {
      console.log(`✗ fail (${r.latency_ms}ms) — ${r.failed_expectations.join('; ')}`);
    } else {
      console.log(`✗ error — ${r.error}`);
    }
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const total = results.length;
  const rate = ((pass / total) * 100).toFixed(0);

  console.log('\n──── Summary ────');
  console.log('id                          status  latency  model');
  for (const r of results) {
    const status = r.status === 'pass' ? '✓ pass ' : r.status === 'fail' ? '✗ fail ' : '✗ error';
    console.log(`${r.id.padEnd(28)}${status} ${fmt(r.latency_ms, 6)}ms  ${r.model_id ?? ''}`);
  }
  console.log(`\nPass rate: ${pass}/${total} (${rate}%)`);

  // Print the SQL only for failures, so reviewers can see what went wrong
  // without scrolling past clean outputs.
  const failedDetailed = results.filter((r) => r.status !== 'pass');
  if (failedDetailed.length > 0) {
    console.log('\n──── Failures (output excerpts) ────');
    for (const r of failedDetailed) {
      console.log(`\n[${r.id}] ${r.description}`);
      if (r.error) console.log(`  error: ${r.error}`);
      if (r.failed_expectations.length > 0) {
        console.log(`  failed: ${r.failed_expectations.join('; ')}`);
      }
      if (r.sql_excerpt) {
        console.log(`  sql:\n${r.sql_excerpt.split('\n').map((l) => '    ' + l).join('\n')}`);
      }
    }
  }

  await pool.end().catch(() => {});
  process.exit(failedDetailed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[eval] FATAL:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
