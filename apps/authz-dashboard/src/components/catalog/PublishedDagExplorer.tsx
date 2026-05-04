// EXPLORER-MODE-V01 Phase B
//
// Renders a published_dag page when meta.display_mode === 'explorer'.
// The renderer turns a published DAG into a navigable space:
//   - root entry frame = first exposed node with no exposed-inbound (plan §3.2)
//   - cell click → drill to a downstream exposed node, seeded with cell value
//     (plan §3.3 / §6.2 drill rule)
//   - breadcrumb pop = stack truncate + re-exec
//   - re-exec on every stack mutation re-uses /api/config-exec (plan §3.4)
//
// What this file deliberately does NOT do (Phase B scope):
//   - URL trace deep-link (§13) → Phase C
//   - server-side downstream-only re-exec (§9 P2) → Phase 1.5+
//   - SavedViewBar — disabled by design in explorer mode (plan §3.5 / §10.5)
//
// All explorer state lives in DetailViewState.explorerStack so the catalog
// stack-back naturally restores drill progress.

import {
  useCallback, useEffect, useMemo, useRef, useState, FormEvent, ReactNode,
} from 'react';
import { Loader2, ArrowRight, Home, AlertTriangle } from 'lucide-react';
import { api } from '../../api';
import { useToast } from '../Toast';
import { FeedbackButton } from '../FeedbackButton';
import type {
  CatalogStackAPI, DetailViewState, ExplorerFrame,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Local type widening — same shape api.configExecPage already exposes for the
// PublishedDagBody. Keeping a local copy avoids importing private types from
// DetailView and keeps the explorer self-contained.
// ─────────────────────────────────────────────────────────────────────────────

type PublishedFormField = {
  name: string;
  type: string;
  pg_type?: string;
  required: boolean;
  default: unknown;
  help_text?: string;
  source_node_id: string;
};

type DagOutput = {
  columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
};

type ExplorerEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

type ExplorerMeta = {
  published_dag?: boolean;
  stage?: 'form_load' | 'exec';
  form_schema?: PublishedFormField[];
  output_node_id?: string;
  primary_output_node_id?: string;
  outputs?: Record<string, DagOutput>;
  display_mode?: 'tabular' | 'explorer';
  edges?: ExplorerEdge[];
  exposed_node_ids?: string[];
  row_count?: number;
  elapsed_ms?: number;
  truncated?: boolean;
  lineage?: Array<{ node_id: string; detail: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

// Plan §3.2: root entry = topo-first exposed node with no exposed inbound.
// edges + exposed_node_ids are surfaced from snapshot order, which itself
// passes through topoSort at publish time, so iterating exposed_node_ids
// preserves topo ordering.
function pickRootEntry(
  exposedIds: string[],
  edges: ExplorerEdge[],
): string | null {
  if (!exposedIds.length) return null;
  const exposedSet = new Set(exposedIds);
  for (const id of exposedIds) {
    const hasExposedInbound = edges.some(
      (e) => e.target === id && exposedSet.has(e.source),
    );
    if (!hasExposedInbound) return id;
  }
  // Fallback: first exposed (cycle would have been rejected at publish, but
  // this keeps us defensive — never throw out of a renderer).
  return exposedIds[0];
}

// Plan §6.2 drill rule: column c on node n is clickable iff there is at
// least one edge e with e.source=n, e.sourceHandle=c, exposed.has(e.target).
function findOutboundEdges(
  edges: ExplorerEdge[],
  exposedSet: Set<string>,
  fromNode: string,
  column: string,
): ExplorerEdge[] {
  return edges.filter(
    (e) =>
      e.source === fromNode &&
      e.sourceHandle === column &&
      exposedSet.has(e.target),
  );
}

function computeClickableColumns(
  edges: ExplorerEdge[],
  exposedSet: Set<string>,
  fromNode: string,
  cols: string[],
): Set<string> {
  const out = new Set<string>();
  for (const c of cols) {
    if (findOutboundEdges(edges, exposedSet, fromNode, c).length > 0) {
      out.add(c);
    }
  }
  return out;
}

// Cache key per plan brief: (nodeId, JSON.stringify(seededParams)).
function makeCacheKey(frame: ExplorerFrame): string {
  return `${frame.nodeId}::${JSON.stringify(frame.seededParams ?? {})}`;
}

function fieldInitialValue(field: PublishedFormField, override: unknown): unknown {
  if (override !== undefined && override !== null && override !== '') {
    if (Array.isArray(override)) return (override as unknown[]).map(String).join(', ');
    if (typeof override === 'object') return JSON.stringify(override, null, 2);
    return override;
  }
  if (field.default !== null && field.default !== undefined) {
    if (field.type === 'array' && Array.isArray(field.default)) {
      return (field.default as unknown[]).map(String).join(', ');
    }
    if (field.type === 'bool') return Boolean(field.default);
    if (field.type === 'json') return JSON.stringify(field.default, null, 2);
    return String(field.default);
  }
  if (field.type === 'bool') return false;
  return '';
}

function coerceFormValue(field: PublishedFormField, raw: unknown): unknown {
  if (raw === '' || raw === null || raw === undefined) {
    return field.required ? raw : null;
  }
  switch (field.type) {
    case 'array': {
      const s = String(raw).trim();
      if (!s) return [];
      return s.split(',').map((t) => t.trim()).filter(Boolean);
    }
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'bool':
      return Boolean(raw);
    case 'json': {
      const s = String(raw).trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch { return s; }
    }
    default:
      return raw;
  }
}

function shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) {
      // Handle arrays / objects via stringify (form values may be arrays).
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
    }
  }
  return true;
}

