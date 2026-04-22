// Direct API probe — validate every App A SQL draft against pg_k8 and print outcome.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_A_DIR = path.resolve(__dirname, '../../../database/functions/pg_k8/app_a_material_360');
const API = process.env.API || 'http://localhost:13001';

const files = fs.readdirSync(APP_A_DIR).filter((f) => f.endsWith('.sql')).sort();

function stripLeadingSqlComments(s) {
  let out = s;
  while (true) {
    const t = out.replace(/^\s+/, '');
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); out = nl === -1 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const end = t.indexOf('*/'); out = end === -1 ? '' : t.slice(end + 2); continue; }
    return t;
  }
}

for (const f of files) {
  const raw = fs.readFileSync(path.join(APP_A_DIR, f), 'utf8');
  const sql = stripLeadingSqlComments(raw);
  const res = await fetch(`${API}/api/data-query/functions/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': 'sys_admin',
      'X-User-Groups': 'DBA_TEAM,AUTHZ_ADMINS',
    },
    body: JSON.stringify({ data_source_id: 'ds:pg_k8', sql }),
  });
  const body = await res.text();
  let short = body;
  try {
    const j = JSON.parse(body);
    if (j.schema && j.function_name) {
      short = `OK  ${j.schema}.${j.function_name}(${j.arguments || ''}) -> ${j.return_type} [${j.subtype || '?'}]`;
    } else if (j.error) {
      short = `ERR ${j.error}${j.detail ? ' — ' + j.detail.slice(0, 200) : ''}`;
    }
  } catch {
    short = `${res.status} ${body.slice(0, 200)}`;
  }
  console.log(`${res.status === 200 ? '✓' : '✗'} ${f.padEnd(36)} ${short}`);
}
