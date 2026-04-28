// ============================================================
// AI Call Adapter — OpenAI-compatible chat/completions client
//
// Selects an active provider by purpose tag, decrypts its API key, calls
// /chat/completions, and writes a hash-only row to authz_ai_usage.
//
// Constitution refs:
//   §9.2 — caller's userId is forwarded into authz_ai_usage.called_by, so the
//          ledger inherits the caller's authz bounds (no agent shadow user).
//   §9.3 — any callable that yields SQL must run a destructive-keyword guard
//          before returning to the route layer (sandbox-before-deploy).
//   §9.6 — only SHA-256 hash + token counts are persisted in authz_ai_usage,
//          never raw prompt. Plaintext lives in authz_eval_case ONLY when the
//          user clicks 👍/👎 (§9.9 explicit-consent carve-out).
// ============================================================

import { createHash } from 'crypto';
import { pool as authzPool } from '../db';
import { decrypt } from './crypto';

export interface ProviderRow {
  provider_id: string;
  display_name: string;
  base_url: string;
  api_key_encrypted: string | null;
  default_model: string | null;
  default_temperature: number | null;
  default_max_tokens: number | null;
  timeout_ms: number;
  pricing: Record<string, { input?: number; output?: number }>;
  purpose_tags: string[];
}

export interface AICallResult {
  text: string;
  provider_id: string;
  model_id: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
}

export class NoProviderError extends Error {
  constructor(public purpose: string) {
    super(
      `No active AI provider with purpose_tags including '${purpose}'. ` +
      `Register one in the AI Providers tab (purpose_tags must contain '${purpose}').`,
    );
    this.name = 'NoProviderError';
  }
}

export class DestructiveSqlError extends Error {
  constructor(public matched: string) {
    super(`AI output blocked: contains destructive keyword '${matched}'. Constitution §9.3 — only CREATE OR REPLACE FUNCTION is permitted via this path.`);
    this.name = 'DestructiveSqlError';
  }
}

// §9.3 destructive-keyword guard. Matches whole words only so column names
// like `dropped_at` don't trip the regex.
const DESTRUCTIVE = /\b(DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+INTO)\b/i;

export function rejectIfDestructive(sql: string): void {
  const m = sql.match(DESTRUCTIVE);
  if (m) throw new DestructiveSqlError(m[0]);
}

/**
 * Pick the highest-priority provider that advertises the requested purpose.
 * Active fallback wins ties so admins can pin a default.
 */
export async function resolveProvider(purpose: string): Promise<ProviderRow> {
  const result = await authzPool.query<ProviderRow>(
    `SELECT provider_id, display_name, base_url, api_key_encrypted,
            default_model, default_temperature, default_max_tokens,
            timeout_ms, pricing, purpose_tags
     FROM authz_ai_provider
     WHERE is_active = TRUE
       AND $1 = ANY(purpose_tags)
     ORDER BY is_fallback DESC, display_name
     LIMIT 1`,
    [purpose],
  );
  if (result.rows.length === 0) throw new NoProviderError(purpose);
  return result.rows[0];
}

function priceFor(provider: ProviderRow, model: string, prompt: number, completion: number): number | null {
  const p = provider.pricing?.[model];
  if (!p || (p.input == null && p.output == null)) return null;
  const inUsd = ((p.input ?? 0) * prompt) / 1_000_000;
  const outUsd = ((p.output ?? 0) * completion) / 1_000_000;
  return Number((inUsd + outUsd).toFixed(6));
}

export interface CallChatOpts {
  provider: ProviderRow;
  systemPrompt: string;
  userPrompt: string;
  model?: string;       // override default_model
  temperature?: number; // override default_temperature
  maxTokens?: number;   // override default_max_tokens
}

/**
 * Call provider's /chat/completions. Returns text + token/cost metadata.
 * Caller is responsible for logUsage() to authz_ai_usage so the route can
 * stamp the correct feature_tag and called_by.
 */
export async function callChat(opts: CallChatOpts): Promise<AICallResult> {
  const { provider } = opts;
  const model = opts.model || provider.default_model;
  if (!model) throw new Error(`Provider ${provider.provider_id} has no default_model and no override supplied.`);
  const apiKey = provider.api_key_encrypted ? decrypt(provider.api_key_encrypted) : null;

  const url = provider.base_url.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeout_ms);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? provider.default_temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? provider.default_max_tokens ?? 2048,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Provider HTTP ${resp.status}: ${detail.slice(0, 200)}`);
    }
    const json: any = await resp.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('Provider response missing choices[0].message.content');
    const promptTokens = json?.usage?.prompt_tokens ?? null;
    const completionTokens = json?.usage?.completion_tokens ?? null;
    return {
      text,
      provider_id: provider.provider_id,
      model_id: model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: promptTokens != null && completionTokens != null
        ? priceFor(provider, model, promptTokens, completionTokens)
        : null,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export interface LogUsageOpts {
  userId: string;
  featureTag: string;
  promptText: string;     // hashed before insert per §9.6
  result: AICallResult;
  status?: 'ok' | 'error' | 'timeout' | 'rate_limited' | 'budget_exceeded';
  errorDetail?: string;
}

/**
 * Insert one authz_ai_usage row (hash-only per §9.6) and return the new
 * usage_id. Callers pass usage_id to the client so the user can later mark
 * that case via POST /api/ai-assist/eval-mark (§9.9 explicit-consent path).
 *
 * Returns null if the insert failed — eval-mark won't FK-link in that case
 * but the rest of the response stays usable.
 */
export async function logUsage(opts: LogUsageOpts): Promise<number | null> {
  const promptHash = createHash('sha256').update(opts.promptText).digest('hex');
  try {
    const r = await authzPool.query<{ usage_id: string }>(
      `INSERT INTO authz_ai_usage (
         provider_id, called_by, feature_tag, model_id,
         prompt_hash, prompt_tokens, completion_tokens, cost_usd, latency_ms,
         status, error_detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING usage_id`,
      [
        opts.result.provider_id,
        opts.userId,
        opts.featureTag,
        opts.result.model_id,
        promptHash,
        opts.result.prompt_tokens,
        opts.result.completion_tokens,
        opts.result.cost_usd,
        opts.result.latency_ms,
        opts.status ?? 'ok',
        opts.errorDetail ?? null,
      ],
    );
    return r.rows[0] ? Number(r.rows[0].usage_id) : null;
  } catch (err) {
    console.error('[ai-call] logUsage failed:', err);
    return null;
  }
}

/**
 * Pull the first ```sql ... ``` block, or the first `CREATE [OR REPLACE]
 * FUNCTION ... $$;` body if no fenced block is present. Falls back to the
 * raw text trimmed.
 */
export function extractSql(text: string): string {
  const fenced = text.match(/```(?:sql|postgresql|postgres)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const idx = text.search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  if (idx >= 0) return text.slice(idx).trim();
  return text.trim();
}
