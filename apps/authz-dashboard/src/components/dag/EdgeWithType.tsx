// ============================================================
// XDB-TIER-B-L3: typed edge renderer for Flow Composer.
//
// Why this lives in a sibling component (not inline in DagTab):
//   DagTab.tsx is already 4k+ lines. The L3 edge UI is a self-contained
//   slice — render path differs by precomputed `compat`, click target
//   delegates back to DagTab via `data.onInsertCast`. Keeping it dumb
//   (no useReactFlow hook, no node lookups) avoids the stale-closure
//   class of bugs where an edge component reads `nodes` from an outer
//   closure that's already moved on.
//
// Render rules (post-2026-04-29 hybrid + L3 boundary):
//   level === 'block' → red stroke + AlertCircle badge over edge midpoint;
//                       right-click on the badge opens "Insert cast" menu.
//                       The edge is still rendered (xyflow has already
//                       persisted it) — the visual reject signals "this
//                       saved DAG no longer satisfies the type gate".
//   level === 'warn'  → existing amber dashed stroke from edge.style;
//                       no badge (semantic_type advisory is rare and
//                       handled via the Inspector's per-edge tooltip).
//   level === 'ok'    → no overlay; defer to edge.style for stroke.
//
// edge.data shape (set by DagTab's useMemo):
//   {
//     compat?: CompatResult;          // from checkHandleCompat
//     onInsertCast?: (target: LogicalType) => void;  // closure into DagTab
//   }
//
// We deliberately do NOT compute compat inside this component — that would
// require reading nodes via useReactFlow / useStore, which costs a render
// per node mutation and reintroduces stale-closure risk during drag.
// ============================================================
import { useState, useRef, useEffect } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { AlertCircle, AlertTriangle } from 'lucide-react';
import type { CompatResult, LogicalType } from '../../utils/handleCompat';

type EdgeData = {
  compat?: CompatResult;
  onInsertCast?: (edgeId: string, target: LogicalType) => void;
};

export function EdgeWithType(props: EdgeProps) {
  const {
    id, sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    markerEnd, style: incomingStyle, data,
  } = props;

  const compat = (data as EdgeData | undefined)?.compat;
  const onInsertCast = (data as EdgeData | undefined)?.onInsertCast;

  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  });

  // Render style precedence:
  //   1. block  → solid red, takes over from incoming style
  //   2. warn   → amber dashed (already set by onConnect for new edges, but
  //               also re-applied here in case `compat` flipped to warn after
  //               drop — e.g. node retyped post-run)
  //   3. ok     → defer to incomingStyle (semantic colour from onConnect)
  const blocked = compat?.level === 'block';
  const warned = compat?.level === 'warn';
  const baseStyle = blocked
    ? { stroke: '#dc2626', strokeWidth: 2.5 }
    : warned
      ? { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '6 3' }
      : incomingStyle;

  // ── Right-click menu state ──
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={baseStyle} />

      {(blocked || warned) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              zIndex: 10,
            }}
            className="nodrag nopan"
          >
            <button
              type="button"
              title={compat?.reason || (blocked ? 'Type mismatch' : 'Advisory')}
              onClick={(e) => {
                e.stopPropagation();
                if (blocked && (compat?.suggestedCasts?.length ?? 0) > 0) setMenuOpen((v) => !v);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (blocked && (compat?.suggestedCasts?.length ?? 0) > 0) setMenuOpen(true);
              }}
              className={
                blocked
                  ? 'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-700 border border-red-300 hover:bg-red-100 shadow-sm'
                  : 'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-300 shadow-sm'
              }
              data-testid={blocked ? 'edge-blocked-badge' : 'edge-warn-badge'}
            >
              {blocked ? <AlertCircle size={12} /> : <AlertTriangle size={12} />}
              {blocked && compat?.fromLogical && compat?.toLogical
                ? <span>{compat.fromLogical}&nbsp;✕&nbsp;{compat.toLogical}</span>
                : <span>{blocked ? 'mismatch' : 'advisory'}</span>}
            </button>

            {menuOpen && blocked && compat?.suggestedCasts && (
              <div
                ref={menuRef}
                className="absolute mt-1 left-0 bg-white border border-slate-300 rounded shadow-lg py-1 min-w-[200px] text-xs"
                style={{ zIndex: 20 }}
              >
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                  Insert cast operator
                </div>
                {compat.suggestedCasts.map((target) => (
                  <button
                    key={target}
                    type="button"
                    className="w-full text-left px-2 py-1.5 hover:bg-slate-50 flex items-center justify-between"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onInsertCast?.(id, target);
                    }}
                  >
                    <span>target: <span className="font-mono">{target}</span></span>
                    <span className="text-[10px] text-slate-400">{compat.fromLogical} → {target}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
