import { useState } from 'react';
import { api, BulkApplyResult, BulkSectionResult } from '../api';
import { useToast } from './Toast';
import { Download, Upload, Eye, Play, CheckCircle2, AlertTriangle, XCircle, Copy, FileJson } from 'lucide-react';

export function ConfigToolsTab() {
  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Config Tools</h1>
        <p className="page-desc">Export configuration snapshots for AI analysis, or bulk-import changes from JSON</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ExportPanel />
        <ImportPanel />
      </div>
    </div>
  );
}

// ── Export Panel ──────────────────────────────────────────────

function ExportPanel() {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const handleExport = async (mode: 'download' | 'preview' | 'clipboard') => {
    setLoading(true);
    try {
      const data = await api.configSnapshot();
      const json = JSON.stringify(data, null, 2);

      if (mode === 'download') {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nexus-authz-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Snapshot downloaded');
      } else if (mode === 'clipboard') {
        await navigator.clipboard.writeText(json);
        toast.success('Copied to clipboard — paste into AI conversation');
      } else {
        setPreview(json);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Download size={16} className="text-blue-600" /> Export Snapshot
        </h3>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-slate-500">
          Export the entire AuthZ configuration as JSON. No passwords or secrets are included.
          Use this for AI analysis, environment comparison, or backup.
        </p>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => handleExport('download')} disabled={loading}
            className="btn btn-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 gap-1">
            <FileJson size={14} /> Download JSON
          </button>
          <button onClick={() => handleExport('clipboard')} disabled={loading}
            className="btn-secondary btn-sm gap-1">
            <Copy size={14} /> Copy to Clipboard
          </button>
          <button onClick={() => handleExport('preview')} disabled={loading}
            className="btn-secondary btn-sm gap-1">
            <Eye size={14} /> Preview
          </button>
        </div>
        {preview && (
          <div className="relative">
            <button onClick={() => setPreview(null)}
              className="absolute top-2 right-2 text-slate-400 hover:text-slate-600 text-xs">
              close
            </button>
            <pre className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap">
              {preview.length > 20000 ? preview.slice(0, 20000) + '\n\n... (truncated for preview, full content in download)' : preview}
            </pre>
          </div>
        )}
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-800">
          <strong>AI Workflow:</strong> Copy snapshot → paste into Claude/GPT → ask for analysis or suggested changes → paste AI's JSON into Import panel → preview → apply
        </div>
      </div>
    </div>
  );
}

// ── Import Panel ─────────────────────────────────────────────

function ImportPanel() {
  const toast = useToast();
  const [input, setInput] = useState('');
  const [dryRunResult, setDryRunResult] = useState<BulkApplyResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const parseInput = (): Record<string, any> | null => {
    try {
      const parsed = JSON.parse(input);
      setParseError(null);
      return parsed;
    } catch {
      setParseError('Invalid JSON — check formatting');
      return null;
    }
  };

  const handlePreview = async () => {
    const payload = parseInput();
    if (!payload) return;
    setApplying(true);
    try {
      const result = await api.configBulkApply({ ...payload, dry_run: true });
      setDryRunResult(result);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setApplying(false);
    }
  };

  const handleApply = async () => {
    const payload = parseInput();
    if (!payload) return;
    setApplying(true);
    try {
      const result = await api.configBulkApply({ ...payload, dry_run: false });
      setDryRunResult(result);
      if (result.status === 'ok') {
        toast.success(`Applied: ${result.totals.created} created, ${result.totals.updated} updated`);
      } else {
        toast.error(`Partial apply: ${result.totals.errors} errors`);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setApplying(false);
    }
  };

  const detectedSections = (() => {
    try {
      const parsed = JSON.parse(input);
      return ['actions', 'roles', 'resources', 'subjects', 'policies']
        .filter(s => Array.isArray(parsed[s]) && parsed[s].length > 0);
    } catch { return []; }
  })();

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Upload size={16} className="text-green-600" /> Bulk Import
        </h3>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-slate-500">
          Paste JSON with <code className="bg-slate-100 px-1 rounded">roles</code>, <code className="bg-slate-100 px-1 rounded">subjects</code>, <code className="bg-slate-100 px-1 rounded">resources</code>, <code className="bg-slate-100 px-1 rounded">policies</code>, or <code className="bg-slate-100 px-1 rounded">actions</code> arrays.
          Preview (dry run) shows what would change without writing to the database.
        </p>
        <textarea
          className="w-full h-48 input font-mono text-xs resize-y"
          placeholder={'{\n  "roles": [\n    {\n      "role_id": "NEW_ROLE",\n      "display_name": "New Role",\n      "permissions": [\n        { "action": "read", "resource": "module:mrp" }\n      ]\n    }\n  ]\n}'}
          value={input}
          onChange={e => { setInput(e.target.value); setParseError(null); setDryRunResult(null); }}
        />
        {parseError && <div className="text-xs text-red-600">{parseError}</div>}
        {detectedSections.length > 0 && (
          <div className="text-xs text-slate-500">
            Detected sections: {detectedSections.map(s => (
              <span key={s} className="badge badge-blue text-[10px] mr-1">{s}</span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={handlePreview} disabled={applying || !input.trim()}
            className="btn-secondary btn-sm gap-1 disabled:opacity-40">
            <Eye size={14} /> Preview (Dry Run)
          </button>
          <button onClick={handleApply}
            disabled={applying || !input.trim() || !dryRunResult || dryRunResult.totals.errors > 0}
            className="btn btn-sm bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 gap-1">
            <Play size={14} /> Apply
          </button>
        </div>
        {dryRunResult && <BulkResultView result={dryRunResult} />}
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600 space-y-2">
          <div className="font-medium text-slate-700">JSON Format Reference</div>
          <div className="font-mono text-[11px] whitespace-pre-wrap">{`{
  "roles": [{
    "role_id": "ROLE_ID",
    "display_name": "Display Name",
    "permissions": [{ "action": "read", "resource": "module:xxx" }]
  }],
  "subjects": [{
    "subject_id": "user_id",
    "subject_type": "user",
    "display_name": "Name",
    "roles": ["ROLE_ID"],
    "groups": ["GROUP_ID"]
  }],
  "resources": [{
    "resource_id": "module:xxx",
    "resource_type": "module",
    "display_name": "Name"
  }],
  "policies": [{
    "policy_name": "policy_name",
    "granularity": "L1",
    "effect": "allow",
    "rls_expression": "col = 'value'",
    "assignments": [{ "assignment_type": "role", "assignment_value": "ROLE" }]
  }]
}`}</div>
        </div>
      </div>
    </div>
  );
}

// ── Result display ──

function BulkResultView({ result }: { result: BulkApplyResult }) {
  return (
    <div className={`rounded-lg border p-3 space-y-2 ${result.dry_run ? 'bg-amber-50 border-amber-200' : result.status === 'ok' ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        {result.dry_run ? (
          <><Eye size={14} className="text-amber-600" /> Dry Run Preview</>
        ) : result.status === 'ok' ? (
          <><CheckCircle2 size={14} className="text-emerald-600" /> Applied Successfully</>
        ) : (
          <><AlertTriangle size={14} className="text-red-600" /> Partial Apply</>
        )}
        <span className="text-xs text-slate-500 font-normal">
          {result.totals.created} created, {result.totals.updated} updated, {result.totals.skipped} skipped
          {result.totals.errors > 0 && <>, <span className="text-red-600">{result.totals.errors} errors</span></>}
        </span>
      </div>
      {result.results.map((r: BulkSectionResult) => (
        <SectionResult key={r.section} result={r} />
      ))}
    </div>
  );
}

function SectionResult({ result }: { result: BulkSectionResult }) {
  const hasChanges = result.created > 0 || result.updated > 0;
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        {result.errors.length > 0 ? <XCircle size={12} className="text-red-500" />
          : hasChanges ? <CheckCircle2 size={12} className="text-emerald-500" />
          : <span className="w-3 h-3 rounded-full bg-slate-300 inline-block" />}
        <span className="font-medium capitalize">{result.section}</span>
        <span className="text-slate-500">
          +{result.created} created, ~{result.updated} updated
          {result.skipped > 0 && `, ${result.skipped} skipped`}
        </span>
      </div>
      {result.errors.length > 0 && (
        <div className="ml-5 mt-1 space-y-0.5">
          {result.errors.map((e, i) => (
            <div key={i} className="text-red-600 font-mono text-[11px]">{e}</div>
          ))}
        </div>
      )}
    </div>
  );
}
