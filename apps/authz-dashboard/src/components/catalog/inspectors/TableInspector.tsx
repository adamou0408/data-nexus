// Catalog TableInspector — small read-only drawer for a `table` subject.
// Shows column count, RLS summary, last refresh; "Open schema" pushes a
// table-schema frame.

import { useEffect, useState } from 'react';
import { X, Table2, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../../../api';
import type { InspectorRendererProps } from '../types';

type Snapshot = {
  table: string;
  columnCount: number;
  rlsSummary: string;
};

export function TableInspector({ target, onClose, onOpen }: InspectorRendererProps) {
  // Inspector registry contract guarantees `kind` matches; assert and narrow.
  if (target.kind !== 'table') {
    throw new Error(`TableInspector received non-table target: ${target.kind}`);
  }
  const tableTarget = target;

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSnap(null);
    setError(null);
    api.tableSchema(tableTarget.table)
      .then((r) => {
        if (cancelled) return;
        setSnap({
          table: tableTarget.table,
          columnCount: r.columns.length,
          rlsSummary: 'See full schema for RLS detail',
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? 'Failed to load schema');
      });
    return () => { cancelled = true; };
  }, [tableTarget.table]);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Table2 size={16} className="text-blue-600" />
          <span className="font-mono">{tableTarget.table}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Close inspector"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4 text-sm">
        {error && (
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {!snap && !error && (
          <div className="flex items-center gap-2 text-zinc-500">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}

        {snap && (
          <>
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Columns</div>
              <div className="text-base font-semibold">{snap.columnCount}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">RLS</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-300">{snap.rlsSummary}</div>
            </div>
          </>
        )}
      </div>

      <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
        <button
          type="button"
          onClick={() => onOpen({ kind: 'table-schema', table: tableTarget.table })}
          className="btn btn-primary btn-sm w-full"
        >
          Open schema
        </button>
      </div>
    </div>
  );
}
