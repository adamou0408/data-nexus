import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, applyEdgeChanges, applyNodeChanges,
  Handle, Position,
  type Node, type Edge, type NodeChange, type EdgeChange, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';
import { isCompatibleHandle, checkHandleCompat } from '../utils/handleCompat';

type DataSourceLite = { source_id: string; display_name: string; db_type: string };
import { useToast } from './Toast';
import { useRenderTokens } from '../RenderTokensContext';
import { PageHeader } from './shared/atoms/PageHeader';
import { EmptyState } from './shared/atoms/EmptyState';
import {
  Workflow, Save, Trash2, Play, Plus, Search, CheckCircle2, AlertCircle,
  Loader2, Database, Sparkles, FileText, Undo2, Redo2, X,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  FileOutput, Upload,
} from 'lucide-react';

// ── Types ──
type SemanticType = string; // free-form, e.g. 'material_no', 'product_family'
type IO = { name: string; semantic_type?: SemanticType; hasDefault?: boolean; pgType?: string };
type SinkKind = 'page'; // future: 'api' | 'scheduled_job' | 'alert'
type PageSinkConfig = {
  kind: 'page';
  page_id: string;
  title: string;
  parent_page_id?: string;
  description?: string;
  overwrite?: boolean;
};
type SinkConfig = PageSinkConfig;
type SinkLastRun = {
  artifact_id: string;
  at: string;             // ISO timestamp
  row_count: number;
  status: 'created' | 'overwritten';
};
type FnMeta = {
  resource_id: string;
  schema: string;
  function_name: string;
  display_name: string;
  subtype: string;
  parsed_args: IO[];
  return_shape: { shape: string; columns?: IO[] };
};
type ReturnShape = 'scalar' | 'table' | 'setof' | 'void' | 'unknown';
type OpKind = 'literal' | 'filter' | 'cast' | 'aggregate';
type AggregateFn = 'sum' | 'count' | 'min' | 'max' | 'avg';
type AggregateSpec = { fn: AggregateFn; column: string; alias?: string };
type OpConfig =
  | { kind: 'literal'; value: string; pgType: string; semantic_type?: string }
  | { kind: 'filter'; column: string; op: 'eq' | 'ne' | 'in' | 'gt' | 'lt' | 'like'; value: string }
  | { kind: 'cast'; source_column: string; target_pgType: string; target_semantic_type?: string }
  | { kind: 'aggregate'; group_by: string[]; aggregations: AggregateSpec[] };

type NodeData = {
  resource_id: string;
  label: string;
  subtype: string;
  inputs: IO[];
  outputs: IO[];
  bound_params: Record<string, unknown>;
  user_input_params?: string[];     // DAG-PUBLISH-V01: bound_param names exposed as form inputs at publish
  expose_output?: boolean;          // DAG-PUBLISH-V01-FU: admin flag — surface this node's frame as an extra output block on the published page (leaf is auto-exposed regardless)
  return_shape?: ReturnShape;       // fn nodes only — surfaces multiplicity badge
  op_kind?: OpKind;                 // operator nodes only
  op_config?: OpConfig;             // operator nodes only
  sink_kind?: SinkKind;              // sink nodes only — composer-native terminal
  sink_config?: SinkConfig;          // sink nodes only
  sink_last_run?: SinkLastRun;       // last successful sink execute
  // DAG-SUBDAG-EMBED-V01 — subdag node persisted fields. Resolver consumes
  // exactly these four; everything else (snapshot meta, fetched form_schema)
  // stays in component-local state so it can't go stale on the row.
  subdag_source_output_node_id?: string;
  subdag_user_inputs?: string[];
  bound_subdag_params?: Record<string, unknown>;
  last_result?: {
    columns: Array<{ name: string; semantic_type?: string; pgType?: string }>;
    rows: Record<string, unknown>[];
    row_count: number;
    elapsed_ms: number;
    lineage: Array<{ input: string; source: string }>;
  };
};

// ── Color per semantic_type so handles line up visually ──
// SSOT: authz_ui_render_token (V055, category='semantic_color').
// Curator can INSERT new semantic_type → hex without touching React.
// Fallback ships in RenderTokensContext so the UI never breaks if the
// registry fetch fails.
function useColorFor(): (t?: string) => string {
  const { semantic_color } = useRenderTokens();
  return (t?: string) => semantic_color[t || 'unknown'] || semantic_color.unknown || '#cbd5e1';
}

// ── Custom function-node ──
// Each I/O row is a fixed-height flex container with `position: relative`.
// xyflow's default `.react-flow__handle-left/right` CSS centers handles at
// `top: 50%`, so we no longer compute pixel offsets manually — the handle
// stays aligned with its row no matter how the title wraps or how many
// inputs the node has.
const ROW_H = 22;
const SUBTYPE_STYLES: Record<string, { bg: string; accent: string }> = {
  action: { bg: '#fef3c7', accent: '#d97706' },
  report: { bg: '#ede9fe', accent: '#7c3aed' },
  query:  { bg: '#f0f9ff', accent: '#0284c7' },
};
// Multiplicity badge — surfaces return_shape so curator sees "this fn returns
// many rows / one row / one value" without opening Inspector. Source: PG fn
// metadata `return_shape.shape` (function-metadata.ts parseReturnType).
const SHAPE_BADGE: Record<ReturnShape, { glyph: string; label: string; bg: string; fg: string }> = {
  table:   { glyph: '⊞', label: 'rows',   bg: '#dbeafe', fg: '#1d4ed8' },
  setof:   { glyph: '≣', label: 'setof',  bg: '#dbeafe', fg: '#1d4ed8' },
  scalar:  { glyph: '•', label: 'scalar', bg: '#e0f2fe', fg: '#0369a1' },
  void:    { glyph: '∅', label: 'void',   bg: '#f1f5f9', fg: '#64748b' },
  unknown: { glyph: '?', label: '?',      bg: '#f1f5f9', fg: '#64748b' },
};
// Context broadcasts the in-flight drag source so every FunctionNode can
// dim incompatible handles and ring compatible ones during onConnectStart.
type DragSrc = { nodeId: string; handleId: string; out: IO } | null;
const DragSrcContext = createContext<DragSrc>(null);

function FunctionNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const colorFor = useColorFor();
  const dragSrc = useContext(DragSrcContext);
  const s = SUBTYPE_STYLES[data.subtype] || SUBTYPE_STYLES.query;
  const border = selected ? '#2563eb' : '#cbd5e1';
  const isSourceNode = dragSrc?.nodeId === id;

  return (
    <div
      data-testid={`node-${data.resource_id}`}
      style={{
        background: s.bg,
        border: `2px solid ${border}`,
        borderRadius: 8,
        minWidth: 240,
        fontSize: 12,
        boxShadow: selected ? '0 4px 10px rgba(37,99,235,0.18)' : '0 1px 2px rgba(0,0,0,0.06)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.55)',
          borderBottom: '1px solid rgba(15,23,42,0.06)',
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {data.return_shape && SHAPE_BADGE[data.return_shape] && (
            <span
              title={`Returns: ${SHAPE_BADGE[data.return_shape].label}`}
              style={{
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 4,
                background: SHAPE_BADGE[data.return_shape].bg,
                color: SHAPE_BADGE[data.return_shape].fg,
                fontWeight: 600,
                lineHeight: 1.4,
              }}
            >
              {SHAPE_BADGE[data.return_shape].glyph} {SHAPE_BADGE[data.return_shape].label}
            </span>
          )}
          <span
            style={{
              fontSize: 9,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              padding: '1px 6px',
              borderRadius: 999,
              background: s.accent,
              color: 'white',
            }}
          >
            {data.subtype}
          </span>
        </div>
      </div>

      {/* Inputs (left) — handle centered per row by xyflow's default CSS */}
      {data.inputs.length > 0 && (
        <div style={{ padding: '4px 0' }}>
          {data.inputs.map((i) => {
            // Highlight compatibility: while user is dragging from an output handle
            // on another node, dim block-level mismatches, green-ring exact matches,
            // amber-ring advisory (semantic) mismatches.
            const compat = dragSrc && !isSourceNode
              ? checkHandleCompat(dragSrc.out, i)
              : null;
            const dim = !!(compat && compat.level === 'block');
            const ringOk = !!(compat && compat.level === 'ok');
            const ringWarn = !!(compat && compat.level === 'warn');
            const ringShadow = ringOk
              ? '0 0 0 3px rgba(34,197,94,0.45)'      // green
              : ringWarn
                ? '0 0 0 3px rgba(245,158,11,0.55)'   // amber — advisory
                : 'none';
            return (
              <div
                key={`in-${i.name}`}
                style={{
                  position: 'relative',
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 10px 0 14px',
                  color: '#334155',
                  opacity: dim ? 0.4 : 1,
                  transition: 'opacity 120ms',
                }}
              >
                <Handle
                  type="target"
                  position={Position.Left}
                  id={i.name}
                  style={{
                    background: colorFor(i.semantic_type),
                    width: 10,
                    height: 10,
                    border: '2px solid white',
                    opacity: dim ? 0.25 : 1,
                    boxShadow: ringShadow,
                    transition: 'opacity 120ms, box-shadow 120ms',
                  }}
                  title={compat?.reason}
                />
                <span style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: colorFor(i.semantic_type), display: 'inline-block' }} />
                  {i.name}
                  {i.hasDefault && <span style={{ color: '#94a3b8', fontSize: 10 }}>(opt)</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {data.inputs.length > 0 && data.outputs.length > 0 && (
        <div style={{ borderTop: '1px dashed #cbd5e1', margin: '0 8px' }} />
      )}

      {/* Outputs (right) — full list, scrollable when long. xyflow's Handle
          uses absolute positioning so drag still works inside scroll containers. */}
      {data.outputs.length > 0 && (
        <div
          className="nodrag nowheel"
          style={{ padding: '4px 0', maxHeight: 220, overflowY: 'auto' }}
        >
          {data.outputs.map((o) => {
            // While dragging from this node, dim other outputs to make the
            // active handle visually obvious.
            const dim = !!(dragSrc && isSourceNode && dragSrc.handleId !== o.name);
            return (
              <div
                key={`out-${o.name}`}
                style={{
                  position: 'relative',
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  padding: '0 14px 0 10px',
                  color: '#334155',
                  opacity: dim ? 0.5 : 1,
                  transition: 'opacity 120ms',
                }}
              >
                <span style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {o.name}
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: colorFor(o.semantic_type), display: 'inline-block' }} />
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={o.name}
                  style={{
                    background: colorFor(o.semantic_type),
                    width: 10,
                    height: 10,
                    border: '2px solid white',
                    opacity: dim ? 0.5 : 1,
                    transition: 'opacity 120ms',
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      {data.last_result && (
        <div
          style={{
            padding: '4px 10px',
            background: '#dcfce7',
            color: '#166534',
            fontSize: 10,
            fontWeight: 500,
            borderTop: '1px solid rgba(22,101,52,0.15)',
            borderBottomLeftRadius: 6,
            borderBottomRightRadius: 6,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>✓ {data.last_result.row_count} rows</span>
          <span>{data.last_result.elapsed_ms}ms</span>
        </div>
      )}
    </div>
  );
}

// ── Operator node (composer-operator-and-sink plan §3.1) ──
// Compact tile for literal / filter / cast. One symbolic input handle
// (`__upstream`) and one output (`__downstream` or `value` for literals).
// Visual styling deliberately differs from fn nodes so curator sees at a
// glance which nodes are platform primitives vs domain SQL fns.
const OP_STYLES: Record<OpKind, { bg: string; accent: string; glyph: string }> = {
  literal:   { bg: '#fff7ed', accent: '#ea580c', glyph: '◇' },
  filter:    { bg: '#ecfdf5', accent: '#059669', glyph: '⚲' },
  cast:      { bg: '#eff6ff', accent: '#2563eb', glyph: '⇄' },
  aggregate: { bg: '#fffbeb', accent: '#b45309', glyph: 'Σ' },
};

function OperatorNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const colorFor = useColorFor();
  const dragSrc = useContext(DragSrcContext);
  const opKind = (data.op_kind || 'literal') as OpKind;
  const s = OP_STYLES[opKind];
  const border = selected ? '#2563eb' : '#cbd5e1';
  const isSourceNode = dragSrc?.nodeId === id;

  // Build a one-line config summary so the node is self-documenting.
  const summary = (() => {
    const cfg = data.op_config as any;
    if (!cfg) return '(unconfigured)';
    if (opKind === 'literal') return `= ${cfg.value ?? '?'} :: ${cfg.pgType || 'text'}`;
    if (opKind === 'filter') return `${cfg.column || '?'} ${cfg.op || 'eq'} ${cfg.value ?? '?'}`;
    if (opKind === 'cast') return `${cfg.source_column || '?'} → ${cfg.target_pgType || 'text'}`;
    if (opKind === 'aggregate') {
      const grp = (cfg.group_by || []).length > 0 ? `by ${(cfg.group_by || []).join(',')}` : '(no groups)';
      const aggs = (cfg.aggregations || []).map((a: AggregateSpec) => `${a.fn}(${a.column || '?'})`).join(', ') || '(no aggs)';
      return `${grp} | ${aggs}`;
    }
    return '';
  })();

  return (
    <div
      data-testid={`op-${opKind}-${id}`}
      style={{
        background: s.bg,
        border: `2px solid ${border}`,
        borderRadius: 8,
        minWidth: 200,
        fontSize: 12,
        boxShadow: selected ? '0 4px 10px rgba(37,99,235,0.18)' : '0 1px 2px rgba(0,0,0,0.06)',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.6)',
          borderBottom: '1px solid rgba(15,23,42,0.06)',
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: s.accent, fontSize: 14 }}>{s.glyph}</span>
          {opKind}
        </span>
        <span
          style={{
            fontSize: 9,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            padding: '1px 6px',
            borderRadius: 999,
            background: s.accent,
            color: 'white',
          }}
        >
          op
        </span>
      </div>

      {/* Body — show single-line config summary so curator can read DAG without opening Inspector */}
      <div
        style={{
          position: 'relative',
          padding: '6px 14px',
          color: '#475569',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
          minHeight: ROW_H,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {/* Input handle on left for filter/cast (literal has no input) */}
        {opKind !== 'literal' && (
          <Handle
            type="target"
            position={Position.Left}
            id="__upstream"
            style={{
              background: '#94a3b8',
              width: 10,
              height: 10,
              border: '2px solid white',
              boxShadow: dragSrc && !isSourceNode ? '0 0 0 3px rgba(34,197,94,0.45)' : 'none',
              transition: 'box-shadow 120ms',
            }}
          />
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        {/* Output handle on right — literal emits 'value', others emit '__downstream' */}
        <Handle
          type="source"
          position={Position.Right}
          id={opKind === 'literal' ? 'value' : '__downstream'}
          style={{
            background: opKind === 'literal' ? colorFor((data.op_config as any)?.semantic_type) : '#94a3b8',
            width: 10,
            height: 10,
            border: '2px solid white',
          }}
        />
      </div>

      {data.last_result && (
        <div
          style={{
            padding: '4px 10px',
            background: '#dcfce7',
            color: '#166534',
            fontSize: 10,
            fontWeight: 500,
            borderTop: '1px solid rgba(22,101,52,0.15)',
            borderBottomLeftRadius: 6,
            borderBottomRightRadius: 6,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>✓ {data.last_result.row_count} rows</span>
          <span>{data.last_result.elapsed_ms}ms</span>
        </div>
      )}
    </div>
  );
}

// ── Sink node (sink-as-node-kind plan §3.5) ──
// Terminal in the DAG: takes an upstream rowset and lands it as a
// platform-side artifact (Tier B page for MVP). Visually distinct from
// fn (sky) and operators (warm) — uses slate to read as "endpoint".
const SINK_STYLES: Record<SinkKind, { bg: string; accent: string; glyph: string; label: string }> = {
  page: { bg: '#f8fafc', accent: '#475569', glyph: '🗄', label: 'page snapshot' },
};

function SinkNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const dragSrc = useContext(DragSrcContext);
  const sinkKind = (data.sink_kind || 'page') as SinkKind;
  const s = SINK_STYLES[sinkKind];
  const border = selected ? '#2563eb' : '#94a3b8';
  const isSourceNode = dragSrc?.nodeId === id;

  const cfg = data.sink_config as PageSinkConfig | undefined;
  const lastRun = data.sink_last_run;
  const subtitle = cfg?.page_id ? `→ ${cfg.page_id}` : '(unconfigured)';

  // Lifecycle chip — UX validation pass 3 (sink-as-node-kind plan §3.4)
  const chip = (() => {
    if (!lastRun) return { text: 'unsaved', bg: '#fef3c7', fg: '#92400e' };
    return {
      text: `saved · ${lastRun.row_count} rows`,
      bg: '#dcfce7',
      fg: '#166534',
    };
  })();

  return (
    <div
      data-testid={`sink-${sinkKind}-${id}`}
      style={{
        background: s.bg,
        border: `2px solid ${border}`,
        borderRadius: 8,
        minWidth: 220,
        fontSize: 12,
        boxShadow: selected ? '0 4px 10px rgba(37,99,235,0.18)' : '0 1px 2px rgba(0,0,0,0.06)',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.7)',
          borderBottom: '1px solid rgba(15,23,42,0.06)',
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 14 }}>{s.glyph}</span>
          {s.label}
        </span>
        <span
          style={{
            fontSize: 9,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            padding: '1px 6px',
            borderRadius: 999,
            background: s.accent,
            color: 'white',
          }}
        >
          sink
        </span>
      </div>

      <div
        style={{
          position: 'relative',
          padding: '6px 14px',
          color: '#475569',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
          minHeight: ROW_H,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Handle
          type="target"
          position={Position.Left}
          id="__upstream"
          style={{
            background: '#94a3b8',
            width: 10,
            height: 10,
            border: '2px solid white',
            boxShadow: dragSrc && !isSourceNode ? '0 0 0 3px rgba(34,197,94,0.45)' : 'none',
            transition: 'box-shadow 120ms',
          }}
        />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subtitle}
        </span>
        {/* No source handle — sink is terminal */}
      </div>

      <div
        style={{
          padding: '4px 10px',
          background: chip.bg,
          color: chip.fg,
          fontSize: 10,
          fontWeight: 500,
          borderTop: `1px solid ${chip.fg}22`,
          borderBottomLeftRadius: 6,
          borderBottomRightRadius: 6,
        }}
      >
        {chip.text}
      </div>
    </div>
  );
}

// DAG-SUBDAG-EMBED-V01 — subdag node renders as a single "embedded child"
// frame. Internals are flattened at parent publish, so the canvas only ever
// shows the bless gate (data.resource_id starts with 'published_dag:').
const SUBDAG_STYLE = { bg: '#eef2ff', accent: '#4338ca', glyph: '⤵', label: 'sub-DAG' };

function SubdagNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const dragSrc = useContext(DragSrcContext);
  const isSourceNode = dragSrc?.nodeId === id;
  const border = selected ? '#2563eb' : '#a5b4fc';
  const childRid = data.resource_id || '';
  const childLabel = childRid.startsWith('published_dag:')
    ? childRid.slice('published_dag:'.length)
    : '(unconfigured)';
  const surfaced = data.subdag_user_inputs?.length || 0;

  return (
    <div
      data-testid={`subdag-${id}`}
      style={{
        background: SUBDAG_STYLE.bg,
        border: `2px solid ${border}`,
        borderRadius: 8,
        minWidth: 240,
        fontSize: 12,
        boxShadow: selected ? '0 4px 10px rgba(37,99,235,0.18)' : '0 1px 2px rgba(0,0,0,0.06)',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.7)',
          borderBottom: '1px solid rgba(15,23,42,0.06)',
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 14, color: SUBDAG_STYLE.accent }}>{SUBDAG_STYLE.glyph}</span>
          {data.label || SUBDAG_STYLE.label}
        </span>
        <span
          style={{
            fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase',
            padding: '1px 6px', borderRadius: 999,
            background: SUBDAG_STYLE.accent, color: 'white',
          }}
        >
          subdag
        </span>
      </div>

      <div
        style={{
          position: 'relative',
          padding: '8px 14px',
          color: '#475569',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
          minHeight: ROW_H,
          display: 'flex', alignItems: 'center',
        }}
      >
        {/* No target handle — subdag inputs come from the published form/bound, not parent upstream */}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          → {childLabel}
        </span>
        <Handle
          type="source"
          position={Position.Right}
          id="__downstream"
          style={{
            background: SUBDAG_STYLE.accent,
            width: 10, height: 10, border: '2px solid white',
            boxShadow: dragSrc && !isSourceNode ? '0 0 0 3px rgba(34,197,94,0.45)' : 'none',
            transition: 'box-shadow 120ms',
          }}
        />
      </div>

      <div
        style={{
          padding: '4px 10px',
          background: childRid ? '#dbeafe' : '#fef3c7',
          color: childRid ? '#1e3a8a' : '#92400e',
          fontSize: 10, fontWeight: 500,
          borderTop: '1px solid rgba(15,23,42,0.06)',
          borderBottomLeftRadius: 6, borderBottomRightRadius: 6,
        }}
      >
        {childRid ? `${surfaced} input${surfaced === 1 ? '' : 's'} surfaced` : 'pick a published_dag to embed'}
      </div>
    </div>
  );
}

const nodeTypes = { fn: FunctionNode, literal: OperatorNode, filter: OperatorNode, cast: OperatorNode, aggregate: OperatorNode, sink: SinkNode, subdag: SubdagNode };

// ── Main tab ──
export function DagTab() {
  const toast = useToast();
  const colorFor = useColorFor();
  const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'info') =>
    kind === 'success' ? toast.success(msg) : kind === 'error' ? toast.error(msg) : toast.info(msg);
  const [dataSources, setDataSources] = useState<DataSourceLite[]>([]);
  const [dsId, setDsId] = useState('');
  const [dags, setDags] = useState<{ resource_id: string; display_name: string; node_count: number }[]>([]);
  const [currentDagId, setCurrentDagId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('Untitled DAG');
  const [description, setDescription] = useState('');
  const [functions, setFunctions] = useState<FnMeta[]>([]);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Array<{ severity: string; code: string; message: string; node_id?: string; edge_id?: string }>>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savePageOpenFor, setSavePageOpenFor] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const nextIdRef = useRef(1);

  // ── Layout Tier 4 (FC-01b): collapsible Palette/Inspector + viewport-tall canvas ──
  const [paletteCollapsed, setPaletteCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('dag.paletteCollapsed') === '1'; } catch { return false; }
  });
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('dag.inspectorCollapsed') === '1'; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem('dag.paletteCollapsed', paletteCollapsed ? '1' : '0'); } catch {} }, [paletteCollapsed]);
  useEffect(() => { try { localStorage.setItem('dag.inspectorCollapsed', inspectorCollapsed ? '1' : '0'); } catch {} }, [inspectorCollapsed]);

  // ── Undo/redo history (FC-01a) ──
  // Refs hold the canonical past/future stacks; tick triggers re-render
  // so toolbar buttons can read past/future depth via the ref.
  type Snapshot = { nodes: Node<NodeData>[]; edges: Edge[] };
  const historyPastRef = useRef<Snapshot[]>([]);
  const historyFutureRef = useRef<Snapshot[]>([]);
  const [, bumpHistory] = useState(0);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => { nodesRef.current = nodes; edgesRef.current = edges; }, [nodes, edges]);
  const HISTORY_CAP = 50;

  const pushHistory = useCallback(() => {
    historyPastRef.current = [
      ...historyPastRef.current.slice(-(HISTORY_CAP - 1)),
      { nodes: nodesRef.current, edges: edgesRef.current },
    ];
    historyFutureRef.current = [];
    bumpHistory((t) => t + 1);
  }, []);

  const clearHistory = useCallback(() => {
    historyPastRef.current = [];
    historyFutureRef.current = [];
    bumpHistory((t) => t + 1);
  }, []);

  const undo = useCallback(() => {
    const past = historyPastRef.current;
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    historyPastRef.current = past.slice(0, -1);
    historyFutureRef.current = [
      ...historyFutureRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ];
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setSelectedId((sid) => (sid && prev.nodes.some((n) => n.id === sid) ? sid : null));
    bumpHistory((t) => t + 1);
  }, []);

  const redo = useCallback(() => {
    const future = historyFutureRef.current;
    if (future.length === 0) return;
    const next = future[future.length - 1];
    historyFutureRef.current = future.slice(0, -1);
    historyPastRef.current = [
      ...historyPastRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ];
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedId((sid) => (sid && next.nodes.some((n) => n.id === sid) ? sid : null));
    bumpHistory((t) => t + 1);
  }, []);

  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (skip when typing in inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);
  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);
  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges]);

  // ── Load data sources + DAG list ──
  useEffect(() => {
    api.datasourcesLite().then((ds) => {
      setDataSources(ds);
      const first = ds.find((d) => d.source_id === 'ds:pg_k8') || ds[0];
      if (first) setDsId(first.source_id);
    }).catch((e) => showToast(String(e), 'error'));
  }, []);

  useEffect(() => {
    if (!dsId) return;
    api.dagList(dsId).then(setDags).catch(() => setDags([]));
    api.dataQueryFunctions(dsId).then((fns) => {
      setFunctions(fns.map((f: any) => ({
        ...f,
        parsed_args: (f.parsed_args || []).map((a: any) => ({ ...a, semantic_type: a.semantic_type })),
      })));
    }).catch(() => setFunctions([]));
  }, [dsId]);

  // ── Helpers ──
  const nextNodeId = () => `n${nextIdRef.current++}`;

  const resetCanvas = () => {
    setCurrentDagId(null);
    setDisplayName('Untitled DAG');
    setDescription('');
    setNodes([]);
    setEdges([]);
    setIssues([]);
    setSelectedId(null);
    nextIdRef.current = 1;
    clearHistory();
  };

  const loadDag = async (rid: string) => {
    try {
      const d = await api.dagGet(rid);
      setCurrentDagId(d.resource_id);
      setDisplayName(d.display_name);
      setDescription(d.description || '');
      setNodes(d.nodes || []);
      setEdges(d.edges || []);
      setIssues([]);
      setSelectedId(null);
      // Advance nextId past any existing IDs
      const maxN = (d.nodes || []).reduce((m, n) => {
        const m2 = /^n(\d+)$/.exec(n.id);
        return m2 ? Math.max(m, parseInt(m2[1])) : m;
      }, 0);
      nextIdRef.current = maxN + 1;
      clearHistory();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const addFunctionNode = (fn: FnMeta) => {
    const id = nextNodeId();
    const inputs: IO[] = (fn.parsed_args || []).map((a: any) => ({
      name: a.name, semantic_type: a.semantic_type, hasDefault: a.hasDefault, pgType: a.pgType,
    }));
    const outputs: IO[] = fn.return_shape?.shape === 'table'
      ? (fn.return_shape.columns || []).map((c: any) => ({ name: c.name, semantic_type: c.semantic_type, pgType: c.pgType }))
      : fn.return_shape?.shape === 'setof' || fn.return_shape?.shape === 'scalar'
      ? [{ name: 'value', semantic_type: undefined, pgType: (fn.return_shape as any).pgType }]
      : [];
    const node: Node<NodeData> = {
      id,
      type: 'fn',
      position: { x: 80 + (nodes.length % 4) * 280, y: 80 + Math.floor(nodes.length / 4) * 260 },
      data: {
        resource_id: fn.resource_id,
        label: fn.function_name,
        subtype: fn.subtype,
        inputs, outputs,
        bound_params: {},
        return_shape: (fn.return_shape?.shape as ReturnShape) || 'unknown',
      },
    };
    pushHistory();
    setNodes((nds) => [...nds, node]);
    setSelectedId(id);
  };

  // Operator nodes are composer-native — they don't reference an
  // authz_resource (no fn registry entry). Inputs/outputs are symbolic
  // (`__upstream` / `__downstream`); runtime resolves the actual rowset.
  const addOperatorNode = (opKind: OpKind) => {
    const id = nextNodeId();
    const inputs: IO[] = opKind === 'literal'
      ? []
      : [{ name: '__upstream', semantic_type: '__rowset' }];
    const outputs: IO[] = opKind === 'literal'
      ? [{ name: 'value', pgType: 'text' }]
      : [{ name: '__downstream', semantic_type: '__rowset' }];
    const op_config: OpConfig =
      opKind === 'literal' ? { kind: 'literal', value: '', pgType: 'text' }
      : opKind === 'filter' ? { kind: 'filter', column: '', op: 'eq', value: '' }
      : opKind === 'cast' ? { kind: 'cast', source_column: '', target_pgType: 'text' }
      : { kind: 'aggregate', group_by: [], aggregations: [{ fn: 'count', column: '' }] };
    const node: Node<NodeData> = {
      id,
      type: opKind,
      position: { x: 80 + (nodes.length % 4) * 280, y: 80 + Math.floor(nodes.length / 4) * 260 },
      data: {
        resource_id: '',                 // operators have no fn resource
        label: opKind,
        subtype: 'operator',
        inputs,
        outputs,
        bound_params: {},
        op_kind: opKind,
        op_config,
      },
    };
    pushHistory();
    setNodes((nds) => [...nds, node]);
    setSelectedId(id);
  };

  // sink-as-node-kind plan §3.4 — composer-native sink terminal.
  // page_id default mirrors the legacy SaveAsPageDialog so curators who
  // have memorized the dialog defaults stay oriented.
  const addSinkNode = (sinkKind: SinkKind = 'page') => {
    const id = nextNodeId();
    const dagSlug = (currentDagId || 'untitled').replace(/^dag:/, '');
    const sinkConfig: SinkConfig = {
      kind: 'page',
      page_id: `${dagSlug}__${id}_snapshot`.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      title: `${displayName} — ${id} snapshot`,
      parent_page_id: 'modules_home',
      description: `DAG snapshot from ${currentDagId || '(unsaved DAG)'} sink ${id}`,
      overwrite: false,
    };
    const node: Node<NodeData> = {
      id,
      type: 'sink',
      position: { x: 80 + (nodes.length % 4) * 280, y: 80 + Math.floor(nodes.length / 4) * 260 },
      data: {
        resource_id: '',
        label: `sink:${sinkKind}`,
        subtype: 'sink',
        inputs: [{ name: '__upstream', semantic_type: '__rowset' }],
        outputs: [],
        bound_params: {},
        sink_kind: sinkKind,
        sink_config: sinkConfig,
      },
    };
    pushHistory();
    setNodes((nds) => [...nds, node]);
    setSelectedId(id);
  };

  // DAG-SUBDAG-EMBED-V01 — add an unconfigured subdag node. The published_dag
  // pick happens in the Inspector (via dagPublishedList filtered to dsId).
  const addSubdagNode = () => {
    const id = nextNodeId();
    const node: Node<NodeData> = {
      id,
      type: 'subdag',
      position: { x: 80 + (nodes.length % 4) * 280, y: 80 + Math.floor(nodes.length / 4) * 260 },
      data: {
        resource_id: '',
        label: 'sub-DAG',
        subtype: 'subdag',
        // No target handle on the rendered node, but expose a synthetic
        // downstream handle so existing edge logic (isValidConnection,
        // colorFor) treats it like other nodes.
        inputs: [],
        outputs: [{ name: '__downstream', semantic_type: '__rowset' }],
        bound_params: {},
        subdag_source_output_node_id: undefined,
        subdag_user_inputs: [],
        bound_subdag_params: {},
      },
    };
    pushHistory();
    setNodes((nds) => [...nds, node]);
    setSelectedId(id);
  };

  // DAG-SUBDAG-EMBED-V01 — patch persisted subdag fields. Caller passes only
  // resolver-consumed fields; snapshot meta stays in component-local cache.
  const updateSubdagData = (patch: Partial<Pick<NodeData,
    'resource_id' | 'label' | 'subdag_source_output_node_id' | 'subdag_user_inputs' | 'bound_subdag_params'
  >>) => {
    if (!selected) return;
    pushHistory();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== selected.id) return n;
      return { ...n, data: { ...n.data, ...patch } };
    }));
  };

  const updateSinkConfig = (patch: Partial<PageSinkConfig>) => {
    if (!selected) return;
    pushHistory();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== selected.id) return n;
      const next = { ...(n.data.sink_config || { kind: 'page' as const }), ...patch } as SinkConfig;
      return { ...n, data: { ...n.data, sink_config: next } };
    }));
  };

  const updateOpConfig = (patch: Record<string, unknown>) => {
    if (!selected) return;
    pushHistory();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== selected.id) return n;
      const next = { ...(n.data.op_config || {}), ...patch } as OpConfig;
      return { ...n, data: { ...n.data, op_config: next } };
    }));
  };

  const deleteSelected = useCallback(() => {
    const nodeIds = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    if (selectedId) nodeIds.add(selectedId);
    const edgeIds = new Set(edgesRef.current.filter((e) => e.selected).map((e) => e.id));
    if (nodeIds.size === 0 && edgeIds.size === 0) return;
    pushHistory();
    setNodes((nds) => nds.filter((n) => !nodeIds.has(n.id)));
    setEdges((eds) => eds.filter((e) =>
      !edgeIds.has(e.id) && !nodeIds.has(e.source) && !nodeIds.has(e.target)
    ));
    setSelectedId(null);
  }, [pushHistory, selectedId]);

  // ── React Flow callbacks ──
  // Snapshot before destructive changes (remove) and after a drag finishes
  // (drag-end is the only position change worth committing to history;
  // in-flight position frames are noise).
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const isRemove = changes.some((c) => c.type === 'remove');
    const isDragEnd = changes.some((c) => c.type === 'position' && (c as any).dragging === false);
    if (isRemove || isDragEnd) pushHistory();
    setNodes((nds) => applyNodeChanges(changes, nds) as Node<NodeData>[]);
  }, [pushHistory]);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const isRemove = changes.some((c) => c.type === 'remove');
    if (isRemove) pushHistory();
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, [pushHistory]);

  // Drag-time compatibility highlighting: track the active source handle so
  // FunctionNode can ring compatible inputs / dim incompatible ones.
  const [dragSrc, setDragSrc] = useState<DragSrc>(null);
  const onConnectStart = useCallback((_e: any, params: { nodeId?: string | null; handleId?: string | null; handleType?: string | null }) => {
    if (params.handleType !== 'source' || !params.nodeId || !params.handleId) {
      setDragSrc(null);
      return;
    }
    const src = nodes.find((n) => n.id === params.nodeId);
    if (!src) return;
    const out = src.data.outputs.find((o) => o.name === params.handleId);
    if (out) setDragSrc({ nodeId: params.nodeId, handleId: params.handleId, out });
  }, [nodes]);
  const onConnectEnd = useCallback(() => setDragSrc(null), []);

  // Pre-validate before xyflow draws the rubber-band edge — returning false
  // prevents the user from even dropping on incompatible handles.
  const isValidConnection = useCallback((conn: Connection | Edge) => {
    if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return false;
    const src = nodes.find((n) => n.id === conn.source);
    const tgt = nodes.find((n) => n.id === conn.target);
    const o = src?.data.outputs.find((x) => x.name === conn.sourceHandle);
    const i = tgt?.data.inputs.find((x) => x.name === conn.targetHandle);
    if (!o || !i) return false;
    return isCompatibleHandle(o, i);
  }, [nodes]);

  // Edge type-check on connect — hybrid model post-2026-04-29:
  //   block (pgType family mismatch) → reject with error toast.
  //   warn  (semantic mismatch but pgType OK) → allow + advisory toast (curator decides).
  //   ok    (both pgType + semantic match) → allow silently.
  // Server /validate revalidates on save and only blocks when severity='error'.
  const onConnect = useCallback((conn: Connection) => {
    const src = nodes.find((n) => n.id === conn.source);
    const tgt = nodes.find((n) => n.id === conn.target);
    if (!src || !tgt) return;
    const srcOut = src.data.outputs.find((o) => o.name === conn.sourceHandle);
    const tgtIn = tgt.data.inputs.find((i) => i.name === conn.targetHandle);
    if (!srcOut || !tgtIn) return;
    const compat = checkHandleCompat(srcOut, tgtIn);
    if (compat.level === 'block') {
      const sLabel = srcOut.pgType || 'unknown';
      const tLabel = tgtIn.pgType || 'unknown';
      showToast(`Type mismatch (blocked): ${sLabel} → ${tLabel}`, 'error');
      return;
    }
    if (compat.level === 'warn') {
      showToast(`Advisory: ${compat.reason} — connection allowed`, 'info');
    }
    pushHistory();
    // Edge stroke colour: warn = amber dashed so the advisory is visible on the canvas,
    // ok = upstream semantic colour (existing behaviour).
    const isAdvisory = compat.level === 'warn';
    setEdges((eds) => addEdge({
      ...conn,
      id: `e${eds.length + 1}_${Date.now()}`,
      style: isAdvisory
        ? { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '6 3' }
        : { stroke: colorFor(srcOut.semantic_type), strokeWidth: 2 },
    }, eds));
  }, [nodes, pushHistory]);

  // ── Toolbar actions ──
  const validate = async () => {
    try {
      const payload = {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, data: { resource_id: n.data.resource_id, inputs: n.data.inputs, outputs: n.data.outputs, bound_params: n.data.bound_params } })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
      };
      const r = await api.dagValidate(payload);
      setIssues(r.issues);
      if (r.ok) showToast('Validation passed', 'success');
      else showToast(`${r.issues.filter((i) => i.severity === 'error').length} error(s)`, 'error');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const save = async () => {
    if (!dsId) return showToast('No data source', 'error');
    setSaving(true);
    try {
      const payload = {
        resource_id: currentDagId || undefined,
        display_name: displayName,
        data_source_id: dsId,
        description,
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, style: e.style })),
      };
      const r = await api.dagSave(payload);
      setCurrentDagId(r.resource_id);
      showToast(`Saved as ${r.resource_id}`, 'success');
      api.dagList(dsId).then(setDags).catch(() => {});
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!currentDagId) return;
    if (!window.confirm(`Delete ${currentDagId}?`)) return;
    try {
      await api.dagDelete(currentDagId);
      showToast('Deleted', 'success');
      resetCanvas();
      api.dagList(dsId).then(setDags).catch(() => {});
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const executeNode = async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setRunning(nodeId);
    try {
      // Gather upstream results from any node that has a last_result.
      // Operator nodes need full `rows[]` (filter/cast) — fn-only path uses row0
      // and is unchanged. upstream_resources is needed so operator authz can
      // inherit the upstream fn's resource_id (composer-operator-and-sink §3.2).
      const upstream: Record<string, any> = {};
      const upstream_resources: Record<string, string> = {};
      for (const n of nodes) {
        if (n.data.last_result && n.data.last_result.rows.length > 0) {
          upstream[n.id] = {
            columns: n.data.last_result.columns,
            row0: n.data.last_result.rows[0],
            rows: n.data.last_result.rows,
          };
        }
        if (n.type === 'fn' && n.data.resource_id) {
          upstream_resources[n.id] = n.data.resource_id;
        }
      }
      // Propagate fn ancestor resource_id through operator chains so operators
      // depth ≥ 2 (e.g. fn → filter → filter) re-trigger authz_check on the
      // original fn. Walk back via inbound edges until a fn ancestor is found.
      const findFnAncestor = (startId: string, visited = new Set<string>()): string | undefined => {
        if (visited.has(startId)) return undefined;
        visited.add(startId);
        const inEdge = edges.find((e) => e.target === startId);
        if (!inEdge) return undefined;
        const src = nodes.find((n) => n.id === inEdge.source);
        if (!src) return undefined;
        if (src.type === 'fn' && src.data.resource_id) return src.data.resource_id;
        return findFnAncestor(src.id, visited);
      };
      for (const n of nodes) {
        if (n.type && n.type !== 'fn' && n.type !== 'literal' && !upstream_resources[n.id]) {
          const rid = findFnAncestor(n.id);
          if (rid) upstream_resources[n.id] = rid;
        }
      }
      const payload = {
        data_source_id: dsId,
        node: {
          id: node.id,
          type: node.type,
          data: {
            resource_id: node.data.resource_id,
            inputs: node.data.inputs,
            bound_params: node.data.bound_params,
            op_kind: node.data.op_kind,
            op_config: node.data.op_config,
          },
        },
        upstream,
        upstream_resources,
        edges: edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
      };
      const r = await api.dagExecuteNode(payload);
      setNodes((nds) => nds.map((n) => n.id === nodeId ? {
        ...n,
        data: {
          ...n.data,
          last_result: { columns: r.columns, rows: r.rows, row_count: r.row_count, elapsed_ms: r.elapsed_ms, lineage: r.lineage },
        },
      } : n));
      showToast(`${node.data.label}: ${r.row_count} rows in ${r.elapsed_ms}ms`, 'success');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setRunning(null);
    }
  };

  // ── Execute a sink node (sink-as-node-kind plan §3.3) ──
  // Snapshot semantics: sink emits the upstream's last_result (NOT
  // re-executes upstream); user is expected to Run upstream first.
  const executeSink = async (sinkId: string) => {
    const sinkNode = nodes.find((n) => n.id === sinkId);
    if (!sinkNode || sinkNode.type !== 'sink') return;
    if (!currentDagId) {
      showToast('Save the DAG first — sinks need a stable dag_id', 'error');
      return;
    }
    const cfg = sinkNode.data.sink_config as PageSinkConfig | undefined;
    if (!cfg?.page_id || !cfg?.title) {
      showToast('Sink is unconfigured: page_id and title are required', 'error');
      return;
    }
    const inEdge = edges.find((e) => e.target === sinkId);
    if (!inEdge) {
      showToast('Sink has no upstream — connect a fn or operator node first', 'error');
      return;
    }
    const upNode = nodes.find((n) => n.id === inEdge.source);
    const lr = upNode?.data.last_result;
    if (!upNode || !lr || lr.rows.length === 0) {
      showToast(`Run upstream node '${upNode?.data.label || inEdge.source}' first — sink snapshots its last result`, 'error');
      return;
    }

    setRunning(sinkId);
    try {
      const r = await api.dagExecuteSink({
        dag_id: currentDagId,
        sink_node_id: sinkId,
        sink_kind: 'page',
        sink_config: {
          page_id: cfg.page_id,
          title: cfg.title,
          parent_page_id: cfg.parent_page_id || undefined,
          description: cfg.description || undefined,
          overwrite: cfg.overwrite,
        },
        bound_params: upNode.data.bound_params,
        columns: lr.columns,
        rows: lr.rows,
      });
      const ranAt = new Date().toISOString();
      setNodes((nds) => nds.map((n) => n.id === sinkId ? {
        ...n,
        data: {
          ...n.data,
          sink_last_run: {
            artifact_id: r.artifact_id,
            at: ranAt,
            row_count: r.row_count,
            status: r.status,
          },
        },
      } : n));
      showToast(`Sink ${cfg.page_id}: ${r.row_count} rows snapshotted`, 'success');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setRunning(null);
    }
  };

  // ── Run all nodes in topological order (Kahn's algorithm) ──
  const runAll = async () => {
    if (nodes.length === 0) return;
    const adj = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    nodes.forEach((n) => { adj.set(n.id, []); indeg.set(n.id, 0); });
    edges.forEach((e) => {
      adj.get(e.source)?.push(e.target);
      indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
    });
    const queue: string[] = [];
    indeg.forEach((d, id) => { if (d === 0) queue.push(id); });
    const order: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const next of adj.get(id) || []) {
        const d = (indeg.get(next) || 0) - 1;
        indeg.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (order.length !== nodes.length) {
      showToast('Cycle detected — fix edges before running', 'error');
      return;
    }
    let ran = 0;
    let skipped = 0;
    for (const id of order) {
      const n = nodes.find((nn) => nn.id === id);
      // Sinks are explicit (▶ Execute Sink) — skip in runAll. (sink-as-node-kind §D8)
      if (n?.type === 'sink') { skipped++; continue; }
      await executeNode(id);
      ran++;
    }
    const suffix = skipped > 0 ? ` (skipped ${skipped} sink${skipped > 1 ? 's' : ''} — use ▶ Execute Sink)` : '';
    showToast(`Ran ${ran} node(s)${suffix}`, 'success');
  };

  // ── Suggest compatible next nodes (W3-2 integration) ──
  const availableSemTypes = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) {
      for (const o of n.data.outputs) if (o.semantic_type && o.semantic_type !== 'unknown') s.add(o.semantic_type);
    }
    return Array.from(s);
  }, [nodes]);

  const [compatible, setCompatible] = useState<Array<{ resource_id: string; display_name: string; covered_inputs: string[] }>>([]);
  useEffect(() => {
    if (!dsId || availableSemTypes.length === 0) { setCompatible([]); return; }
    api.dataQueryCompatible(dsId, availableSemTypes).then((r) => {
      setCompatible(r.compatible.map((c: any) => ({ resource_id: c.resource_id, display_name: c.display_name, covered_inputs: c.covered_inputs })));
    }).catch(() => setCompatible([]));
  }, [dsId, availableSemTypes.join(',')]);

  const filteredFns = useMemo(() => {
    const q = paletteFilter.trim().toLowerCase();
    return functions.filter((f) => !q || f.display_name.toLowerCase().includes(q) || f.function_name.toLowerCase().includes(q));
  }, [functions, paletteFilter]);

  const updateBoundParam = (argName: string, value: unknown) => {
    if (!selected) return;
    pushHistory();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== selected.id) return n;
      const next = { ...n.data.bound_params };
      if (value === undefined) {
        delete next[argName];
      } else {
        next[argName] = value;
      }
      return { ...n, data: { ...n.data, bound_params: next } };
    }));
  };

  // DAG-PUBLISH-V01: toggle whether a bound_param is exposed to BI_USER as a
  // form input on the published page. Updates the parallel `user_input_params`
  // array on n.data; bound_params keeps the admin-side default value, which
  // the published exec injects only when the form leaves the field blank.
  const toggleUserInput = (nodeId: string, argName: string) => {
    pushHistory();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const cur = new Set<string>(n.data.user_input_params || []);
      if (cur.has(argName)) cur.delete(argName);
      else cur.add(argName);
      return { ...n, data: { ...n.data, user_input_params: Array.from(cur) } };
    }));
  };

  // DAG-PUBLISH-V01-FU: toggle whether a non-leaf node's frame is surfaced as
  // an extra output block on the published page. Leaf is always exposed (the
  // primary), so the UI disables the checkbox there. Persisted on
  // n.data.expose_output; publish handler unions it with the leaf id into
  // dag_snapshot.exposed_node_ids.
  const toggleExposeOutput = (nodeId: string) => {
    pushHistory();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      return { ...n, data: { ...n.data, expose_output: !n.data.expose_output } };
    }));
  };

  const canUndo = historyPastRef.current.length > 0;
  const canRedo = historyFutureRef.current.length > 0;
  const selectionCount = selectedNodes.length + selectedEdges.length + (selected && !selectedNodes.find((n) => n.id === selected.id) ? 1 : 0);

  return (
    <div data-testid="dag-tab" className="space-y-4">
      <PageHeader title="Flow Composer" subtitle="視覺化組合 L1-L4 functions 為可執行 DAG(W6+)" />

      {/* ── Top bar: DS + DAG picker + actions ── */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-center gap-2">
        <Database size={16} className="text-slate-500" />
        <select
          aria-label="Data source"
          value={dsId}
          onChange={(e) => { resetCanvas(); setDsId(e.target.value); }}
          className="border border-slate-300 rounded px-2 py-1 text-sm"
        >
          {dataSources.map((d) => <option key={d.source_id} value={d.source_id}>{d.display_name || d.source_id}</option>)}
        </select>

        <select
          aria-label="DAG"
          value={currentDagId || ''}
          onChange={(e) => { if (e.target.value) loadDag(e.target.value); else resetCanvas(); }}
          className="border border-slate-300 rounded px-2 py-1 text-sm min-w-[200px]"
        >
          <option value="">— New DAG —</option>
          {dags.map((d) => <option key={d.resource_id} value={d.resource_id}>{d.display_name} ({d.node_count}n)</option>)}
        </select>

        <input
          aria-label="DAG name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1 text-sm flex-1 min-w-[200px]"
          placeholder="DAG name"
        />

        <button
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl/Cmd+Z)"
          className="btn-secondary text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Undo2 size={14} /> Undo
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl/Cmd+Shift+Z)"
          className="btn-secondary text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Redo2 size={14} /> Redo
        </button>
        <button
          onClick={deleteSelected}
          disabled={selectionCount === 0}
          title="Delete selected (Del / Backspace)"
          data-testid="delete-selected"
          className="btn-secondary text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed text-red-600"
        >
          <X size={14} /> Delete{selectionCount > 1 ? ` (${selectionCount})` : ''}
        </button>

        <button onClick={validate} className="btn-secondary text-sm flex items-center gap-1">
          <CheckCircle2 size={14} /> Validate
        </button>
        <button
          onClick={runAll}
          disabled={running !== null || nodes.length === 0}
          data-testid="run-all"
          className="btn-secondary text-sm flex items-center gap-1"
          title="Execute all nodes in topological order"
        >
          {running !== null ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Run all
        </button>
        <button onClick={save} disabled={saving} className="btn-primary text-sm flex items-center gap-1">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
        {currentDagId && (() => {
          const exposedCount = nodes.reduce(
            (acc, n) => acc + ((n.data.user_input_params?.length) || 0),
            0,
          );
          // DAG-PUBLISH-V01-FU: count admin-flagged extra outputs (leaf is
          // implicitly always exposed and excluded here so the count
          // reflects opt-in surface area).
          const sources = new Set(edges.map((e) => e.source));
          const extraOutputCount = nodes.filter(
            (n) => n.data.expose_output && sources.has(n.id) && n.data.sink_kind == null,
          ).length;
          return (
            <button
              onClick={() => setPublishOpen(true)}
              data-testid="dag-publish-open"
              disabled={exposedCount === 0}
              title={exposedCount === 0
                ? 'Tick "Expose as form input" on at least one bound param before publishing'
                : `Publish DAG as a Tier B page — ${exposedCount} form input${exposedCount === 1 ? '' : 's'} exposed${extraOutputCount > 0 ? `, ${extraOutputCount} extra output${extraOutputCount === 1 ? '' : 's'}` : ''}`}
              className="btn-primary text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-600 hover:bg-emerald-700"
            >
              <Upload size={14} /> Publish
            </button>
          );
        })()}
        {currentDagId && (
          <button onClick={del} className="btn-danger text-sm flex items-center gap-1">
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>

      {/* ── Validation issues panel ── */}
      {issues.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-sm font-medium text-slate-700 mb-2">
            {issues.filter((i) => i.severity === 'error').length} error(s), {issues.filter((i) => i.severity === 'warn').length} warning(s)
          </div>
          <ul className="space-y-1 text-xs">
            {issues.map((i, idx) => (
              <li key={idx} className={i.severity === 'error' ? 'text-red-600' : 'text-amber-600'}>
                <AlertCircle size={12} className="inline mr-1" />
                [{i.code}] {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Three-pane layout: collapsible Palette / fluid Canvas / collapsible Inspector.
          Canvas height tracks viewport (calc) so wider screens get a bigger drawing area. */}
      <div
        className="flex gap-4"
        style={{ height: 'calc(100vh - 240px)', minHeight: 560 }}
      >
        {/* ── Left: Palette ── */}
        {paletteCollapsed ? (
          <div className="bg-white border border-slate-200 rounded-lg p-2 flex flex-col items-center gap-2 shrink-0" style={{ width: 44 }}>
            <button
              onClick={() => setPaletteCollapsed(false)}
              title="Expand palette"
              data-testid="palette-expand"
              className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
            >
              <PanelLeftOpen size={16} />
            </button>
            <div className="text-[10px] uppercase text-slate-400 [writing-mode:vertical-rl] mt-2">Palette ({filteredFns.length})</div>
          </div>
        ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-col shrink-0" style={{ width: 280 }}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Palette</div>
            <button
              onClick={() => setPaletteCollapsed(true)}
              title="Collapse palette"
              data-testid="palette-collapse"
              className="p-1 rounded hover:bg-slate-100 text-slate-500"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
          <div className="flex items-center gap-2 mb-2">
            <Search size={14} className="text-slate-400" />
            <input
              aria-label="Filter functions"
              value={paletteFilter}
              onChange={(e) => setPaletteFilter(e.target.value)}
              placeholder="Filter…"
              className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
            />
          </div>

          {compatible.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-emerald-700 flex items-center gap-1 mb-1">
                <Sparkles size={12} /> Compatible ({compatible.length})
              </div>
              <div className="space-y-1 overflow-y-auto" style={{ maxHeight: 160 }}>
                {compatible.map((c) => {
                  const fn = functions.find((f) => f.resource_id === c.resource_id);
                  if (!fn) return null;
                  return (
                    <button
                      key={c.resource_id}
                      onClick={() => addFunctionNode(fn)}
                      data-testid={`compat-${fn.function_name}`}
                      className="w-full text-left text-xs px-2 py-1 rounded border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800"
                      title={`Matches: ${c.covered_inputs.join(', ')}`}
                    >
                      <Plus size={10} className="inline mr-1" /> {fn.function_name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Operators — composer-native primitives (no PG fn registration).
              See .claude/plans/v3-phase-1/composer-operator-and-sink.md §3.1 */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wide text-orange-700 flex items-center gap-1 mb-1">
              <Sparkles size={12} /> Operators
            </div>
            <div className="space-y-1">
              {(['literal', 'filter', 'cast', 'aggregate'] as const).map((k) => {
                const style = OP_STYLES[k];
                return (
                  <button
                    key={k}
                    onClick={() => addOperatorNode(k)}
                    data-testid={`palette-op-${k}`}
                    className="w-full text-left text-xs px-2 py-1 rounded border border-orange-200 bg-orange-50 hover:bg-orange-100 text-slate-700 flex items-center gap-1.5"
                    title={
                      k === 'literal' ? 'Emit a typed constant'
                      : k === 'filter' ? 'Filter upstream rows by predicate'
                      : k === 'cast' ? 'Cast a column to a different pgType'
                      : 'Group rows + sum/count/min/max/avg'
                    }
                  >
                    <span style={{ color: style.accent, fontSize: 14 }}>{style.glyph}</span>
                    <span className="font-medium">{k}</span>
                    <span className="text-[10px] text-slate-400 ml-auto">op</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sub-DAG — DAG-SUBDAG-EMBED-V01.
              Embeds a published_dag inline at parent publish time. Same
              data_source_id required (cross-ds blocked at resolver). */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wide text-indigo-700 flex items-center gap-1 mb-1">
              <Workflow size={12} /> Sub-DAG
            </div>
            <div className="space-y-1">
              <button
                onClick={addSubdagNode}
                data-testid="palette-subdag"
                className="w-full text-left text-xs px-2 py-1 rounded border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-slate-700 flex items-center gap-1.5"
                title="Embed a published_dag inline. Pick which child published_dag in the Inspector."
              >
                <span style={{ color: '#4338ca', fontSize: 14 }}>⤵</span>
                <span className="font-medium">embed published_dag</span>
                <span className="text-[10px] text-slate-400 ml-auto">subdag</span>
              </button>
            </div>
          </div>

          {/* Sinks — composer-native terminal artifacts.
              See .claude/plans/v3-phase-1/sink-as-node-kind-plan.md §3.5 */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-700 flex items-center gap-1 mb-1">
              <FileOutput size={12} /> Sinks
            </div>
            <div className="space-y-1">
              <button
                onClick={() => addSinkNode('page')}
                data-testid="palette-sink-page"
                className="w-full text-left text-xs px-2 py-1 rounded border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 flex items-center gap-1.5"
                title="Snapshot upstream rows as a Tier B page (Curator can find it under Modules)"
              >
                <span style={{ fontSize: 14 }}>🗄</span>
                <span className="font-medium">page snapshot</span>
                <span className="text-[10px] text-slate-400 ml-auto">sink</span>
              </button>
            </div>
          </div>

          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">All Functions ({filteredFns.length})</div>
          <div className="space-y-1 overflow-y-auto flex-1">
            {filteredFns.map((fn) => (
              <button
                key={fn.resource_id}
                onClick={() => addFunctionNode(fn)}
                data-testid={`palette-${fn.function_name}`}
                className="w-full text-left text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-slate-700"
              >
                <Plus size={10} className="inline mr-1" />
                {fn.function_name}
                <span className="text-[10px] text-slate-400 ml-1">[{fn.subtype}]</span>
              </button>
            ))}
            {filteredFns.length === 0 && <EmptyState message="No functions" hint="Deploy functions via Query Tool first" icon={<FileText size={24} />} />}
          </div>
        </div>
        )}

        {/* ── Center: Canvas ── */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col flex-1 min-w-0">
          {/* Semantic legend — only show types actually present on the canvas */}
          {(() => {
            const present = new Set<string>();
            nodes.forEach((n) => {
              n.data.inputs.forEach((i) => i.semantic_type && i.semantic_type !== 'unknown' && present.add(i.semantic_type));
              n.data.outputs.forEach((o) => o.semantic_type && o.semantic_type !== 'unknown' && present.add(o.semantic_type));
            });
            const list = Array.from(present);
            if (list.length === 0) return null;
            return (
              <div
                className="px-3 py-1.5 border-b border-slate-200 bg-slate-50 flex items-center gap-3 flex-wrap text-[10px] text-slate-600"
                title="Connection compatibility is enforced by pgType family (text / number / date / json / …). semantic_type is advisory: same pgType + different semantic shows an amber dashed edge but is still allowed."
              >
                <span className="font-semibold uppercase tracking-wide">Types</span>
                <span className="text-slate-400">advisory · pgType is the hard rule</span>
                {list.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: colorFor(t) }} />
                    {t}
                  </span>
                ))}
              </div>
            );
          })()}
          <div className="relative flex-1">
            <ReactFlowProvider>
              <DragSrcContext.Provider value={dragSrc}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onConnectStart={onConnectStart}
                  onConnectEnd={onConnectEnd}
                  isValidConnection={isValidConnection}
                  onNodeClick={(_, n) => setSelectedId(n.id)}
                  onPaneClick={() => setSelectedId(null)}
                  nodeTypes={nodeTypes}
                  deleteKeyCode={['Delete', 'Backspace']}
                  multiSelectionKeyCode={['Control', 'Meta']}
                  selectionKeyCode={'Shift'}
                  fitView
                >
                  <Background />
                  <Controls />
                  <MiniMap />
                </ReactFlow>
              </DragSrcContext.Provider>
            </ReactFlowProvider>
            {nodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center text-slate-400 max-w-xs">
                  <Workflow size={36} className="mx-auto mb-2 opacity-60" />
                  <div className="text-sm font-medium text-slate-500">Empty canvas</div>
                  <div className="text-xs mt-1">Click a function in the left palette to add it as a node, then drag from output (right) to input (left) to connect.</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {savePageOpenFor && (() => {
          const node = nodes.find((n) => n.id === savePageOpenFor);
          if (!node || !node.data.last_result || !currentDagId) return null;
          return (
            <SaveAsPageDialog
              dagId={currentDagId}
              node={node}
              onClose={() => setSavePageOpenFor(null)}
              onSaved={(pid) => {
                setSavePageOpenFor(null);
                showToast(`Saved as page "${pid}". Opening it now…`, 'success');
                // Re-use the BU-08 auto-page slot to land on the new page
                // immediately. ModulesTab walks the resource tree, not
                // authz_ui_page.parent_page_id, so a hand-attached snapshot
                // is not yet auto-listed there. Auto-page tab is the
                // cleanest existing surface for "open arbitrary page_id".
                window.dispatchEvent(new CustomEvent('open-auto-page', { detail: { page_id: pid } }));
              }}
            />
          );
        })()}

        {publishOpen && currentDagId && (
          <PublishDagDialog
            dagId={currentDagId}
            displayName={displayName}
            description={description}
            nodes={nodes}
            onClose={() => setPublishOpen(false)}
            onPublished={(pid) => {
              setPublishOpen(false);
              showToast(`Published as page "${pid}". Opening it now…`, 'success');
              window.dispatchEvent(new CustomEvent('open-auto-page', { detail: { page_id: pid } }));
            }}
          />
        )}

        {/* ── Right: Inspector ── */}
        {inspectorCollapsed ? (
          <div className="bg-white border border-slate-200 rounded-lg p-2 flex flex-col items-center gap-2 shrink-0" style={{ width: 44 }}>
            <button
              onClick={() => setInspectorCollapsed(false)}
              title="Expand inspector"
              data-testid="inspector-expand"
              className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
            >
              <PanelRightOpen size={16} />
            </button>
            <div className="text-[10px] uppercase text-slate-400 [writing-mode:vertical-rl] mt-2">
              {selected ? selected.data.label.slice(0, 24) : 'Inspector'}
            </div>
          </div>
        ) : (
        <div className="bg-white border border-slate-200 rounded-lg flex flex-col shrink-0" style={{ width: 320 }}>
          <div className="flex items-center justify-between p-2 border-b border-slate-100">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Inspector</div>
            <button
              onClick={() => setInspectorCollapsed(true)}
              title="Collapse inspector"
              data-testid="inspector-collapse"
              className="p-1 rounded hover:bg-slate-100 text-slate-500"
            >
              <PanelRightClose size={14} />
            </button>
          </div>
          <div className="p-3 overflow-y-auto flex-1">
          {!selected ? (
            <EmptyState message="No node selected" hint="Click a node to bind parameters or run it." icon={<Workflow size={24} />} />
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900 truncate">{selected.data.label}</div>
                  <div className="text-xs text-slate-500 truncate">{selected.data.resource_id}</div>
                  <div className="text-[10px] uppercase text-slate-400 mt-1">{selected.data.subtype}</div>
                </div>
                <button
                  onClick={deleteSelected}
                  title="Delete this node (Del)"
                  data-testid={`delete-node-${selected.id}`}
                  className="shrink-0 text-red-600 hover:bg-red-50 rounded p-1"
                  aria-label="Delete node"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* Expose output — DAG-PUBLISH-V01-FU §5. Visible for fn + op
                  nodes (skip sink: sinks are not runtime outputs; skip subdag:
                  child's leaf is the surfaced output). Leaf is forced-on;
                  admin opt-in for intermediate frames. */}
              {!selected.data.sink_kind && selected.type !== 'subdag' && (() => {
                const isLeaf = !edges.some((e) => e.source === selected.id);
                const checked = isLeaf || !!selected.data.expose_output;
                return (
                  <label
                    className={`flex items-center gap-2 text-xs rounded border px-2 py-1.5 cursor-pointer select-none ${
                      checked ? 'border-indigo-300 bg-indigo-50/40 text-indigo-800' : 'border-slate-200 text-slate-700'
                    } ${isLeaf ? 'cursor-not-allowed opacity-90' : ''}`}
                    title={
                      isLeaf
                        ? 'Leaf node is always exposed as the primary output.'
                        : 'When ticked, this node\'s frame is surfaced on the published Tier B page as an extra output block alongside the leaf.'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isLeaf}
                      onChange={() => !isLeaf && toggleExposeOutput(selected.id)}
                      data-testid={`expose-output-${selected.id}`}
                      className="h-3 w-3"
                    />
                    <span className="font-medium">
                      Expose output to Tier B
                      {isLeaf && <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">(leaf — auto)</span>}
                    </span>
                  </label>
                );
              })()}

              {/* Operator-specific config block — composer-operator-and-sink §3.1 */}
              {selected.data.op_kind && (
                <OperatorInspector
                  opKind={selected.data.op_kind}
                  config={selected.data.op_config}
                  upstreamColumns={(() => {
                    const inEdge = edges.find((e) => e.target === selected.id);
                    if (!inEdge) return [];
                    const upNode = nodes.find((n) => n.id === inEdge.source);
                    return upNode?.data.last_result?.columns || upNode?.data.outputs || [];
                  })()}
                  onChange={updateOpConfig}
                />
              )}

              {/* Sink-specific config block — sink-as-node-kind plan §3.4 */}
              {selected.data.sink_kind && (() => {
                const cfg = (selected.data.sink_config || { kind: 'page' }) as PageSinkConfig;
                const lastRun = selected.data.sink_last_run;
                return (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-slate-700">Sink kind</div>
                    <select
                      data-testid={`sink-kind-${selected.id}`}
                      value={selected.data.sink_kind}
                      disabled
                      className="w-full text-xs border border-slate-200 rounded px-2 py-1 bg-slate-50 text-slate-700"
                      title="MVP supports 'page' only; api / scheduled_job arriving in next sprint"
                    >
                      <option value="page">page snapshot</option>
                    </select>

                    <div>
                      <label className="block text-xs text-slate-700 font-medium mb-1">Page ID</label>
                      <input
                        data-testid={`sink-page-id-${selected.id}`}
                        value={cfg.page_id || ''}
                        onChange={(e) => updateSinkConfig({ page_id: e.target.value.toLowerCase() })}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
                        placeholder="lowercase, starts with letter"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-slate-700 font-medium mb-1">Title</label>
                      <input
                        data-testid={`sink-title-${selected.id}`}
                        value={cfg.title || ''}
                        onChange={(e) => updateSinkConfig({ title: e.target.value })}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-slate-700 font-medium mb-1">Parent page</label>
                      <input
                        data-testid={`sink-parent-${selected.id}`}
                        value={cfg.parent_page_id || ''}
                        onChange={(e) => updateSinkConfig({ parent_page_id: e.target.value })}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
                        placeholder="modules_home"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-slate-700 font-medium mb-1">Description</label>
                      <textarea
                        data-testid={`sink-description-${selected.id}`}
                        value={cfg.description || ''}
                        onChange={(e) => updateSinkConfig({ description: e.target.value })}
                        rows={2}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1"
                      />
                    </div>

                    <label className="flex items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        checked={!!cfg.overwrite}
                        onChange={(e) => updateSinkConfig({ overwrite: e.target.checked })}
                        data-testid={`sink-overwrite-${selected.id}`}
                      />
                      Overwrite if page_id exists
                    </label>

                    {lastRun && (
                      <div className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-1.5">
                        ✓ {lastRun.status} {lastRun.row_count} rows<br/>
                        artifact: <span className="font-mono">{lastRun.artifact_id}</span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Subdag-specific config block — DAG-SUBDAG-EMBED-V01.
                  Persists only resource_id + subdag_source_output_node_id +
                  subdag_user_inputs + bound_subdag_params on n.data; the
                  fetched snapshot meta (form_schema, exposed_node_ids) lives
                  in component-local cache so it can't go stale on the row. */}
              {selected.type === 'subdag' && (
                <SubdagInspector
                  selectedId={selected.id}
                  data={selected.data}
                  dataSourceId={dsId}
                  onChange={updateSubdagData}
                />
              )}

              {!selected.data.op_kind && !selected.data.sink_kind && selected.type !== 'subdag' && (
              <div>
                <div className="text-xs font-medium text-slate-700 mb-1">Inputs</div>
                <div className="space-y-2">
                  {selected.data.inputs.map((i) => {
                    const bound = (selected.data.bound_params as any)[i.name];
                    const hasEdge = edges.some((e) => e.target === selected.id && e.targetHandle === i.name);
                    const isUserInput = (selected.data.user_input_params || []).includes(i.name);
                    return (
                      <div key={i.name} className={`border rounded p-2 ${isUserInput ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'}`}>
                        <div className="text-xs flex items-center justify-between">
                          <span>
                            <span style={{ color: colorFor(i.semantic_type) }}>●</span> {i.name}
                            {i.hasDefault && <span className="text-slate-400 ml-1">(opt)</span>}
                          </span>
                          <span className="text-[10px] text-slate-500">{i.semantic_type || 'unknown'}</span>
                        </div>
                        {!hasEdge && (
                          <label
                            className="flex items-center gap-1.5 text-[10px] text-slate-700 mt-1 cursor-pointer select-none"
                            title="When ticked, this param appears as a form input on the published Tier B page. The bound value below becomes the form's default."
                          >
                            <input
                              type="checkbox"
                              checked={isUserInput}
                              onChange={() => toggleUserInput(selected.id, i.name)}
                              data-testid={`user-input-${selected.id}-${i.name}`}
                              className="h-3 w-3"
                            />
                            <span className={isUserInput ? 'text-emerald-700 font-medium' : ''}>
                              Expose as form input{isUserInput ? ' ✓' : ''}
                            </span>
                          </label>
                        )}
                        {hasEdge ? (
                          <div className="text-[10px] text-emerald-700 mt-1">↑ connected (upstream)</div>
                        ) : (() => {
                          const isArray = !!(i.pgType && i.pgType.endsWith('[]'));
                          const display = bound == null
                            ? ''
                            : Array.isArray(bound) ? bound.join(', ') : String(bound);
                          const placeholder = isArray
                            ? (i.hasDefault ? 'default — or comma-separated, e.g. PS5021, PS5031' : 'comma-separated, e.g. PS5021, PS5031')
                            : (i.hasDefault ? 'default' : 'required');
                          return (
                            <>
                              <input
                                aria-label={`param-${i.name}`}
                                data-testid={`param-${selected.id}-${i.name}`}
                                value={display}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  if (isArray) {
                                    const arr = raw
                                      .split(',')
                                      .map((s) => s.trim())
                                      .filter((s) => s.length > 0);
                                    updateBoundParam(i.name, arr.length === 0 ? undefined : arr);
                                  } else {
                                    updateBoundParam(i.name, raw);
                                  }
                                }}
                                placeholder={placeholder}
                                className="w-full mt-1 text-xs border border-slate-200 rounded px-2 py-1"
                              />
                              {isArray && (
                                <div className="text-[10px] text-slate-400 mt-1">{i.pgType} — sent as array</div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    );
                  })}
                  {selected.data.inputs.length === 0 && <div className="text-xs text-slate-400">no inputs</div>}
                </div>
              </div>
              )}

              {selected.data.sink_kind ? (
                <button
                  data-testid={`execute-sink-${selected.id}`}
                  onClick={() => executeSink(selected.id)}
                  disabled={running === selected.id}
                  className="w-full btn-primary text-sm flex items-center justify-center gap-1"
                  title="Snapshot upstream's last_result into the configured Tier B page"
                >
                  {running === selected.id ? <Loader2 size={14} className="animate-spin" /> : <FileOutput size={14} />}
                  Execute sink
                </button>
              ) : (
                <button
                  data-testid={`run-${selected.id}`}
                  onClick={() => executeNode(selected.id)}
                  disabled={running === selected.id}
                  className="w-full btn-primary text-sm flex items-center justify-center gap-1"
                >
                  {running === selected.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  Run this node
                </button>
              )}

              {selected.data.last_result && (
                <div className="border-t border-slate-200 pt-3 space-y-2">
                  <div className="text-xs font-medium text-slate-700">
                    Last result: {selected.data.last_result.row_count} rows • {selected.data.last_result.elapsed_ms}ms
                  </div>
                  {selected.data.last_result.lineage.length > 0 && (
                    <div className="text-[10px] text-slate-500">
                      <div className="font-medium">Lineage:</div>
                      {selected.data.last_result.lineage.map((l, i) => (
                        <div key={i}>{l.input} ← {l.source}</div>
                      ))}
                    </div>
                  )}
                  {selected.data.last_result.rows.length > 0 && (
                    <div className="text-[10px] bg-slate-50 rounded p-2 overflow-auto max-h-40">
                      <pre>{JSON.stringify(selected.data.last_result.rows[0], null, 2)}</pre>
                    </div>
                  )}
                  {currentDagId ? (
                    <button
                      data-testid={`save-as-page-${selected.id}`}
                      onClick={() => setSavePageOpenFor(selected.id)}
                      className="w-full btn-secondary text-xs flex items-center justify-center gap-1"
                      title="Snapshot these rows as a Tier B page (Curator can find it under Modules)"
                    >
                      <FileOutput size={12} /> Save as page
                    </button>
                  ) : (
                    <div className="text-[10px] text-slate-400 italic">Save the DAG first to enable snapshot pages.</div>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

// ── Operator inspector (composer-operator-and-sink §3.1) ──
// Renders config form per op_kind. Upstream columns come from the connected
// upstream node's last_result (so curator can dropdown-pick column names
// instead of typing them).
function OperatorInspector({
  opKind, config, upstreamColumns, onChange,
}: {
  opKind: OpKind;
  config?: OpConfig;
  upstreamColumns: Array<{ name: string; semantic_type?: string; pgType?: string }>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const c = (config || {}) as any;
  const PG_TYPES = ['text', 'int', 'numeric', 'boolean', 'date', 'timestamp', 'jsonb'];

  if (opKind === 'literal') {
    return (
      <div className="border border-orange-200 bg-orange-50 rounded p-2 space-y-2">
        <div className="text-xs font-medium text-orange-800">Literal config</div>
        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Value</label>
          <input
            data-testid="op-literal-value"
            value={c.value ?? ''}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="e.g. 42"
            className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">pgType</label>
          <select
            data-testid="op-literal-pgtype"
            value={c.pgType || 'text'}
            onChange={(e) => onChange({ pgType: e.target.value })}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1"
          >
            {PG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">semantic_type (optional)</label>
          <input
            data-testid="op-literal-semantic"
            value={c.semantic_type || ''}
            onChange={(e) => onChange({ semantic_type: e.target.value || undefined })}
            placeholder="e.g. material_no"
            className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
          />
        </div>
      </div>
    );
  }

  if (opKind === 'filter') {
    return (
      <div className="border border-emerald-200 bg-emerald-50 rounded p-2 space-y-2">
        <div className="text-xs font-medium text-emerald-800">Filter config</div>
        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Column</label>
          {upstreamColumns.length > 0 ? (
            <select
              data-testid="op-filter-column"
              value={c.column || ''}
              onChange={(e) => onChange({ column: e.target.value })}
              className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
            >
              <option value="">— pick column —</option>
              {upstreamColumns.map((col) => <option key={col.name} value={col.name}>{col.name}</option>)}
            </select>
          ) : (
            <input
              data-testid="op-filter-column"
              value={c.column || ''}
              onChange={(e) => onChange({ column: e.target.value })}
              placeholder="(connect upstream + run it to see columns)"
              className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
            />
          )}
        </div>
        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Operator</label>
          <select
            data-testid="op-filter-op"
            value={c.op || 'eq'}
            onChange={(e) => onChange({ op: e.target.value })}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1"
          >
            {['eq', 'ne', 'in', 'gt', 'lt', 'like'].map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Value</label>
          <input
            data-testid="op-filter-value"
            value={c.value ?? ''}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder={c.op === 'in' ? 'comma-separated, e.g. A,B,C' : c.op === 'like' ? 'SQL LIKE: % _ wildcards' : 'value'}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
          />
        </div>
      </div>
    );
  }

  if (opKind === 'aggregate') {
    const groupBy: string[] = c.group_by || [];
    const aggs: AggregateSpec[] = c.aggregations || [];
    const setGroupBy = (next: string[]) => onChange({ group_by: next });
    const setAggs = (next: AggregateSpec[]) => onChange({ aggregations: next });
    const colNames = upstreamColumns.map((col) => col.name);
    return (
      <div className="border border-amber-200 bg-amber-50 rounded p-2 space-y-2">
        <div className="text-xs font-medium text-amber-800">Aggregate config</div>

        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Group by</label>
          <div className="space-y-1">
            {groupBy.length === 0 && (
              <div className="text-[10px] text-slate-500 italic">no groups → 1 row over all upstream rows</div>
            )}
            {groupBy.map((col, i) => (
              <div key={i} className="flex gap-1">
                {colNames.length > 0 ? (
                  <select
                    data-testid={`op-agg-groupby-${i}`}
                    value={col}
                    onChange={(e) => {
                      const next = [...groupBy];
                      next[i] = e.target.value;
                      setGroupBy(next);
                    }}
                    className="flex-1 text-xs border border-slate-200 rounded px-2 py-1 font-mono"
                  >
                    <option value="">— pick column —</option>
                    {colNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (
                  <input
                    data-testid={`op-agg-groupby-${i}`}
                    value={col}
                    onChange={(e) => {
                      const next = [...groupBy];
                      next[i] = e.target.value;
                      setGroupBy(next);
                    }}
                    placeholder="column name"
                    className="flex-1 text-xs border border-slate-200 rounded px-2 py-1 font-mono"
                  />
                )}
                <button
                  type="button"
                  data-testid={`op-agg-groupby-remove-${i}`}
                  onClick={() => setGroupBy(groupBy.filter((_, j) => j !== i))}
                  className="text-xs px-2 rounded border border-slate-200 bg-white hover:bg-slate-50"
                >×</button>
              </div>
            ))}
            <button
              type="button"
              data-testid="op-agg-groupby-add"
              onClick={() => setGroupBy([...groupBy, ''])}
              className="w-full text-[10px] uppercase tracking-wide px-2 py-1 rounded border border-dashed border-amber-300 text-amber-700 hover:bg-amber-100"
            >+ group key</button>
          </div>
        </div>

        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Aggregations</label>
          <div className="space-y-1">
            {aggs.map((a, i) => (
              <div key={i} className="grid grid-cols-[60px_1fr_1fr_auto] gap-1 items-center">
                <select
                  data-testid={`op-agg-fn-${i}`}
                  value={a.fn}
                  onChange={(e) => {
                    const next = [...aggs];
                    next[i] = { ...a, fn: e.target.value as AggregateFn };
                    setAggs(next);
                  }}
                  className="text-xs border border-slate-200 rounded px-1 py-1"
                >
                  {(['sum', 'count', 'min', 'max', 'avg'] as const).map((fn) => <option key={fn} value={fn}>{fn}</option>)}
                </select>
                {colNames.length > 0 ? (
                  <select
                    data-testid={`op-agg-col-${i}`}
                    value={a.column}
                    onChange={(e) => {
                      const next = [...aggs];
                      next[i] = { ...a, column: e.target.value };
                      setAggs(next);
                    }}
                    className="text-xs border border-slate-200 rounded px-1 py-1 font-mono"
                  >
                    <option value="">— column —</option>
                    {colNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (
                  <input
                    data-testid={`op-agg-col-${i}`}
                    value={a.column}
                    onChange={(e) => {
                      const next = [...aggs];
                      next[i] = { ...a, column: e.target.value };
                      setAggs(next);
                    }}
                    placeholder="column"
                    className="text-xs border border-slate-200 rounded px-1 py-1 font-mono"
                  />
                )}
                <input
                  data-testid={`op-agg-alias-${i}`}
                  value={a.alias || ''}
                  onChange={(e) => {
                    const next = [...aggs];
                    const v = e.target.value.trim();
                    next[i] = v ? { ...a, alias: v } : { fn: a.fn, column: a.column };
                    setAggs(next);
                  }}
                  placeholder="alias"
                  className="text-xs border border-slate-200 rounded px-1 py-1 font-mono"
                />
                <button
                  type="button"
                  data-testid={`op-agg-remove-${i}`}
                  onClick={() => setAggs(aggs.filter((_, j) => j !== i))}
                  className="text-xs px-2 rounded border border-slate-200 bg-white hover:bg-slate-50"
                >×</button>
              </div>
            ))}
            <button
              type="button"
              data-testid="op-agg-add"
              onClick={() => setAggs([...aggs, { fn: 'count', column: '' }])}
              className="w-full text-[10px] uppercase tracking-wide px-2 py-1 rounded border border-dashed border-amber-300 text-amber-700 hover:bg-amber-100"
            >+ aggregation</button>
          </div>
        </div>
      </div>
    );
  }

  // cast
  return (
    <div className="border border-blue-200 bg-blue-50 rounded p-2 space-y-2">
      <div className="text-xs font-medium text-blue-800">Cast config</div>
      <div>
        <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Source column</label>
        {upstreamColumns.length > 0 ? (
          <select
            data-testid="op-cast-column"
            value={c.source_column || ''}
            onChange={(e) => onChange({ source_column: e.target.value })}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
          >
            <option value="">— pick column —</option>
            {upstreamColumns.map((col) => (
              <option key={col.name} value={col.name}>
                {col.name} {col.pgType ? `(${col.pgType})` : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            data-testid="op-cast-column"
            value={c.source_column || ''}
            onChange={(e) => onChange({ source_column: e.target.value })}
            placeholder="(connect upstream + run it to see columns)"
            className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
          />
        )}
      </div>
      <div>
        <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Target pgType</label>
        <select
          data-testid="op-cast-target-pgtype"
          value={c.target_pgType || 'text'}
          onChange={(e) => onChange({ target_pgType: e.target.value })}
          className="w-full text-xs border border-slate-200 rounded px-2 py-1"
        >
          {PG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Target semantic_type (optional)</label>
        <input
          data-testid="op-cast-target-semantic"
          value={c.target_semantic_type || ''}
          onChange={(e) => onChange({ target_semantic_type: e.target.value || undefined })}
          placeholder="e.g. material_no"
          className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
        />
      </div>
    </div>
  );
}

// ── Sub-DAG inspector (DAG-SUBDAG-EMBED-V01) ──
// Authoring surface for `type='subdag'` nodes:
//   1. Pick a child published_dag (filtered to current ds by /published-list).
//   2. Pick which exposed child output to plug into parent (defaults to leaf).
//   3. Per child user_input: surface to parent form vs. bind override.
//
// Snapshot meta (form_schema, exposed_node_ids) is fetched on demand and
// cached in component-local state — NOT persisted on n.data — because save
// is verbatim, and stale meta would silently shadow the live published_dag
// on the next publish. Persistence is limited to what the resolver consumes:
// resource_id, subdag_source_output_node_id, subdag_user_inputs,
// bound_subdag_params.
//
// Default surfacing strategy: when curator picks a child published_dag for
// the first time, pre-tick *all* its user_input_params as surfaced. "All
// surfaced" is the safer non-destructive default — curator can untick later
// to demote into bound_subdag_params.
type SnapshotMeta = {
  data_source_id: string;
  output_node_id: string;
  exposed_node_ids: string[] | null;
  form_schema: Array<{ name: string; type: string; pg_type?: string; required: boolean; default: unknown; help_text?: string; source_node_id: string }>;
};

function SubdagInspector({
  selectedId, data, dataSourceId, onChange,
}: {
  selectedId: string;
  data: NodeData;
  dataSourceId: string;
  onChange: (patch: Partial<Pick<NodeData,
    'resource_id' | 'label' | 'subdag_source_output_node_id' | 'subdag_user_inputs' | 'bound_subdag_params'
  >>) => void;
}) {
  const [available, setAvailable] = useState<Array<{ rid: string; title: string; output_node_id: string; exposed_node_ids: string[] | null }>>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // metaCache: rid → SnapshotMeta. Per-Inspector instance, drops on close.
  const [metaCache, setMetaCache] = useState<Record<string, SnapshotMeta>>({});
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const childRid = data.resource_id || '';
  const meta: SnapshotMeta | undefined = childRid ? metaCache[childRid] : undefined;

  // Load published_dag list (filtered to parent's data source).
  useEffect(() => {
    if (!dataSourceId) {
      setAvailable([]);
      return;
    }
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    api.dagPublishedList(dataSourceId)
      .then((r) => {
        if (cancelled) return;
        setAvailable(r.published_dags.map((p) => ({
          rid: p.rid,
          title: p.title,
          output_node_id: p.output_node_id,
          exposed_node_ids: p.exposed_node_ids,
        })));
      })
      .catch((e) => { if (!cancelled) setListError(String(e)); })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [dataSourceId]);

  // Load snapshot meta for the picked rid.
  useEffect(() => {
    if (!childRid) return;
    if (metaCache[childRid]) return;
    let cancelled = false;
    setMetaLoading(true);
    setMetaError(null);
    api.dagPublishedSnapshotMeta(childRid)
      .then((r) => {
        if (cancelled) return;
        setMetaCache((prev) => ({
          ...prev,
          [childRid]: {
            data_source_id: r.data_source_id,
            output_node_id: r.output_node_id,
            exposed_node_ids: r.exposed_node_ids,
            form_schema: r.form_schema || [],
          },
        }));
      })
      .catch((e) => { if (!cancelled) setMetaError(String(e)); })
      .finally(() => { if (!cancelled) setMetaLoading(false); });
    return () => { cancelled = true; };
  }, [childRid, metaCache]);

  const surfacedSet = new Set(data.subdag_user_inputs || []);
  const boundOverrides = (data.bound_subdag_params || {}) as Record<string, unknown>;

  const pickRid = (rid: string) => {
    if (!rid) {
      onChange({ resource_id: '', label: 'sub-DAG', subdag_source_output_node_id: undefined, subdag_user_inputs: [], bound_subdag_params: {} });
      return;
    }
    const picked = available.find((a) => a.rid === rid);
    const defaultOutput = picked?.output_node_id;
    // Pre-fetch meta to seed default surfacing — but if we already have meta
    // cached from a prior pick, use it directly.
    const cached = metaCache[rid];
    if (cached) {
      const allInputs = cached.form_schema.map((f) => f.name);
      onChange({
        resource_id: rid,
        label: picked?.title || 'sub-DAG',
        subdag_source_output_node_id: defaultOutput,
        subdag_user_inputs: allInputs,
        bound_subdag_params: {},
      });
    } else {
      // Fetch then seed.
      setMetaLoading(true);
      api.dagPublishedSnapshotMeta(rid)
        .then((r) => {
          const seeded: SnapshotMeta = {
            data_source_id: r.data_source_id,
            output_node_id: r.output_node_id,
            exposed_node_ids: r.exposed_node_ids,
            form_schema: r.form_schema || [],
          };
          setMetaCache((prev) => ({ ...prev, [rid]: seeded }));
          onChange({
            resource_id: rid,
            label: picked?.title || 'sub-DAG',
            subdag_source_output_node_id: defaultOutput,
            subdag_user_inputs: seeded.form_schema.map((f) => f.name),
            bound_subdag_params: {},
          });
        })
        .catch((e) => setMetaError(String(e)))
        .finally(() => setMetaLoading(false));
    }
  };

  const toggleSurface = (paramName: string) => {
    const next = new Set(surfacedSet);
    if (next.has(paramName)) next.delete(paramName);
    else {
      next.add(paramName);
      // When promoting back to surfaced, drop any bound override so the form
      // takes over (resolver demotes only when not surfaced).
      if (Object.prototype.hasOwnProperty.call(boundOverrides, paramName)) {
        const { [paramName]: _drop, ...rest } = boundOverrides;
        onChange({ subdag_user_inputs: Array.from(next), bound_subdag_params: rest });
        return;
      }
    }
    onChange({ subdag_user_inputs: Array.from(next) });
  };

  const setBoundOverride = (paramName: string, raw: string, isArray: boolean) => {
    const value: unknown = isArray
      ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : raw;
    const next = { ...boundOverrides, [paramName]: value };
    if (raw === '' || (isArray && Array.isArray(value) && value.length === 0)) {
      delete next[paramName];
    }
    onChange({ bound_subdag_params: next });
  };

  const exposedIds: string[] = meta
    ? (Array.isArray(meta.exposed_node_ids) && meta.exposed_node_ids.length > 0
        ? meta.exposed_node_ids
        : [meta.output_node_id])
    : [];

  return (
    <div className="border border-indigo-200 bg-indigo-50 rounded p-2 space-y-3">
      <div className="text-xs font-medium text-indigo-800 flex items-center gap-1.5">
        <Workflow size={12} /> Sub-DAG config
      </div>

      <div>
        <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Child published_dag</label>
        {listError && <div className="text-[10px] text-red-600 mb-1">{listError}</div>}
        {!dataSourceId ? (
          <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5">
            Pick a data source first — subdag requires same-ds parent/child.
          </div>
        ) : (
          <select
            data-testid={`subdag-rid-${selectedId}`}
            value={childRid}
            onChange={(e) => pickRid(e.target.value)}
            disabled={listLoading}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
          >
            <option value="">— pick a published_dag —</option>
            {available.map((p) => (
              <option key={p.rid} value={p.rid}>{p.title} ({p.rid})</option>
            ))}
          </select>
        )}
        {listLoading && <div className="text-[10px] text-slate-500 mt-0.5">Loading…</div>}
        {dataSourceId && !listLoading && available.length === 0 && (
          <div className="text-[10px] text-slate-500 mt-0.5">No published_dags on this data source yet.</div>
        )}
      </div>

      {childRid && metaLoading && (
        <div className="text-[10px] text-slate-500">Loading child snapshot…</div>
      )}
      {childRid && metaError && (
        <div className="text-[10px] text-red-600 bg-red-50 border border-red-200 rounded p-1.5">
          {metaError}
        </div>
      )}

      {meta && (
        <>
          <div>
            <label className="block text-[10px] uppercase text-slate-500 mb-0.5">Output to plug into parent</label>
            <select
              data-testid={`subdag-output-${selectedId}`}
              value={data.subdag_source_output_node_id || meta.output_node_id}
              onChange={(e) => onChange({ subdag_source_output_node_id: e.target.value })}
              className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-mono"
            >
              {exposedIds.map((id) => (
                <option key={id} value={id}>
                  {id}{id === meta.output_node_id ? ' (leaf — default)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] uppercase text-slate-500 mb-0.5">
              Child inputs ({meta.form_schema.length})
            </label>
            {meta.form_schema.length === 0 ? (
              <div className="text-[10px] text-slate-500">child has no user_input_params</div>
            ) : (
              <div className="space-y-1.5">
                {meta.form_schema.map((p) => {
                  const isSurfaced = surfacedSet.has(p.name);
                  const overrideRaw = boundOverrides[p.name];
                  const isArray = !!(p.pg_type && p.pg_type.endsWith('[]'));
                  const display = overrideRaw == null
                    ? ''
                    : Array.isArray(overrideRaw) ? overrideRaw.join(', ') : String(overrideRaw);
                  return (
                    <div
                      key={p.name}
                      className={`border rounded p-1.5 ${isSurfaced ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200 bg-white'}`}
                    >
                      <label className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={isSurfaced}
                          onChange={() => toggleSurface(p.name)}
                          data-testid={`subdag-surface-${selectedId}-${p.name}`}
                          className="h-3 w-3"
                        />
                        <span className="font-mono">{p.name}</span>
                        <span className="text-[10px] text-slate-500">{p.pg_type || p.type}</span>
                        <span className="ml-auto text-[10px] text-slate-500">
                          {isSurfaced ? 'surface to parent form' : 'bind override'}
                        </span>
                      </label>
                      {!isSurfaced && (
                        <input
                          data-testid={`subdag-bind-${selectedId}-${p.name}`}
                          value={display}
                          onChange={(e) => setBoundOverride(p.name, e.target.value, isArray)}
                          placeholder={isArray ? 'comma-separated' : 'override value (blank = use child default)'}
                          className="w-full mt-1 text-[11px] border border-slate-200 rounded px-2 py-1 font-mono"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="text-[10px] text-slate-500 bg-white border border-slate-200 rounded p-1.5">
            On parent publish, this subdag is replaced inline with the child's flat snapshot.
            Surfaced inputs become parent form fields; bound overrides go into the child's bound_params.
          </div>
        </>
      )}
    </div>
  );
}

// ── Save-as-page dialog (DAG-SAVE-PAGE-01 Path A) ──
// Snapshots the selected node's last_result into authz_ui_page so a
// Curator can browse it under Modules without writing React. Live
// re-execution is Path B (config-exec dispatch on dag: prefix), deferred.
function SaveAsPageDialog({
  dagId, node, onClose, onSaved,
}: {
  dagId: string;
  node: Node<NodeData>;
  onClose: () => void;
  onSaved: (pageId: string) => void;
}) {
  const result = node.data.last_result!;
  const defaultPageId = `${dagId.replace(/^dag:/, '')}__${node.id}_snapshot`
    .toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const defaultTitle = `${node.data.label} — snapshot`;
  const [pageId, setPageId] = useState(defaultPageId);
  const [title, setTitle] = useState(defaultTitle);
  const [parentPageId, setParentPageId] = useState('modules_home');
  const [description, setDescription] = useState(`DAG snapshot from ${dagId} node ${node.id}`);
  const [overwrite, setOverwrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!/^[a-z][a-z0-9_]*$/.test(pageId)) {
      setError('page_id must start with a lowercase letter and contain only lowercase letters, digits, underscores.');
      return;
    }
    if (!title.trim()) {
      setError('title is required.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.dagSaveAsPage({
        page_id: pageId,
        title: title.trim(),
        parent_page_id: parentPageId.trim() || undefined,
        description: description.trim() || undefined,
        dag_id: dagId,
        node_id: node.id,
        bound_params: node.data.bound_params,
        columns: result.columns,
        rows: result.rows,
        overwrite,
      });
      onSaved(r.page_id);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('already exists')) {
        setError('Page already exists. Tick "Overwrite existing" to replace it.');
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-md bg-white rounded-lg shadow-xl border border-slate-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="save-as-page-dialog"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Save snapshot as Tier B page</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>

        <div className="px-4 py-3 space-y-3 text-xs">
          <div className="bg-slate-50 rounded p-2 text-slate-600">
            From DAG <span className="font-mono">{dagId}</span> node <span className="font-mono">{node.id}</span> ({node.data.label}) —
            {' '}<span className="font-medium">{result.row_count} rows</span>, {result.columns.length} columns
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Page ID</label>
            <input
              data-testid="save-as-page-id"
              value={pageId}
              onChange={(e) => setPageId(e.target.value.toLowerCase())}
              className="w-full border border-slate-200 rounded px-2 py-1 font-mono"
            />
            <div className="text-[10px] text-slate-500 mt-0.5">Lowercase, starts with letter; no spaces.</div>
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Title</label>
            <input
              data-testid="save-as-page-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1"
            />
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Parent page</label>
            <input
              data-testid="save-as-page-parent"
              value={parentPageId}
              onChange={(e) => setParentPageId(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1 font-mono"
              placeholder="modules_home"
            />
            <div className="text-[10px] text-slate-500 mt-0.5">Existing page_id for the card-grid parent.</div>
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full border border-slate-200 rounded px-2 py-1"
            />
          </div>

          <label className="flex items-center gap-2 text-slate-700">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              data-testid="save-as-page-overwrite"
            />
            Overwrite existing page if page_id matches
          </label>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-red-700 text-xs flex items-start gap-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-slate-200">
          <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting}
            data-testid="save-as-page-submit"
            className="btn-primary text-xs flex items-center gap-1"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save page
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Publish dialog (DAG-PUBLISH-V01) ──
// Posts the saved DAG (server reads from authz_resource — never trusts the
// client snapshot) to /api/dag/:rid/publish. The server snapshots the DAG-JSON,
// derives form_schema from user_input_params, registers the bless gate
// `published_dag:<rid>`, and grants `read` to BI_USER. End-user form rendering
// happens in ConfigEngine.
function PublishDagDialog({
  dagId,
  displayName,
  description: initialDescription,
  nodes,
  onClose,
  onPublished,
}: {
  dagId: string;
  displayName: string;
  description: string;
  nodes: Node<NodeData>[];
  onClose: () => void;
  onPublished: (pageId: string) => void;
}) {
  const userInputs = useMemo(() => {
    const list: Array<{ nodeId: string; nodeLabel: string; param: string }> = [];
    for (const n of nodes) {
      for (const p of n.data.user_input_params || []) {
        list.push({ nodeId: n.id, nodeLabel: n.data.label, param: p });
      }
    }
    return list;
  }, [nodes]);

  const defaultPageId = dagId.replace(/^dag:/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const [pageId, setPageId] = useState(defaultPageId);
  const [title, setTitle] = useState(displayName);
  const [parentPageId, setParentPageId] = useState('modules_home');
  const [description, setDescription] = useState(initialDescription || `Published from ${dagId}`);
  const [overwrite, setOverwrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!/^[a-z][a-z0-9_]*$/.test(pageId)) {
      setError('page_id must start with a lowercase letter and contain only lowercase letters, digits, underscores.');
      return;
    }
    if (!title.trim()) {
      setError('title is required.');
      return;
    }
    if (userInputs.length === 0) {
      setError('No params marked as form inputs. Tick "Expose as form input" on at least one bound param before publishing.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.dagPublish(dagId, {
        page_id: pageId,
        title: title.trim(),
        parent_page_id: parentPageId.trim() || undefined,
        description: description.trim() || undefined,
        overwrite,
      });
      onPublished(r.page_id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already exists')) {
        setError('Page already exists. Tick "Overwrite existing" to replace it.');
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-md bg-white rounded-lg shadow-xl border border-slate-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="publish-dag-dialog"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <Upload size={14} className="text-emerald-600" /> Publish DAG as live Tier B page
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>

        <div className="px-4 py-3 space-y-3 text-xs">
          <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-slate-700">
            <div className="font-medium text-emerald-900 mb-1">{userInputs.length} form input{userInputs.length === 1 ? '' : 's'} exposed</div>
            <ul className="space-y-0.5 text-[10px] text-slate-600 font-mono">
              {userInputs.map((u, idx) => (
                <li key={idx}>• {u.param} <span className="text-slate-400">— {u.nodeLabel}</span></li>
              ))}
            </ul>
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Page ID</label>
            <input
              data-testid="publish-page-id"
              value={pageId}
              onChange={(e) => setPageId(e.target.value.toLowerCase())}
              className="w-full border border-slate-200 rounded px-2 py-1 font-mono"
            />
            <div className="text-[10px] text-slate-500 mt-0.5">Lowercase, starts with letter; no spaces.</div>
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Title</label>
            <input
              data-testid="publish-page-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1"
            />
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Parent page</label>
            <input
              data-testid="publish-page-parent"
              value={parentPageId}
              onChange={(e) => setParentPageId(e.target.value)}
              className="w-full border border-slate-200 rounded px-2 py-1 font-mono"
              placeholder="modules_home"
            />
          </div>

          <div>
            <label className="block text-slate-700 font-medium mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full border border-slate-200 rounded px-2 py-1"
            />
          </div>

          <label className="flex items-center gap-2 text-slate-700">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              data-testid="publish-overwrite"
            />
            Overwrite existing page if page_id matches
          </label>

          <div className="text-[10px] text-slate-500 bg-slate-50 rounded p-2">
            Publishing grants <span className="font-mono">BI_USER</span> read access to the published gate
            <span className="font-mono"> published_dag:{dagId}</span>. End users can then run the DAG
            from the page form; per-fn execute permissions are not changed.
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-red-700 text-xs flex items-start gap-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-slate-200">
          <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting}
            data-testid="publish-submit"
            className="btn-primary text-xs flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Publish
          </button>
        </div>
      </div>
    </div>
  );
}
