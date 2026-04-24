import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, applyEdgeChanges, applyNodeChanges,
  Handle, Position,
  type Node, type Edge, type NodeChange, type EdgeChange, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';

type DataSourceLite = { source_id: string; display_name: string; db_type: string };
import { useToast } from './Toast';
import { PageHeader } from './shared/atoms/PageHeader';
import { EmptyState } from './shared/atoms/EmptyState';
import {
  Workflow, Save, Trash2, Play, Plus, Search, CheckCircle2, AlertCircle,
  Loader2, Database, Sparkles, FileText, Undo2, Redo2, X,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
} from 'lucide-react';

// ── Types ──
type SemanticType = string; // free-form, e.g. 'material_no', 'product_family'
type IO = { name: string; semantic_type?: SemanticType; hasDefault?: boolean; pgType?: string };
type FnMeta = {
  resource_id: string;
  schema: string;
  function_name: string;
  display_name: string;
  subtype: string;
  parsed_args: IO[];
  return_shape: { shape: string; columns?: IO[] };
};
type NodeData = {
  resource_id: string;
  label: string;
  subtype: string;
  inputs: IO[];
  outputs: IO[];
  bound_params: Record<string, unknown>;
  last_result?: {
    columns: Array<{ name: string; semantic_type?: string }>;
    rows: Record<string, unknown>[];
    row_count: number;
    elapsed_ms: number;
    lineage: Array<{ input: string; source: string }>;
  };
};

