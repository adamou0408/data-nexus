// ============================================================
// fn-quality-lint smoke test (FN-QUALITY-LINT-V01).
//
// Pure-function lint with no DB dependency. Asserts each rule fires
// on a known offender and stays silent on a clean fn.
// ============================================================
import { lintFunction } from '../src/lib/fn-quality-lint';

let ok = true;
const fail = (m: string) => { console.error('FAIL:', m); ok = false; };
const pass = (m: string) => console.log('PASS:', m);

function findCode(issues: ReturnType<typeof lintFunction>, code: string) {
  return issues.find((i) => i.code === code);
}

function main() {
  // ── T1: clean canonical fn — all rules silent ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_material_summary(p_material_no text)
RETURNS TABLE(material_no text, qty numeric)
LANGUAGE sql STABLE AS $$
  SELECT material_no, qty FROM public.materials WHERE material_no = p_material_no
$$;`;
    const issues = lintFunction({
      sql, function_name: 'fn_material_summary',
      arg_names: ['p_material_no'], volatility: 'STABLE',
    });
    if (issues.length !== 0) fail(`T1: clean fn produced ${issues.length} issues: ${issues.map((i) => i.code).join(',')}`);
    else pass('T1: canonical fn (STABLE, p_-prefixed, named, no SELECT *) → no issues');
  }

  // ── T2: VOLATILE on a read-only fn → FQL-01 fires ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_material_summary(p_material_no text)
RETURNS TABLE(material_no text)
LANGUAGE sql AS $$
  SELECT material_no FROM public.materials WHERE material_no = p_material_no
$$;`;
    const issues = lintFunction({
      sql, function_name: 'fn_material_summary',
      arg_names: ['p_material_no'], volatility: 'VOLATILE',
    });
    if (!findCode(issues, 'FQL-01')) fail('T2: expected FQL-01 (VOLATILE on read-only) to fire');
    else pass('T2: FQL-01 fires when VOLATILE + no DML');
  }

  // ── T3: VOLATILE WITH DML — FQL-01 quiet ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_audit_insert(p_msg text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.audit(msg) VALUES (p_msg);
$$;`;
    const issues = lintFunction({
      sql, function_name: 'fn_audit_insert',
      arg_names: ['p_msg'], volatility: 'VOLATILE',
    });
    if (findCode(issues, 'FQL-01')) fail('T3: FQL-01 should NOT fire when DML is present');
    else pass('T3: FQL-01 stays quiet when body contains DML');
  }

  // ── T4: SELECT * → FQL-02 fires ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_material_summary(p_material_no text)
RETURNS SETOF public.materials LANGUAGE sql STABLE AS $$
  SELECT * FROM public.materials WHERE material_no = p_material_no
$$;`;
    const issues = lintFunction({
      sql, function_name: 'fn_material_summary',
      arg_names: ['p_material_no'], volatility: 'STABLE',
    });
    if (!findCode(issues, 'FQL-02')) fail('T4: expected FQL-02 (SELECT *) to fire');
    else pass('T4: FQL-02 fires on SELECT *');
  }

  // ── T5: SELECT * inside a string literal → false positive guard ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_material_summary(p_material_no text)
RETURNS TABLE(note text) LANGUAGE sql STABLE AS $$
  SELECT 'SELECT * is bad'::text AS note FROM public.materials WHERE material_no = p_material_no
$$;`;
    const issues = lintFunction({
      sql, function_name: 'fn_material_summary',
      arg_names: ['p_material_no'], volatility: 'STABLE',
    });
    if (findCode(issues, 'FQL-02')) fail('T5: FQL-02 false-positive on SELECT * inside string literal');
    else pass('T5: SELECT * inside a string literal does not trip FQL-02');
  }

  // ── T6: param missing p_ prefix → FQL-03 fires ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_material_summary(material_no text)
RETURNS TABLE(qty numeric) LANGUAGE sql STABLE AS $$
  SELECT qty FROM public.materials WHERE material_no = material_no
$$;`;
    const issues = lintFunction({
      sql, function_name: 'fn_material_summary',
      arg_names: ['material_no'], volatility: 'STABLE',
    });
    const i03 = findCode(issues, 'FQL-03');
    if (!i03) fail('T6: expected FQL-03 (missing p_ prefix) to fire');
    else if (!i03.message.includes('material_no')) fail('T6: FQL-03 should name the offending param');
    else pass('T6: FQL-03 fires on param without p_ prefix');
  }

  // ── T7: name doesn't match conventions → FQL-04 fires (info-level) ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.lookupthing(p_key text)
RETURNS TABLE(v text) LANGUAGE sql STABLE AS $$ SELECT v FROM public.t WHERE k = p_key $$;`;
    const issues = lintFunction({
      sql, function_name: 'lookupthing',
      arg_names: ['p_key'], volatility: 'STABLE',
    });
    const i04 = findCode(issues, 'FQL-04');
    if (!i04) fail("T7: expected FQL-04 (name doesn't match patterns) to fire");
    else if (i04.severity !== 'info') fail('T7: FQL-04 should be severity=info');
    else pass('T7: FQL-04 fires on non-conforming name (info-level)');
  }

  // ── T8: keyword-driven layer-2 driver name passes ──
  {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_keyword_material_shipments(p_keyword text)
RETURNS TABLE(material_no text) LANGUAGE sql STABLE AS $$ SELECT material_no FROM public.t WHERE k=p_keyword $$;`;
    const issues = lintFunction({
      sql, function_name: 'fn_keyword_material_shipments',
      arg_names: ['p_keyword'], volatility: 'STABLE',
    });
    if (findCode(issues, 'FQL-04')) fail('T8: fn_keyword_<entity>_<aspect> should be accepted');
    else pass('T8: layer-2 driver name fn_keyword_material_shipments matches pattern');
  }

  if (!ok) process.exit(1);
  console.log('\nAll fn-quality-lint smoke tests passed.');
}

main();