function truncateForDisplay(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  pageId: string;
  schema: PublishedFormField[];
  initialFormValues: Record<string, unknown> | undefined;
  initialMeta: ExplorerMeta | undefined;
  initialOutputs: Record<string, DagOutput> | undefined;
  stackApi: CatalogStackAPI;
};

export function PublishedDagExplorer({
  pageId,
  schema,
  initialFormValues,
  initialMeta,
  initialOutputs,
  stackApi,
}: Props) {
  const toast = useToast();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of schema) init[f.name] = fieldInitialValue(f, initialFormValues?.[f.name]);
    return init;
  });

  // submittedFormValues = the coerced map last actually sent to the server.
  // Drives drill seeding (§6.3 inheritedFormValues) AND the form-change-reset
  // contract (§3.4 / §10.1): if the user re-submits with a different shape,
  // we drop the drill stack and toast them.
  const [submittedFormValues, setSubmittedFormValues] = useState<
    Record<string, unknown> | null
  >(() => {
    // Phase A loaded once with `params = persistedFormValues ?? frame.params`,
    // so if we already have a stage='exec' meta, those values were the seed.
    if (initialMeta?.stage === 'exec' && initialFormValues) {
      const coerced: Record<string, unknown> = {};
      for (const f of schema) coerced[f.name] = coerceFormValue(f, initialFormValues[f.name]);
      return coerced;
    }
    return null;
  });

  // ── Latest exec meta + outputs (the source of truth for table rendering) ──
  // We hold these in component state because the explorer triggers its own
  // re-execs on drill, independent of the parent PageDetailBody's `loaded`.
  const [meta, setMeta] = useState<ExplorerMeta | undefined>(initialMeta);
  const [outputs, setOutputs] = useState<Record<string, DagOutput> | undefined>(
    initialOutputs,
  );
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  // ── Drill stack (lives in viewState; we read + write through stackApi) ────
  const detailVS: DetailViewState =
    stackApi.viewState.viewMode === 'detail'
      ? stackApi.viewState
      : { viewMode: 'detail', scrollTop: 0 };
  const explorerStack: ExplorerFrame[] = detailVS.explorerStack ?? [];

  const setExplorerStack = useCallback((next: ExplorerFrame[]) => {
    stackApi.setViewState((prev) => {
      if (prev.viewMode !== 'detail') return prev;
      return { ...prev, explorerStack: next };
    });
  }, [stackApi]);

  // ── Result cache: (nodeId, JSON.stringify(seededParams)) → DagOutput ──────
  // We cache *per-frame* outputs so breadcrumb pop avoids a redundant exec
  // when bouncing between already-visited frames. Memoised with a ref so
  // that re-renders triggered by setMeta don't reset the cache.
  const cacheRef = useRef<Map<string, DagOutput>>(new Map());

  // ── exposed_node_ids / edges from meta ─────────────────────────────────────
  const exposedIds: string[] = useMemo(
    () => meta?.exposed_node_ids ?? (meta?.output_node_id ? [meta.output_node_id] : []),
    [meta?.exposed_node_ids, meta?.output_node_id],
  );
  const exposedSet = useMemo(() => new Set(exposedIds), [exposedIds]);
  const edges: ExplorerEdge[] = useMemo(() => meta?.edges ?? [], [meta?.edges]);

  // ── Auto-seed root frame on first exec arrival ────────────────────────────
  // After the first /api/config-exec call returns with display_mode='explorer'
  // and outputs present, we push a root entry frame onto the empty stack.
  useEffect(() => {
    if (meta?.stage !== 'exec') return;
    if (explorerStack.length > 0) return;
    if (!exposedIds.length) return;
    const rootId = pickRootEntry(exposedIds, edges);
    if (!rootId) return;
    const seed = submittedFormValues ?? {};
    const rootFrame: ExplorerFrame = {
      nodeId: rootId,
      seededParams: seed,
      origin: null,
    };
    // Cache the root frame's output from the just-completed exec.
    if (outputs?.[rootId]) {
      cacheRef.current.set(makeCacheKey(rootFrame), outputs[rootId]);
    }
    setExplorerStack([rootFrame]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.stage, exposedIds.length, edges.length]);

  const topFrame: ExplorerFrame | null = explorerStack[explorerStack.length - 1] ?? null;

  // ── Re-exec orchestration ─────────────────────────────────────────────────
  const runExec = useCallback(
    async (paramsToSend: Record<string, unknown>) => {
      setExecLoading(true);
      setExecError(null);
      try {
        const result = await api.configExecPage(pageId, paramsToSend);
        const newMeta = result.meta as unknown as ExplorerMeta;
        const newOutputs = newMeta.outputs;
        setMeta(newMeta);
        setOutputs(newOutputs);
        // Seed cache for every block we just received against the params we
        // sent. Each block's logical key is the node it belongs to + the
        // params used; this lets a goBack to a sibling node be free.
        if (newOutputs) {
          for (const [nodeId, block] of Object.entries(newOutputs)) {
            const k = `${nodeId}::${JSON.stringify(paramsToSend)}`;
            cacheRef.current.set(k, block);
          }
        }
      } catch (e) {
        setExecError(e instanceof Error ? e.message : String(e));
      } finally {
        setExecLoading(false);
      }
    },
    [pageId],
  );

  // ── Form submit handler ───────────────────────────────────────────────────
  const handleFormSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    const coerced: Record<string, unknown> = {};
    for (const f of schema) coerced[f.name] = coerceFormValue(f, formValues[f.name]);

    // §3.4 / §10.1 — if form values changed AND a non-trivial drill stack
    // exists, reset stack to root + toast. We still always run the new
    // params; the stack-shaping happens before runExec so the root-seed
    // useEffect picks the new frame on arrival.
    const oldSubmitted = submittedFormValues;
    const formChanged = oldSubmitted == null
      ? true
      : !shallowEqual(oldSubmitted, coerced);

    if (formChanged && explorerStack.length > 1) {
      setExplorerStack([]);
      cacheRef.current.clear();
      toast.info('已清空探索路徑 — 重新從上游開始');
    } else if (formChanged) {
      // Single root frame or empty — clear cache so root re-seeds with new params.
      setExplorerStack([]);
      cacheRef.current.clear();
    }

    setSubmittedFormValues(coerced);
    void runExec(coerced);
  }, [schema, formValues, submittedFormValues, explorerStack.length, setExplorerStack, runExec, toast]);

  // ── Drill click ────────────────────────────────────────────────────────────
  const handleCellClick = useCallback(
    (rowIdx: number, columnName: string, cellValue: unknown, candidateEdge?: ExplorerEdge) => {
      if (!topFrame) return;
      const candidates = findOutboundEdges(edges, exposedSet, topFrame.nodeId, columnName);
      if (candidates.length === 0) return;
      const chosen = candidateEdge ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!chosen) return; // multi-candidate without a choice → caller should open popover

      const targetHandle = chosen.targetHandle;
      if (!targetHandle) {
        // Drill rule requires targetHandle to seed downstream input. If the
        // edge is connection-only (no handle), we cannot drill — silently
        // bail. Should be unreachable for explorer-published DAGs.
        return;
      }

      const seed: Record<string, unknown> = {
        ...(submittedFormValues ?? {}),
        ...topFrame.seededParams,
        [targetHandle]: cellValue,
      };
      const newFrame: ExplorerFrame = {
        nodeId: chosen.target,
        seededParams: seed,
        origin: {
          fromNodeId: topFrame.nodeId,
          rowKey: String(rowIdx),
          columnName,
        },
      };

      const cached = cacheRef.current.get(makeCacheKey(newFrame));
      const nextStack = [...explorerStack, newFrame];
      setExplorerStack(nextStack);
      if (cached && outputs) {
        // Patch outputs in place so render uses the cached block; meta
        // remains accurate, only the focused block matters here.
        setOutputs({ ...outputs, [newFrame.nodeId]: cached });
      } else {
        void runExec(seed);
      }
    },
    [topFrame, edges, exposedSet, submittedFormValues, explorerStack, outputs, setExplorerStack, runExec],
  );

  // ── Breadcrumb navigation: pop / goTo ─────────────────────────────────────
  const handleBreadcrumbClick = useCallback((targetIdx: number) => {
    if (targetIdx < 0 || targetIdx >= explorerStack.length) return;
    const truncated = explorerStack.slice(0, targetIdx + 1);
    setExplorerStack(truncated);
    const newTop = truncated[truncated.length - 1];
    if (!newTop) return;
    const cached = cacheRef.current.get(makeCacheKey(newTop));
    if (cached && outputs) {
      setOutputs({ ...outputs, [newTop.nodeId]: cached });
    } else {
      void runExec(newTop.seededParams);
    }
  }, [explorerStack, outputs, setExplorerStack, runExec]);

  // ── Multi-candidate popover state ─────────────────────────────────────────
  const [popover, setPopover] = useState<{
    rowIdx: number;
    column: string;
    value: unknown;
    candidates: ExplorerEdge[];
  } | null>(null);

  // ── Render: form + breadcrumb + table ─────────────────────────────────────

  const stage = meta?.stage;
  const showForm = true;
  const currentBlock: DagOutput | undefined =
    topFrame && outputs ? outputs[topFrame.nodeId] : undefined;

  const blockCols: string[] = useMemo(() => {
    if (!currentBlock) return [];
    if (currentBlock.columns?.length) return currentBlock.columns.map((c) => c.name);
    if (currentBlock.rows[0]) return Object.keys(currentBlock.rows[0]);
    return [];
  }, [currentBlock]);

  const clickableColumns = useMemo(() => {
    if (!topFrame) return new Set<string>();
    return computeClickableColumns(edges, exposedSet, topFrame.nodeId, blockCols);
  }, [edges, exposedSet, topFrame, blockCols]);

  return (
    <div>
      {/* Form */}
      {showForm && (
        <form
          onSubmit={handleFormSubmit}
          className="mb-4 p-4 bg-white border border-slate-200 rounded-lg"
        >
          <div className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
            <span>Parameters</span>
            <span className="text-[10px] uppercase tracking-wide bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
              explorer
            </span>
          </div>

          {schema.length === 0 ? (
            <div className="text-xs text-slate-500 italic mb-3">
              No exposed parameters — DAG will run with snapshot-bound inputs.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {schema.map((field) => (
                <div key={field.name} className="flex flex-col">
                  <label className="text-xs font-medium text-slate-600 mb-1 flex items-center gap-1">
                    <span className="font-mono">{field.name}</span>
                    {field.required && <span className="text-red-500">*</span>}
                    {field.pg_type && (
                      <span className="text-slate-400 font-normal">({field.pg_type})</span>
                    )}
                  </label>
                  {field.type === 'bool' ? (
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(formValues[field.name])}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [field.name]: e.target.checked }))
                        }
                        className="w-4 h-4"
                      />
                      <span className="text-slate-600 text-xs">
                        {String(Boolean(formValues[field.name]))}
                      </span>
                    </label>
                  ) : field.type === 'json' ? (
                    <textarea
                      value={String(formValues[field.name] ?? '')}
                      onChange={(e) =>
                        setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                      }
                      placeholder={field.required ? 'required' : 'optional'}
                      rows={4}
                      className="border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                    />
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={String(formValues[field.name] ?? '')}
                      onChange={(e) =>
                        setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                      }
                      placeholder={
                        field.type === 'array'
                          ? 'comma,separated,values'
                          : field.required ? 'required' : 'optional'
                      }
                      className="border border-slate-300 rounded px-2 py-1 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={execLoading}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-sm rounded font-medium"
            >
              {execLoading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Running…
                </span>
              ) : 'Run DAG'}
            </button>
            {meta?.elapsed_ms != null && stage === 'exec' && (
              <span className="text-xs text-slate-500">
                last exec {meta.elapsed_ms} ms
              </span>
            )}
          </div>
        </form>
      )}

      {/* Exec error */}
      {execError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>{execError}</div>
        </div>
      )}

      {/* Breadcrumb + body */}
      {stage === 'exec' && explorerStack.length > 0 && (
        <ExplorerBreadcrumb
          frames={explorerStack}
          onJump={handleBreadcrumbClick}
        />
      )}

      {stage === 'exec' && topFrame && (
        <div>
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="text-xs font-mono text-slate-700">{topFrame.nodeId}</span>
            <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
              level {explorerStack.length}
            </span>
            {currentBlock && (
              <span className="text-xs text-slate-500">
                {currentBlock.row_count} row{currentBlock.row_count === 1 ? '' : 's'}
                {currentBlock.truncated && (
                  <span className="ml-1 text-amber-600">(truncated)</span>
                )}
              </span>
            )}
          </div>

          {!currentBlock || currentBlock.rows.length === 0 ? (
            <EmptyFrameState
              hasOrigin={Boolean(topFrame.origin)}
              onBack={
                explorerStack.length > 1
                  ? () => handleBreadcrumbClick(explorerStack.length - 2)
                  : undefined
              }
            />
          ) : (
            <ExplorerTable
              cols={blockCols}
              rows={currentBlock.rows}
              clickableColumns={clickableColumns}
              onCellClick={(rowIdx, col, val) => {
                const candidates = findOutboundEdges(edges, exposedSet, topFrame.nodeId, col);
                if (candidates.length <= 1) {
                  handleCellClick(rowIdx, col, val, candidates[0]);
                } else {
                  setPopover({ rowIdx, column: col, value: val, candidates });
                }
              }}
            />
          )}
        </div>
      )}

      {/* Multi-candidate popover (modal-style chooser) */}
      {popover && (
        <div
          className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPopover(null);
          }}
        >
          <div className="bg-white rounded-lg shadow-xl border border-slate-200 max-w-md w-full">
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="text-sm font-semibold text-slate-800">
                Drill from <span className="font-mono">{popover.column}</span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                value: <span className="font-mono">{truncateForDisplay(popover.value)}</span> · choose downstream
              </div>
            </div>
            <ul className="py-1">
              {popover.candidates.map((c, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => {
                      handleCellClick(popover.rowIdx, popover.column, popover.value, c);
                      setPopover(null);
                    }}
                    className="w-full text-left px-4 py-2 hover:bg-blue-50 text-sm flex items-center gap-2"
                  >
                    <ArrowRight size={14} className="text-blue-500" />
                    <span className="font-mono text-slate-800">{c.target}</span>
                    <span className="text-xs text-slate-400">via</span>
                    <span className="font-mono text-xs text-slate-500">{c.targetHandle ?? '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-4 py-2 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setPopover(null)}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <FeedbackButton pageId={pageId} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ExplorerBreadcrumb({
  frames, onJump,
}: {
  frames: ExplorerFrame[];
  onJump: (idx: number) => void;
}) {
  return (
    <div className="mb-3 flex items-center flex-wrap gap-1.5 text-xs">
      <Home size={12} className="text-slate-400" />
      {frames.map((f, i) => {
        const isLast = i === frames.length - 1;
        // Breadcrumb chip: show the node + which upstream column the user
        // clicked to land here. Cell value isn't stored on the frame (the
        // exact targetHandle that received it lives only inside
        // seededParams), so we keep the chip column-focused — the table
        // body below already shows the full row context.
        const label = f.origin
          ? `${f.nodeId} ← ${f.origin.columnName}`
          : f.nodeId;
        return (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <ArrowRight size={11} className="text-slate-400" />}
            {isLast ? (
              <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded font-mono">
                {label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onJump(i)}
                className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-mono"
              >
                {label}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function ExplorerTable({
  cols, rows, clickableColumns, onCellClick,
}: {
  cols: string[];
  rows: Record<string, unknown>[];
  clickableColumns: Set<string>;
  onCellClick: (rowIdx: number, col: string, value: unknown) => void;
}) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {cols.map((c) => {
              const drillable = clickableColumns.has(c);
              return (
                <th
                  key={c}
                  className={`px-3 py-2 text-left font-medium font-mono text-xs ${
                    drillable ? 'text-blue-700' : 'text-slate-600'
                  }`}
                  title={drillable ? 'Click a cell to drill downstream' : undefined}
                >
                  {c}
                  {drillable && <span className="ml-1 text-blue-400">↘</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
              {cols.map((c) => {
                const v = row[c];
                const drillable = clickableColumns.has(c) && v !== null && v !== undefined && v !== '';
                return (
                  <td
                    key={c}
                    onClick={drillable ? () => onCellClick(i, c, v) : undefined}
                    className={`px-3 py-2 ${
                      drillable
                        ? 'text-blue-700 underline decoration-dotted cursor-pointer hover:bg-blue-50'
                        : 'text-slate-700'
                    }`}
                  >
                    {renderCellValue(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderCellValue(v: unknown): ReactNode {
  if (v === null || v === undefined) return <span className="text-slate-300">—</span>;
  if (typeof v === 'object') {
    return <code className="font-mono text-xs">{JSON.stringify(v)}</code>;
  }
  return String(v);
}

function EmptyFrameState({
  hasOrigin, onBack,
}: {
  hasOrigin: boolean;
  onBack: (() => void) | undefined;
}) {
  return (
    <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 flex items-start gap-3">
      <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-500" />
      <div className="flex-1">
        <div className="font-medium text-slate-700 mb-0.5">
          {hasOrigin ? '此值在下一層無對應資料' : '尚無資料'}
        </div>
        <div className="text-xs text-slate-500">
          {hasOrigin
            ? '上游 cell 的值在當前下游節點查不到對應 row。可返回上一層改選。'
            : '請先填寫表單並 Run DAG。'}
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mt-2 px-3 py-1 text-xs border border-slate-300 rounded hover:bg-white"
          >
            返回上一層
          </button>
        )}
      </div>
    </div>
  );
}