// ── Color per semantic_type so handles line up visually ──
const SEMANTIC_COLORS: Record<string, string> = {
  material_no: '#2563eb',
  product_family: '#9333ea',
  make_buy_flag: '#f59e0b',
  wo_no: '#059669',
  shipment_no: '#0ea5e9',
  customer_code: '#ec4899',
  keyword: '#64748b',
  limit: '#94a3b8',
  date: '#ea580c',
  datetime: '#ea580c',
  count: '#14b8a6',
  quantity: '#14b8a6',
  status: '#f43f5e',
  unknown: '#cbd5e1',
};
const colorFor = (t?: string) => SEMANTIC_COLORS[t || 'unknown'] || SEMANTIC_COLORS.unknown;

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
function FunctionNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const s = SUBTYPE_STYLES[data.subtype] || SUBTYPE_STYLES.query;
  const border = selected ? '#2563eb' : '#cbd5e1';
  const visibleOutputs = data.outputs.slice(0, 6);
  const hiddenCount = data.outputs.length - visibleOutputs.length;

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
        <span
          style={{
            fontSize: 9,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            padding: '1px 6px',
            borderRadius: 999,
            background: s.accent,
            color: 'white',
            flexShrink: 0,
          }}
        >
          {data.subtype}
        </span>
      </div>

      {/* Inputs (left) — handle centered per row by xyflow's default CSS */}
      {data.inputs.length > 0 && (
        <div style={{ padding: '4px 0' }}>
          {data.inputs.map((i) => (
            <div
              key={`in-${i.name}`}
              style={{
                position: 'relative',
                height: ROW_H,
                display: 'flex',
                alignItems: 'center',
                padding: '0 10px 0 14px',
                color: '#334155',
              }}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={i.name}
                style={{ background: colorFor(i.semantic_type), width: 10, height: 10, border: '2px solid white' }}
              />
              <span style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: colorFor(i.semantic_type), display: 'inline-block' }} />
                {i.name}
                {i.hasDefault && <span style={{ color: '#94a3b8', fontSize: 10 }}>(opt)</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {data.inputs.length > 0 && visibleOutputs.length > 0 && (
        <div style={{ borderTop: '1px dashed #cbd5e1', margin: '0 8px' }} />
      )}

      {/* Outputs (right) */}
      {visibleOutputs.length > 0 && (
        <div style={{ padding: '4px 0' }}>
          {visibleOutputs.map((o) => (
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
                style={{ background: colorFor(o.semantic_type), width: 10, height: 10, border: '2px solid white' }}
              />
            </div>
          ))}
          {hiddenCount > 0 && (
            <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'right', padding: '0 14px 2px' }}>+{hiddenCount} more</div>
          )}
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

const nodeTypes = { fn: FunctionNode };

// ── Main tab ──
export function DagTab() {
  const toast = useToast();
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
      },
    };
    pushHistory();
    setNodes((nds) => [...nds, node]);
    setSelectedId(id);
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

  // Edge type-check on connect (W6-5 — do it client-side for instant feedback;
  // server revalidates on save/execute)
  const onConnect = useCallback((conn: Connection) => {
    const src = nodes.find((n) => n.id === conn.source);
    const tgt = nodes.find((n) => n.id === conn.target);
    if (!src || !tgt) return;
    const srcOut = src.data.outputs.find((o) => o.name === conn.sourceHandle);
    const tgtIn = tgt.data.inputs.find((i) => i.name === conn.targetHandle);
    if (!srcOut || !tgtIn) return;
    if (srcOut.semantic_type && tgtIn.semantic_type &&
        srcOut.semantic_type !== 'unknown' && tgtIn.semantic_type !== 'unknown' &&
        srcOut.semantic_type !== tgtIn.semantic_type) {
      showToast(`Type mismatch: ${srcOut.semantic_type} → ${tgtIn.semantic_type}`, 'error');
      return;
    }
    pushHistory();
    setEdges((eds) => addEdge({
      ...conn,
      id: `e${eds.length + 1}_${Date.now()}`,
      style: { stroke: colorFor(srcOut.semantic_type), strokeWidth: 2 },
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
      // Gather upstream results from any node that has a last_result
      const upstream: Record<string, any> = {};
      for (const n of nodes) {
        if (n.data.last_result && n.data.last_result.rows.length > 0) {
          upstream[n.id] = {
            columns: n.data.last_result.columns,
            row0: n.data.last_result.rows[0],
          };
        }
      }
      const payload = {
        data_source_id: dsId,
        node: { id: node.id, data: { resource_id: node.data.resource_id, inputs: node.data.inputs, bound_params: node.data.bound_params } },
        upstream,
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
    for (const id of order) {
      await executeNode(id);
    }
    showToast(`Ran ${order.length} node(s)`, 'success');
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
    setNodes((nds) => nds.map((n) => n.id === selected.id ? {
      ...n, data: { ...n.data, bound_params: { ...n.data.bound_params, [argName]: value } },
    } : n));
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
              <div className="px-3 py-1.5 border-b border-slate-200 bg-slate-50 flex items-center gap-3 flex-wrap text-[10px] text-slate-600">
                <span className="font-semibold uppercase tracking-wide">Types</span>
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
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
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

              <div>
                <div className="text-xs font-medium text-slate-700 mb-1">Inputs</div>
                <div className="space-y-2">
                  {selected.data.inputs.map((i) => {
                    const bound = (selected.data.bound_params as any)[i.name];
                    const hasEdge = edges.some((e) => e.target === selected.id && e.targetHandle === i.name);
                    return (
                      <div key={i.name} className="border border-slate-200 rounded p-2">
                        <div className="text-xs flex items-center justify-between">
                          <span>
                            <span style={{ color: colorFor(i.semantic_type) }}>●</span> {i.name}
                            {i.hasDefault && <span className="text-slate-400 ml-1">(opt)</span>}
                          </span>
                          <span className="text-[10px] text-slate-500">{i.semantic_type || 'unknown'}</span>
                        </div>
                        {hasEdge ? (
                          <div className="text-[10px] text-emerald-700 mt-1">↑ connected (upstream)</div>
                        ) : (
                          <input
                            aria-label={`param-${i.name}`}
                            data-testid={`param-${selected.id}-${i.name}`}
                            value={bound == null ? '' : String(bound)}
                            onChange={(e) => updateBoundParam(i.name, e.target.value)}
                            placeholder={i.hasDefault ? 'default' : 'required'}
                            className="w-full mt-1 text-xs border border-slate-200 rounded px-2 py-1"
                          />
                        )}
                      </div>
                    );
                  })}
                  {selected.data.inputs.length === 0 && <div className="text-xs text-slate-400">no inputs</div>}
                </div>
              </div>

              <button
                data-testid={`run-${selected.id}`}
                onClick={() => executeNode(selected.id)}
                disabled={running === selected.id}
                className="w-full btn-primary text-sm flex items-center justify-center gap-1"
              >
                {running === selected.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Run this node
              </button>

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
