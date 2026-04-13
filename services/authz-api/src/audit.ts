import { pool } from './db';

type AuditEvent = {
  access_path: 'A' | 'B' | 'C';
  subject_id: string;
  action_id: string;
  resource_id: string;
  decision: 'allow' | 'deny';
  context?: Record<string, unknown>;
};

const buffer: AuditEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = 1000; // security.md requires ≤ 1s for deny events
const FLUSH_SIZE = 20;

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);
  const events = batch.map(e => ({
    timestamp: new Date().toISOString(),
    access_path: e.access_path,
    subject_id: e.subject_id,
    action_id: e.action_id,
    resource_id: e.resource_id,
    decision: e.decision,
    policy_ids: [],
    context: e.context ?? {},
  }));
  try {
    await pool.query('SELECT authz_audit_batch_insert($1)', [JSON.stringify(events)]);
  } catch (err) {
    console.error('Audit flush failed:', err);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

export function audit(event: AuditEvent) {
  buffer.push(event);
  if (buffer.length >= FLUSH_SIZE || event.decision === 'deny') {
    flush(); // deny events flush immediately per security.md
  } else {
    scheduleFlush();
  }
}
