// ============================================================
// SQL Operation Type Detector
// Ported from EdgePolicy core/rewriter/operation_detector.py
// Fast keyword-based detection; AST fallback for ambiguous cases
// ============================================================

export type OperationType =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
  | 'DDL' | 'SET' | 'SHOW' | 'TRANSACTION' | 'COPY' | 'OTHER' | 'UNKNOWN';

const DDL_KEYWORDS = ['CREATE', 'ALTER', 'DROP', 'COMMENT', 'GRANT', 'REVOKE'];
const TX_KEYWORDS = ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'];

export function detectOperationType(sql: string): OperationType {
  const trimmed = sql.trim();
  if (!trimmed) return 'UNKNOWN';

  // Peel wrappers: EXPLAIN, EXPLAIN ANALYZE
  let core = trimmed;
  const upperCore = core.toUpperCase();
  if (upperCore.startsWith('EXPLAIN')) {
    const afterExplain = core.replace(/^EXPLAIN\s+(ANALYZE\s+)?/i, '');
    core = afterExplain;
  }

  const firstWord = core.split(/\s+/)[0].toUpperCase();

  if (firstWord === 'SELECT' || firstWord === 'WITH') return 'SELECT';
  if (firstWord === 'INSERT') return 'INSERT';
  if (firstWord === 'UPDATE') return 'UPDATE';
  if (firstWord === 'DELETE') return 'DELETE';
  if (firstWord === 'TRUNCATE') return 'TRUNCATE';
  if (firstWord === 'SET') return 'SET';
  if (firstWord === 'SHOW') return 'SHOW';
  if (firstWord === 'COPY') return 'COPY';
  if (DDL_KEYWORDS.includes(firstWord)) return 'DDL';
  if (TX_KEYWORDS.includes(firstWord)) return 'TRANSACTION';

  return 'OTHER';
}
