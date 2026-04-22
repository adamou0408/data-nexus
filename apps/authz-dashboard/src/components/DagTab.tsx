import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, applyEdgeChanges, applyNodeChanges,
  Handle, Position,
  type Node, type Edge, type NodeChange, type EdgeChange, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, DataSource } from '../api';
import { useToast } from './Toast';
import { PageHeader } from './shared/atoms/PageHeader';
import { EmptyState } from './shared/atoms/EmptyState';
import {
  Workflow, Save, Trash2, Play, Plus, Search, CheckCircle2, AlertCircle,
  Loader2, Database, Sparkles, FileText,
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
function FunctionNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const bg = data.subtype === 'action' ? '#fef3c7'
    : data.subtype === 'report' ? '#ede9fe'
    : '#f0f9ff';
  const border = selected ? '#2563eb' : '#cbd5e1';
  return (
    <div
      data-testid={`node-${data.resource_id}`}
      style={{
        background: bg, border: `2px solid ${border}`, borderRadius: 8,
        padding: '8px 12px', minWidth: 220, fontSize: 12, boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
      }}
    >
      <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
        {data.label}
        <span style={{ marginLeft: 6, fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>{data.subtype}</span>
      </div>

      {/* Inputs (left) — one handle per input */}
      {data.inputs.map((i, idx) => (
        <div key={`in-${i.name}`} style={{ position: 'relative', padding: '2px 0', color: '#334155' }}>
          <Handle
            type="target"
            position={Position.Left}
            id={i.name}
            style={{ top: 10 + idx * 16, background: colorFor(i.semantic_type), width: 10, height: 10 }}
          />
          <span style={{ fontSize: 11 }}>
            <span style={{ color: colorFor(i.semantic_type), marginRight: 4 }}>●</span>
            {i.name}
            {i.hasDefault && <span style={{ color: '#94a3b8' }}> (opt)</span>}
          </span>
        </div>
      ))}

      <div style={{ borderTop: '1px dashed #cbd5e1', margin: '4px 0' }} />

      {/* Outputs (right) */}
      {data.outputs.slice(0, 6).map((o, idx) => (
        <div key={`out-${o.name}`} style={{ position: 'relative', padding: '2px 0', textAlign: 'right', color: '#334155' }}>
          <span style={{ fontSize: 11 }}>
            {o.name}
            <span style={{ color: colorFor(o.semantic_type), marginLeft: 4 }}>●</span>
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={o.name}
            style={{ top: (data.inputs.length * 16) + 18 + idx * 16, background: colorFor(o.semantic_type), width: 10, height: 10 }}
          />
        </div>
      ))}
      {data.outputs.length > 6 && (
        <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'right' }}>+{data.outputs.length - 6} more</div>
      )}

      {data.last_result && (
        <div style={{ marginTop: 6, padding: '4px 6px', background: '#dcfce7', color: '#166534', borderRadius: 4, fontSize: 10 }}>
          ✓ {data.last_result.row_count} rows • {data.last_result.elapsed_ms}ms
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
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
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

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);

  // ── Load data sources + DAG list ──
  useEffect(() => {
    api.datasources().then((ds) => {
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
    setNodes((nds) => [...nds, node]);
    setSelectedId(id);
  };

  // ── React Flow callbacks ──
  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds) as Node<NodeData>[]), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);

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
    setEdges((eds) => addEdge({
      ...conn,
      id: `e${eds.length + 1}_${Date.now()}`,
      style: { stroke: colorFor(srcOut.semantic_type), strokeWidth: 2 },
    }, eds));
  }, [nodes]);

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
    setNodes((nds) => nds.map((n) => n.id === selected.id ? {
      ...n, data: { ...n.data, bound_params: { ...n.data.bound_params, [argName]: value } },
    } : n));
  };

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

        <button onClick={validate} className="btn-secondary text-sm flex items-center gap-1">
          <CheckCircle2 size={14} /> Validate
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

      <div className="grid grid-cols-12 gap-4" style={{ minHeight: 600 }}>
        {/* ── Left: Palette ── */}
        <div className="col-span-3 bg-white border border-slate-200 rounded-lg p-3 flex flex-col" style={{ maxHeight: 720 }}>
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

        {/* ── Center: Canvas ── */}
        <div className="col-span-6 bg-white border border-slate-200 rounded-lg overflow-hidden" style={{ height: 720 }}>
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
              fitView
            >
              <Background />
              <Controls />
              <MiniMap />
            </ReactFlow>
          </ReactFlowProvider>
        </div>

        {/* ── Right: Inspector ── */}
        <div className="col-span-3 bg-white border border-slate-200 rounded-lg p-3" style={{ maxHeight: 720, overflowY: 'auto' }}>
          {!selected ? (
            <EmptyState message="No node selected" hint="Click a node to bind parameters or run it." icon={<Workflow size={24} />} />
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <div className="font-semibold text-slate-900">{selected.data.label}</div>
                <div className="text-xs text-slate-500">{selected.data.resource_id}</div>
                <div className="text-[10px] uppercase text-slate-400 mt-1">{selected.data.subtype}</div>
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
    </div>
  );
}
