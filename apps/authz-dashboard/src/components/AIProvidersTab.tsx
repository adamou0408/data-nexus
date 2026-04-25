// AI Providers — admin surface for registering OpenAI-compatible LLM endpoints.
// Two-stage wizard keeps the "test before you save" contract: the /_test endpoint
// validates the URL+key against /v1/models before any row lands in the DB, so an
// invalid key never pollutes the registry.
//
// Constitution refs:
//   §9.1 — scope is OpenAI-compatible only; provider_kind labels UI, not behavior.
//   §9.2 — AI inherits caller's authz bounds. Banner on detail view reminds admins.
//   §9.6 — raw prompts never persisted; usage panel shows hashes + token counts.
//   §9.7 — admin audit strip tagged actor_type=human, consent_given=human_explicit.

import { useEffect, useMemo, useState } from 'react';
import {
  Sparkles, Plus, Search, RefreshCw, Check, X, Key, AlertTriangle, Loader2,
  ChevronRight, ArrowLeft, Trash2, RotateCcw, PlayCircle, Shield, Activity,
  ChevronDown, ExternalLink, Copy,
} from 'lucide-react';
import { api, AIProvider, AIProviderTestResult, AIProviderUsage, AIProviderAuditEntry, AIProviderPricing } from '../api';
import { useToast } from './Toast';

const PROVIDER_KINDS = [
  { value: 'openai',       label: 'OpenAI',            sample: 'https://api.openai.com/v1' },
  { value: 'azure_openai', label: 'Azure OpenAI',      sample: 'https://{resource}.openai.azure.com/openai/deployments/{deployment}' },
  { value: 'vllm',         label: 'vLLM (self-host)',  sample: 'http://vllm:8000/v1' },
  { value: 'ollama',       label: 'Ollama',            sample: 'http://ollama:11434/v1' },
  { value: 'openrouter',   label: 'OpenRouter',        sample: 'https://openrouter.ai/api/v1' },
  { value: 'custom_oai',   label: 'Custom (OAI-compat)', sample: 'https://your-host/v1' },
] as const;

const PURPOSE_PRESETS = ['chat', 'text_to_sql', 'suggestion', 'embedding'] as const;

export function AIProvidersTab() {
  const toast = useToast();
  const [providers, setProviders] = useState<AIProvider[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const rows = await api.aiProviders();
      setProviders(rows);
    } catch (err) {
      toast.error(`Load failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    if (!providers) return [];
    const q = search.trim().toLowerCase();
    return providers.filter(p => {
      if (!showInactive && !p.is_active) return false;
      if (!q) return true;
      return p.provider_id.toLowerCase().includes(q)
          || p.display_name.toLowerCase().includes(q)
          || p.base_url.toLowerCase().includes(q);
    });
  }, [providers, search, showInactive]);

  if (detailId) {
    return <ProviderDetail
      id={detailId}
      onBack={() => setDetailId(null)}
      onReload={reload}
    />;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <Sparkles size={22} className="text-amber-500" /> AI Providers
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Register OpenAI-compatible endpoints that power Data Nexus AI features.
            Keys are encrypted at rest; usage inherits the caller's authz bounds (<span className="font-mono text-xs">Constitution §9.2</span>).
          </p>
        </div>
        <button
          onClick={() => setWizardOpen(true)}
          className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg shadow-sm"
        >
          <Plus size={16} /> Add Provider
        </button>
      </header>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg flex-1 max-w-md">
          <Search size={16} className="text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, id, or URL"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
            className="rounded"
          />
          Show deactivated
        </label>
        <button
          onClick={reload}
          className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg"
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-slate-500">
          <Loader2 className="animate-spin" size={20} />
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-12 text-center">
          <Sparkles size={28} className="mx-auto text-slate-300" />
          <p className="text-sm text-slate-700 mt-3 font-medium">No providers yet</p>
          <p className="text-xs text-slate-500 mt-1">Click <b>Add Provider</b> to register an OpenAI-compatible endpoint.</p>
          <button
            onClick={() => setWizardOpen(true)}
            className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg"
          >
            <Plus size={14} /> Add Provider
          </button>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
          {filtered.map(p => (
            <ProviderRow key={p.provider_id} p={p} onOpen={() => setDetailId(p.provider_id)} />
          ))}
        </div>
      )}

      {wizardOpen && (
        <AddProviderWizard
          onClose={() => setWizardOpen(false)}
          onCreated={(id) => {
            setWizardOpen(false);
            reload();
            setDetailId(id);
          }}
        />
      )}
    </div>
  );
}

// ─── List row ───────────────────────────────────────────────
function ProviderRow({ p, onOpen }: { p: AIProvider; onOpen: () => void }) {
  const testStatus = p.last_test_status;
  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-4 px-4 py-3.5 hover:bg-slate-50 text-left"
    >
      <div className="shrink-0">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
          p.is_active ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-400'
        }`}>
          <Sparkles size={20} />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-900 truncate">{p.display_name}</span>
          {p.is_fallback && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 uppercase tracking-wide">Fallback</span>
          )}
          {!p.is_active && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 uppercase tracking-wide">Deactivated</span>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 font-mono truncate">{p.provider_id} · {p.base_url}</div>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          {p.purpose_tags.map(t => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono">{t}</span>
          ))}
          {p.purpose_tags.length === 0 && (
            <span className="text-[10px] text-slate-400 italic">no purpose tags</span>
          )}
        </div>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1 text-xs">
        <TestBadge status={testStatus} />
        <span className="text-slate-400">
          {p.api_key_set ? <>key ••••{p.api_key_last4 ?? '????'}</> : <span className="text-rose-600 font-medium">no key</span>}
        </span>
      </div>
      <ChevronRight size={16} className="text-slate-300 shrink-0" />
    </button>
  );
}

function TestBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-slate-400">not tested</span>;
  if (status === 'ok') return <span className="inline-flex items-center gap-1 text-emerald-600"><Check size={12} /> healthy</span>;
  if (status === 'partial') return <span className="inline-flex items-center gap-1 text-amber-600"><AlertTriangle size={12} /> partial</span>;
  return <span className="inline-flex items-center gap-1 text-rose-600"><X size={12} /> {status}</span>;
}

// ─── Two-stage add wizard ─────────────────────────────────
function AddProviderWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AIProviderTestResult | null>(null);

  // Step 1 — connection
  const [providerId, setProviderId] = useState('ai:');
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<AIProvider['provider_kind']>('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');

  // Step 2 — routing + defaults
  const [defaultModel, setDefaultModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [purposeTags, setPurposeTags] = useState<string[]>(['chat']);
  const [isFallback, setIsFallback] = useState(false);
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [monthlyBudget, setMonthlyBudget] = useState<string>('');
  const [rateLimitRpm, setRateLimitRpm] = useState<string>('');

  function setKindAndSample(k: AIProvider['provider_kind']) {
    setKind(k);
    const preset = PROVIDER_KINDS.find(p => p.value === k);
    if (preset && (baseUrl === '' || PROVIDER_KINDS.some(pp => pp.sample === baseUrl))) {
      setBaseUrl(preset.sample);
    }
  }

  async function runTest(runChat: boolean) {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.aiProviderTestUnsaved({
        base_url: baseUrl,
        api_key: apiKey || undefined,
        default_model: defaultModel || undefined,
        run_chat_probe: runChat,
      });
      setTestResult(r);
      if (r.status === 'ok' && r.models_sample && r.models_sample.length && !defaultModel) {
        // Pre-fill default_model with the first returned model if caller hasn't chosen one.
        const first = r.models_sample[0];
        setDefaultModel(first);
        setAvailableModels(r.models_sample);
      } else if (r.models_sample) {
        setAvailableModels(r.models_sample);
      }
    } catch (err) {
      toast.error(`Test failed: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const payload: any = {
        provider_id: providerId,
        display_name: displayName,
        provider_kind: kind,
        base_url: baseUrl,
        default_model: defaultModel || null,
        available_models: availableModels,
        default_temperature: temperature,
        default_max_tokens: maxTokens,
        purpose_tags: purposeTags,
        is_fallback: isFallback,
        monthly_budget_usd: monthlyBudget ? Number(monthlyBudget) : null,
        rate_limit_rpm: rateLimitRpm ? Number(rateLimitRpm) : null,
        is_active: true,
      };
      if (apiKey) payload.api_key = apiKey;
      const res = await api.aiProviderCreate(payload);
      toast.success(`Created ${res.display_name}`);
      onCreated(res.provider_id);
    } catch (err) {
      toast.error(`Create failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const step1Valid = providerId.match(/^ai:[a-z0-9_\-]+$/i) && displayName.trim().length > 0 && baseUrl.trim().length > 0;
  const step1TestPassed = testResult?.status === 'ok' || testResult?.status === 'partial';

  return (
    <Modal onClose={onClose} title={`Add AI Provider — Step ${step} of 2`}>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-5 text-xs">
        <StepDot active={step >= 1} done={step > 1}>Connect & test</StepDot>
        <div className="flex-1 h-px bg-slate-200" />
        <StepDot active={step >= 2} done={false}>Routing & defaults</StepDot>
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <div>
            <Label>Provider ID</Label>
            <input
              value={providerId}
              onChange={e => setProviderId(e.target.value)}
              placeholder="ai:openai_main"
              className="input font-mono"
            />
            <Help>Lowercase, starts with <code className="bg-slate-100 px-1 rounded">ai:</code>. Used in logs and permissions.</Help>
          </div>
          <div>
            <Label>Display name</Label>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="OpenAI — production"
              className="input"
            />
          </div>
          <div>
            <Label>Provider kind</Label>
            <div className="grid grid-cols-3 gap-2">
              {PROVIDER_KINDS.map(pk => (
                <button
                  key={pk.value}
                  type="button"
                  onClick={() => setKindAndSample(pk.value as AIProvider['provider_kind'])}
                  className={`px-3 py-2 text-xs rounded-lg border ${
                    kind === pk.value
                      ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                      : 'border-slate-200 hover:border-slate-300 text-slate-700'
                  }`}
                >
                  {pk.label}
                </button>
              ))}
            </div>
            <Help>All kinds must speak the OpenAI API ({"`/v1/models`, `/v1/chat/completions`"}). The label is cosmetic.</Help>
          </div>
          <div>
            <Label>Base URL</Label>
            <input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="input font-mono"
            />
          </div>
          <div>
            <Label>API key</Label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="input font-mono"
              autoComplete="new-password"
            />
            <Help>Encrypted at rest (AES-256-GCM). Leave empty for unauthenticated endpoints (local vLLM / Ollama).</Help>
          </div>

          {/* Test button + result */}
          <div className="pt-2 border-t border-slate-100">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => runTest(false)}
                disabled={!step1Valid || testing}
                className="inline-flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white text-sm rounded-lg"
              >
                {testing ? <Loader2 className="animate-spin" size={14} /> : <PlayCircle size={14} />}
                Test /v1/models
              </button>
              {testResult?.status === 'ok' && (
                <button
                  type="button"
                  onClick={() => runTest(true)}
                  disabled={testing}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm rounded-lg"
                >
                  {testing ? <Loader2 className="animate-spin" size={14} /> : <PlayCircle size={14} />}
                  Also probe chat
                </button>
              )}
            </div>
            {testResult && <TestResultPanel result={testResult} />}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <Label>Default model</Label>
            <select
              value={defaultModel}
              onChange={e => setDefaultModel(e.target.value)}
              className="input font-mono"
            >
              <option value="">(choose)</option>
              {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <Help>{availableModels.length} models returned by the provider. Feature code can override per-call.</Help>
          </div>

          <div>
            <Label>Purpose tags</Label>
            <div className="flex flex-wrap gap-2">
              {PURPOSE_PRESETS.map(tag => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setPurposeTags(p => p.includes(tag) ? p.filter(x => x !== tag) : [...p, tag])}
                  className={`px-2.5 py-1 text-xs rounded-full border ${
                    purposeTags.includes(tag)
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
            <Help>Features ask "which provider serves <i>text_to_sql</i>?" and the adapter picks from this list.</Help>
          </div>

          <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer p-3 rounded-lg bg-indigo-50 border border-indigo-100">
            <input
              type="checkbox"
              checked={isFallback}
              onChange={e => setIsFallback(e.target.checked)}
              className="mt-0.5 rounded"
            />
            <span>
              <span className="font-medium">Use as fallback</span>
              <span className="block text-xs text-slate-500 mt-0.5">
                When no provider matches a purpose tag, this one gets called. Max one active fallback system-wide.
              </span>
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Default temperature</Label>
              <input
                type="number" step="0.01" min="0" max="2"
                value={temperature}
                onChange={e => setTemperature(Number(e.target.value))}
                className="input"
              />
            </div>
            <div>
              <Label>Default max tokens</Label>
              <input
                type="number" min="1" max="100000"
                value={maxTokens}
                onChange={e => setMaxTokens(Number(e.target.value))}
                className="input"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Monthly budget (USD)</Label>
              <input
                type="number" step="0.01" min="0"
                value={monthlyBudget}
                onChange={e => setMonthlyBudget(e.target.value)}
                placeholder="unlimited"
                className="input"
              />
              <Help>Cycle resets UTC day 1. Adapter returns 429 when exceeded.</Help>
            </div>
            <div>
              <Label>Rate limit (req/min)</Label>
              <input
                type="number" min="1"
                value={rateLimitRpm}
                onChange={e => setRateLimitRpm(e.target.value)}
                placeholder="unlimited"
                className="input"
              />
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-5 mt-5 border-t border-slate-200">
        <button
          onClick={onClose}
          className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900"
        >
          Cancel
        </button>
        <div className="flex items-center gap-2">
          {step === 2 && (
            <button
              onClick={() => setStep(1)}
              className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg inline-flex items-center gap-1.5"
            >
              <ArrowLeft size={14} /> Back
            </button>
          )}
          {step === 1 && (
            <button
              onClick={() => setStep(2)}
              disabled={!step1Valid || !step1TestPassed}
              title={!step1TestPassed ? 'Run Test /v1/models first' : ''}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white rounded-lg inline-flex items-center gap-1.5"
            >
              Next <ChevronRight size={14} />
            </button>
          )}
          {step === 2 && (
            <button
              onClick={save}
              disabled={saving || purposeTags.length === 0}
              className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded-lg inline-flex items-center gap-1.5"
            >
              {saving && <Loader2 className="animate-spin" size={14} />}
              Create provider
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TestResultPanel({ result }: { result: AIProviderTestResult }) {
  const badgeColor = result.status === 'ok' ? 'emerald' : result.status === 'partial' ? 'amber' : 'rose';
  const Icon = result.status === 'ok' ? Check : result.status === 'partial' ? AlertTriangle : X;
  return (
    <div className={`mt-3 p-3 rounded-lg bg-${badgeColor}-50 border border-${badgeColor}-200 text-sm space-y-1.5`}>
      <div className={`flex items-center gap-2 text-${badgeColor}-700 font-medium`}>
        <Icon size={14} />
        {result.status === 'ok'   && 'Provider is reachable and authenticated.'}
        {result.status === 'partial' && 'Models endpoint works, but the chat probe failed.'}
        {result.status === 'failed' && `Probe failed: ${result.message || result.reason}`}
      </div>
      {result.status !== 'failed' && result.model_count !== undefined && (
        <div className="text-xs text-slate-600">
          Returned <b>{result.model_count}</b> model{result.model_count === 1 ? '' : 's'}.
          {result.models_sample && result.models_sample.length > 0 && (
            <span className="ml-1 font-mono">
              e.g. {result.models_sample.slice(0, 3).join(', ')}{result.models_sample.length > 3 ? '…' : ''}
            </span>
          )}
        </div>
      )}
      {result.chat_probe && (
        result.chat_probe.ok ? (
          <div className="text-xs text-emerald-700">
            Chat probe ok ({result.chat_probe.latency_ms}ms): <span className="font-mono italic">"{result.chat_probe.sample}"</span>
          </div>
        ) : (
          <div className="text-xs text-amber-700">
            Chat probe failed ({result.chat_probe.reason}): {result.chat_probe.message}
          </div>
        )
      )}
      {result.status === 'failed' && result.reason === 'auth_failed' && (
        <div className="text-xs text-rose-600 font-medium">→ Provider rejected the key. Double-check and try again.</div>
      )}
      {result.status === 'failed' && result.reason === 'unreachable' && (
        <div className="text-xs text-rose-600 font-medium">→ Could not reach <code className="bg-rose-100 px-1 rounded">base_url</code>. Check network / firewall.</div>
      )}
    </div>
  );
}

// ─── Detail view ────────────────────────────────────────────
function ProviderDetail({ id, onBack, onReload }: { id: string; onBack: () => void; onReload: () => Promise<void> }) {
  const toast = useToast();
  const [p, setP] = useState<AIProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<AIProviderUsage | null>(null);
  const [auditRows, setAuditRows] = useState<AIProviderAuditEntry[]>([]);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AIProviderTestResult | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [usagePeriod, setUsagePeriod] = useState<'24h' | '7d' | '30d'>('7d');

  async function load() {
    setLoading(true);
    try {
      const [prov, audit] = await Promise.all([
        api.aiProvider(id),
        api.aiProviderAudit(id).catch(() => [] as AIProviderAuditEntry[]),
      ]);
      setP(prov);
      setAuditRows(audit);
    } catch (err) {
      toast.error(`Load failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadUsage() {
    try {
      const u = await api.aiProviderUsage(id, usagePeriod);
      setUsage(u);
    } catch {
      setUsage(null);
    }
  }

  useEffect(() => { load(); }, [id]);
  useEffect(() => { loadUsage(); }, [id, usagePeriod]);

  async function patchField(fields: Partial<AIProvider>) {
    try {
      await api.aiProviderUpdate(id, fields);
      toast.success('Updated');
      await load();
      await onReload();
    } catch (err) {
      toast.error(`Update failed: ${(err as Error).message}`);
    }
  }

  async function handleTest(runChat: boolean) {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.aiProviderTest(id, runChat);
      setTestResult(r);
      await load();
    } catch (err) {
      toast.error(`Test failed: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleRefreshModels() {
    setRefreshingModels(true);
    try {
      const r = await api.aiProviderRefreshModels(id);
      toast.success(`Refreshed — ${r.model_count} models`);
      await load();
    } catch (err) {
      toast.error(`Refresh failed: ${(err as Error).message}`);
    } finally {
      setRefreshingModels(false);
    }
  }

  async function handleDeactivate() {
    if (!confirm(`Deactivate ${p!.display_name}? Feature code asking for its purpose tags will fail over to another provider (or error if this is the fallback).`)) return;
    try {
      await api.aiProviderDelete(id);
      toast.success('Deactivated');
      await load();
      await onReload();
    } catch (err) {
      toast.error(`Deactivate failed: ${(err as Error).message}`);
    }
  }

  async function handleReactivate() {
    try {
      await api.aiProviderReactivate(id);
      toast.success('Reactivated');
      await load();
      await onReload();
    } catch (err) {
      toast.error(`Reactivate failed: ${(err as Error).message}`);
    }
  }

  if (loading || !p) {
    return (
      <div className="p-6 flex items-center justify-center text-slate-500">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft size={14} /> Back to providers
      </button>

      {/* §9.2 banner */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3">
        <Shield size={18} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-900">
          <b>AI inherits the caller's authz bounds</b> (Constitution §9.2). Every prompt is audited with hashed content (§9.6).
          Permissions are managed in <b>Roles → Permissions</b> under <code className="bg-amber-100 px-1 rounded">ai_provider:*</code>.
        </div>
      </div>

      {/* Header */}
      <header className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
            p.is_active ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-400'
          }`}>
            <Sparkles size={24} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-900">{p.display_name}</h2>
              {p.is_fallback && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 uppercase">Fallback</span>}
              {!p.is_active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 uppercase">Deactivated</span>}
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono flex items-center gap-2">
              <span>{p.provider_id}</span>
              <CopyButton text={p.provider_id} />
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono flex items-center gap-2">
              <ExternalLink size={12} />
              <span>{p.base_url}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => handleTest(false)}
              disabled={testing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-sm rounded-lg"
            >
              {testing ? <Loader2 className="animate-spin" size={14} /> : <PlayCircle size={14} />}
              Test
            </button>
            <button
              onClick={() => setRotateOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-sm rounded-lg"
            >
              <Key size={14} /> Rotate key
            </button>
            {p.is_active ? (
              <button
                onClick={handleDeactivate}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-rose-200 hover:bg-rose-50 text-rose-600 text-sm rounded-lg"
              >
                <Trash2 size={14} /> Deactivate
              </button>
            ) : (
              <button
                onClick={handleReactivate}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg"
              >
                <RotateCcw size={14} /> Reactivate
              </button>
            )}
          </div>
        </div>

        {/* Inline test result */}
        {testResult && <TestResultPanel result={testResult} />}

        {/* Summary badges */}
        <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-4 gap-4 text-xs">
          <Stat label="Key" value={p.api_key_set ? `••••${p.api_key_last4}` : 'not set'} tone={p.api_key_set ? 'ok' : 'warn'} />
          <Stat label="Health" value={p.last_test_status ?? 'untested'} tone={p.last_test_status === 'ok' ? 'ok' : p.last_test_status ? 'warn' : 'muted'} />
          <Stat label="Purpose" value={p.purpose_tags.join(', ') || '—'} />
          <Stat label="Budget" value={p.monthly_budget_usd ? `$${p.monthly_budget_usd} / mo` : 'unlimited'} />
        </div>
      </header>

      {/* Routing + defaults */}
      <Section title="Routing & defaults">
        <div className="grid grid-cols-2 gap-5">
          <PurposeTagsEditor
            value={p.purpose_tags}
            onSave={(tags) => patchField({ purpose_tags: tags })}
          />
          <div>
            <Label>Default model</Label>
            <ModelSelect
              value={p.default_model ?? ''}
              options={p.available_models}
              onSave={(m) => patchField({ default_model: m || null })}
            />
          </div>
          <div>
            <Label>Fallback provider</Label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={p.is_fallback}
                onChange={e => patchField({ is_fallback: e.target.checked })}
                className="rounded"
              />
              Use when no purpose tag matches
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <EditableNumber label="Temperature" step={0.01} min={0} max={2}
              value={p.default_temperature} onSave={(v) => patchField({ default_temperature: v })} />
            <EditableNumber label="Max tokens" step={1} min={1}
              value={p.default_max_tokens} onSave={(v) => patchField({ default_max_tokens: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <EditableNumber label="Monthly budget (USD)" step={0.01} min={0}
              value={p.monthly_budget_usd ?? 0}
              placeholder="unlimited"
              onSave={(v) => patchField({ monthly_budget_usd: v || null })} />
            <EditableNumber label="Rate limit (rpm)" step={1} min={0}
              value={p.rate_limit_rpm ?? 0}
              placeholder="unlimited"
              onSave={(v) => patchField({ rate_limit_rpm: v || null })} />
          </div>
        </div>
      </Section>

      {/* Models list with refresh */}
      <Section
        title={`Available models (${p.available_models.length})`}
        action={
          <button
            onClick={handleRefreshModels}
            disabled={refreshingModels}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
          >
            {refreshingModels ? <Loader2 className="animate-spin" size={12} /> : <RefreshCw size={12} />}
            Refresh from provider
          </button>
        }
      >
        {p.available_models.length === 0 ? (
          <div className="text-sm text-slate-500 italic">No models yet. Click <b>Refresh from provider</b> to query <code className="bg-slate-100 px-1 rounded">/v1/models</code>.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {p.available_models.map(m => (
              <span key={m} className={`text-xs px-2 py-0.5 rounded font-mono ${
                m === p.default_model ? 'bg-blue-100 text-blue-700 font-medium' : 'bg-slate-100 text-slate-700'
              }`}>{m}</span>
            ))}
          </div>
        )}
      </Section>

      {/* Pricing editor */}
      <PricingEditor pricing={p.pricing} models={p.available_models} onSave={(pr) => patchField({ pricing: pr as any })} />

      {/* Usage */}
      <Section
        title="Usage"
        action={
          <div className="flex items-center gap-1">
            {(['24h', '7d', '30d'] as const).map(k => (
              <button
                key={k}
                onClick={() => setUsagePeriod(k)}
                className={`px-2 py-0.5 text-xs rounded ${
                  usagePeriod === k ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        }
      >
        {!usage && <div className="text-sm text-slate-500">No usage yet.</div>}
        {usage && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-3 text-xs">
              <UsageStat label="Calls" value={usage.summary.call_count} />
              <UsageStat label="OK / errors" value={`${usage.summary.ok_count} / ${usage.summary.error_count}`} />
              <UsageStat label="Tokens (in/out)" value={`${fmtTokens(usage.summary.prompt_tokens_total)} / ${fmtTokens(usage.summary.completion_tokens_total)}`} />
              <UsageStat label="Avg latency" value={usage.summary.avg_latency_ms ? `${usage.summary.avg_latency_ms}ms` : '—'} />
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-500">Month-to-date cost:</span>
              <span className="font-semibold">${Number(usage.cost_usd_month_to_date).toFixed(4)}</span>
              {p.monthly_budget_usd && (
                <span className="text-slate-400">of ${p.monthly_budget_usd.toFixed(2)} budget (resets UTC day 1)</span>
              )}
            </div>
            {usage.by_feature.length > 0 && (
              <div>
                <div className="text-xs font-medium text-slate-600 mb-1.5">By feature</div>
                <div className="space-y-1 text-xs font-mono">
                  {usage.by_feature.map((f, i) => (
                    <div key={i} className="flex items-center justify-between py-1 px-2 bg-slate-50 rounded">
                      <span>{f.feature_tag ?? '(untagged)'}</span>
                      <span className="text-slate-500">{f.calls} calls · ${Number(f.cost_usd).toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Audit strip */}
      <Section title="Recent changes (last 20)">
        {auditRows.length === 0 && <div className="text-sm text-slate-500">No config changes yet.</div>}
        {auditRows.length > 0 && (
          <div className="divide-y divide-slate-100 text-xs">
            {auditRows.map((a) => (
              <div key={a.id} className="py-2 flex items-center gap-3">
                <span className="shrink-0 font-mono text-slate-500">{new Date(a.timestamp).toLocaleString()}</span>
                <span className="shrink-0 font-semibold text-slate-800">{a.action}</span>
                <span className="text-slate-600">by {a.user_id}</span>
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-semibold ${
                  a.actor_type === 'ai_agent' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'
                }`}>{a.actor_type}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {rotateOpen && (
        <RotateKeyModal
          providerId={id}
          lastFour={p.api_key_last4}
          onClose={() => setRotateOpen(false)}
          onRotated={() => { setRotateOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ─── Small pieces ───────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-xl max-h-[90vh] bg-white rounded-xl shadow-2xl border border-slate-200 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function StepDot({ active, done, children }: { active: boolean; done: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs ${
      done ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
        : active ? 'bg-blue-50 border-blue-200 text-blue-700 font-medium'
        : 'bg-slate-50 border-slate-200 text-slate-500'
    }`}>
      {done && <Check size={12} />}
      {children}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-slate-700 mb-1.5">{children}</label>;
}
function Help({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-slate-500 mt-1">{children}</div>;
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'ok' | 'warn' | 'muted' }) {
  const toneCls = tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-600';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">{label}</div>
      <div className={`mt-0.5 font-medium text-sm ${toneCls} truncate`}>{value}</div>
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-slate-50 rounded-lg p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">{label}</div>
      <div className="text-sm font-semibold text-slate-800 mt-0.5">{value}</div>
    </div>
  );
}

function fmtTokens(v: string | number): string {
  const n = Number(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="text-slate-400 hover:text-slate-700"
      title="Copy"
    >
      {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
    </button>
  );
}

function EditableNumber({ label, value, onSave, placeholder, step, min, max }: {
  label: string; value: number; onSave: (n: number) => void; placeholder?: string; step?: number; min?: number; max?: number;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const dirty = v !== value;
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={v}
          placeholder={placeholder}
          onChange={e => setV(Number(e.target.value))}
          className="input"
        />
        {dirty && (
          <button
            onClick={() => onSave(v)}
            className="px-2 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
            title="Save"
          >
            <Check size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function ModelSelect({ value, options, onSave }: { value: string; options: string[]; onSave: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onSave(e.target.value)}
      className="input font-mono"
    >
      <option value="">(none)</option>
      {options.map(m => <option key={m} value={m}>{m}</option>)}
      {value && !options.includes(value) && <option value={value}>{value} (custom)</option>}
    </select>
  );
}

function PurposeTagsEditor({ value, onSave }: { value: string[]; onSave: (tags: string[]) => void }) {
  const [tags, setTags] = useState(value);
  useEffect(() => setTags(value), [value]);
  const dirty = JSON.stringify(tags.slice().sort()) !== JSON.stringify(value.slice().sort());
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <Label>Purpose tags</Label>
        {dirty && (
          <button
            onClick={() => onSave(tags)}
            className="px-2 py-0.5 text-[10px] bg-blue-600 hover:bg-blue-700 text-white rounded uppercase tracking-wide font-semibold"
          >
            Save
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PURPOSE_PRESETS.map(tag => (
          <button
            key={tag}
            type="button"
            onClick={() => setTags(t => t.includes(tag) ? t.filter(x => x !== tag) : [...t, tag])}
            className={`px-2 py-0.5 text-xs rounded-full border ${
              tags.includes(tag)
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-slate-200 text-slate-600 hover:border-slate-300'
            }`}
          >
            {tag}
          </button>
        ))}
      </div>
    </div>
  );
}

function PricingEditor({ pricing, models, onSave }: {
  pricing: AIProviderPricing; models: string[]; onSave: (p: AIProviderPricing) => void;
}) {
  const [draft, setDraft] = useState<AIProviderPricing>(pricing);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setDraft(pricing), [pricing]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(pricing);
  const entries = Object.entries(draft);
  return (
    <Section
      title={`Pricing (${entries.length} models)`}
      action={
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={() => onSave(draft)}
              className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
            >
              Save pricing
            </button>
          )}
          <button
            onClick={() => setExpanded(x => !x)}
            className="text-slate-400 hover:text-slate-600"
          >
            <ChevronDown size={16} className={expanded ? 'rotate-180' : ''} />
          </button>
        </div>
      }
    >
      <div className="text-xs text-slate-500 mb-2">
        USD per 1,000,000 tokens. Adapter computes cost = (prompt_tokens × input + completion_tokens × output) / 1M.
      </div>
      {!expanded && entries.length > 0 && (
        <div className="text-xs text-slate-500">
          {entries.slice(0, 3).map(([m, p]) => (
            <span key={m} className="mr-3 font-mono">{m}: <b>${p.input}</b>/<b>${p.output}</b></span>
          ))}
          {entries.length > 3 && <span className="text-slate-400">+{entries.length - 3} more</span>}
        </div>
      )}
      {expanded && (
        <div className="space-y-2">
          {entries.map(([model, p]) => (
            <div key={model} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 text-xs">
              <span className="font-mono truncate">{model}</span>
              <input
                type="number" step="0.01" min="0"
                value={p.input}
                onChange={e => setDraft(d => ({ ...d, [model]: { ...d[model], input: Number(e.target.value) } }))}
                className="w-20 px-2 py-1 border border-slate-200 rounded"
                title="Input $/1M tokens"
              />
              <span className="text-slate-400">/</span>
              <input
                type="number" step="0.01" min="0"
                value={p.output}
                onChange={e => setDraft(d => ({ ...d, [model]: { ...d[model], output: Number(e.target.value) } }))}
                className="w-20 px-2 py-1 border border-slate-200 rounded"
                title="Output $/1M tokens"
              />
            </div>
          ))}
          {/* Add row for models without pricing */}
          {models.filter(m => !entries.some(([k]) => k === m)).map(model => (
            <div key={model} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 text-xs opacity-60 hover:opacity-100">
              <span className="font-mono truncate">{model}</span>
              <input
                type="number" step="0.01" min="0" placeholder="0.00"
                onChange={e => setDraft(d => ({ ...d, [model]: { input: Number(e.target.value), output: d[model]?.output ?? 0 } }))}
                className="w-20 px-2 py-1 border border-slate-200 rounded"
              />
              <span className="text-slate-400">/</span>
              <input
                type="number" step="0.01" min="0" placeholder="0.00"
                onChange={e => setDraft(d => ({ ...d, [model]: { input: d[model]?.input ?? 0, output: Number(e.target.value) } }))}
                className="w-20 px-2 py-1 border border-slate-200 rounded"
              />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function RotateKeyModal({ providerId, lastFour, onClose, onRotated }: {
  providerId: string; lastFour: string | null; onClose: () => void; onRotated: () => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!key.trim()) return;
    setSaving(true);
    try {
      const r = await api.aiProviderRotateKey(providerId, key);
      toast.success(`Rotated — new key ••••${r.api_key_last4}`);
      onRotated();
    } catch (err) {
      toast.error(`Rotate failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Rotate API key" onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm text-slate-600">
          Current key: <span className="font-mono">{lastFour ? `••••${lastFour}` : 'not set'}</span>
        </div>
        <div>
          <Label>New API key</Label>
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="sk-..."
            className="input font-mono"
            autoComplete="new-password"
          />
          <Help>The new key replaces the old one immediately. In-flight requests using the old key will fail.</Help>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !key.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white rounded-lg inline-flex items-center gap-1.5"
          >
            {saving && <Loader2 className="animate-spin" size={14} />}
            Rotate
          </button>
        </div>
      </div>
    </Modal>
  );
}
