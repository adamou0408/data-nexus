// Deploy every App A SQL draft to pg_k8 via the Nexus deploy endpoint.
// This runs CREATE FUNCTION on pg_k8 + registers in authz_resource + grants ADMIN execute.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_A_DIR = path.resolve(__dirname, '../../../database/functions/pg_k8/app_a_material_360');
const API = process.env.API || 'http://localhost:13001';

function stripLeadingSqlComments(s) {
  let out = s;
  while (true) {
    const t = out.replace(/^\s+/, '');
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); out = nl === -1 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const end = t.indexOf('*/'); out = end === -1 ? '' : t.slice(end + 2); continue; }
    return t;
  }
}

const files = fs.readdirSync(APP_A_DIR).filter((f) => f.endsWith('.sql')).sort();
const results = [];

for (const f of files) {
  const raw = fs.readFileSync(path.join(APP_A_DIR, f), 'utf8');
  const sql = stripLeadingSqlComments(raw);
  process.stdout.write(`→ Deploying ${f.padEnd(36)} ... `);
  const res = await fetch(`${API}/api/data-query/functions/deploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': 'sys_admin',
      'X-User-Groups': 'DBA_TEAM,AUTHZ_ADMINS',
    },
    body: JSON.stringify({ data_source_id: 'ds:pg_k8', sql }),
  });
  const body = await res.text();
  try {
    const j = JSON.parse(body);
    if (res.status === 200 && j.resource_id) {
      console.log(`✓ ${j.schema}.${j.function_name} → ${j.resource_id} [${j.subtype}]`);
      results.push({ file: f, ok: true, resource_id: j.resource_id, name: `${j.schema}.${j.function_name}` });
    } else {
      console.log(`✗ ${res.status} ${j.error || ''} ${j.detail ? '— ' + j.detail.slice(0, 200) : ''}`);
      results.push({ file: f, ok: false, status: res.status, error: j.error, detail: j.detail });
    }
  } catch {
    console.log(`✗ ${res.status} ${body.slice(0, 200)}`);
    results.push({ file: f, ok: false, status: res.status, raw: body.slice(0, 200) });
  }
}

console.log('\n— Summary —');
const okCount = results.filter((r) => r.ok).length;
console.log(`${okCount}/${results.length} deployed successfully`);
if (okCount < results.length) {
  console.log('\nFailures:');
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  ${r.file}: ${r.error || r.raw || '?'} ${r.detail ? '— ' + r.detail : ''}`);
  }
  process.exit(1);
}
