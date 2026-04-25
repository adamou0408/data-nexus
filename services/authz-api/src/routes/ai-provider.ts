// ============================================================
// AI Provider Registry API (Constitution §9.1 scope)
//
// Endpoints:
//   GET    /                     — list (admin: full; non-admin: lite subset)
//   GET    /:id                  — detail (admin only)
//   POST   /                     — create
//   PATCH  /:id                  — update non-key fields
//   PATCH  /:id/key              — rotate API key
//   DELETE /:id                  — soft delete (is_active=FALSE)
//   POST   /:id/reactivate       — restore soft-deleted provider
//   POST   /_test                — probe unsaved form data
//   POST   /:id/test             — probe saved provider
//   POST   /:id/refresh-models   — re-query /v1/models
//   GET    /:id/usage            — usage summary
//   GET    /:id/audit            — recent config changes (last 20)
//
// Security:
//   * Router mounted behind requireRole('ADMIN','AUTHZ_ADMIN') for config ops.
//   * `listAIProvidersLite` exported for requireAuth-only mount (runtime callers).
//   * api_key stored via lib/crypto.ts (enc:iv:tag:data). Never returned to client.
//
// Error translation: HTTP 401 → "Provider rejected key", ECONNREFUSED → "Can't reach base_url",
// so the wizard's test button shows something actionable instead of a raw stack.
// ============================================================

import { Router } from 'express';
import { pool as authzPool } from '../db';
import { encrypt, decrypt } from '../lib/crypto';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';

export const aiProviderRouter = Router();

// ─── Helpers ────────────────────────────────────────────────

function last4OfKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length < 4) return null;
  return trimmed.slice(-4);
}

function sanitizeRow(row: any): any {
  // Never send ciphertext to the client. Only show last4 + rotation time.
  const { api_key_encrypted, ...safe } = row;
  return {
    ...safe,
    api_key_set: !!api_key_encrypted,
  };
}

type ProbeError = {
  reason: 'auth_failed' | 'unreachable' | 'timeout' | 'bad_response' | 'rate_limited' | 'server_error';
  message: string;
  http_status?: number;
};

function translateProbeError(err: unknown): ProbeError {
  const msg = String((err as any)?.message ?? err);
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
    return { reason: 'unreachable', message: "Can't reach base_url — check hostname, firewall, or VPN." };
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('aborted') || msg.includes('timeout')) {
    return { reason: 'timeout', message: 'Provider did not respond within timeout_ms.' };
  }
  if (msg.includes('ECONNRESET')) {
    return { reason: 'unreachable', message: 'Connection reset — TLS / proxy issue likely.' };
  }
  return { reason: 'server_error', message: msg };
}

async function probeModels(params: {
  base_url: string;
  api_key: string | null;
  timeout_ms?: number;
}): Promise<{ ok: true; models: string[] } | ({ ok: false } & ProbeError)> {
  const url = params.base_url.replace(/\/+$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeout_ms ?? 15000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        ...(params.api_key ? { Authorization: `Bearer ${params.api_key}` } : {}),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, reason: 'auth_failed', message: `Provider rejected key (HTTP ${resp.status}).`, http_status: resp.status };
    }
    if (resp.status === 429) {
      return { ok: false, reason: 'rate_limited', message: 'Provider rate-limited the probe. Try again in a moment.', http_status: 429 };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, reason: 'server_error', message: `Provider returned HTTP ${resp.status}: ${text.slice(0, 200)}`, http_status: resp.status };
    }
    const json: any = await resp.json().catch(() => null);
    if (!json || !Array.isArray(json.data)) {
      return { ok: false, reason: 'bad_response', message: "Response did not match OpenAI's /v1/models shape ({data:[{id}]})." };
    }
    const models = json.data.map((m: any) => m.id).filter((x: any) => typeof x === 'string');
    return { ok: true, models };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, ...translateProbeError(err) };
  }
}

async function probeChat(params: {
  base_url: string;
  api_key: string | null;
  model: string;
  timeout_ms?: number;
}): Promise<{ ok: true; sample: string; latency_ms: number } | ({ ok: false } & ProbeError)> {
  const url = params.base_url.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeout_ms ?? 20000);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...(params.api_key ? { Authorization: `Bearer ${params.api_key}` } : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, reason: 'auth_failed', message: `Provider rejected key (HTTP ${resp.status}).`, http_status: resp.status };
    }
    if (resp.status === 429) {
      return { ok: false, reason: 'rate_limited', message: 'Provider rate-limited the probe.', http_status: 429 };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, reason: 'server_error', message: `HTTP ${resp.status}: ${text.slice(0, 200)}`, http_status: resp.status };
    }
    const json: any = await resp.json().catch(() => null);
    const sample = json?.choices?.[0]?.message?.content;
    if (typeof sample !== 'string') {
      return { ok: false, reason: 'bad_response', message: 'chat/completions response missing choices[0].message.content.' };
    }
    return { ok: true, sample: sample.slice(0, 120), latency_ms: Date.now() - t0 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, ...translateProbeError(err) };
  }
}

// ─── Lite list (any authenticated user) ────────────────────
// Returns only {provider_id, display_name, purpose_tags, default_model, is_active}
// — enough for feature code to ask "which provider serves purpose X?" without
// leaking base_url / key metadata.
export async function listAIProvidersLite(_req: any, res: any) {
  try {
    const result = await authzPool.query(`
      SELECT provider_id, display_name, purpose_tags, default_model, is_active, is_fallback
      FROM authz_ai_provider
      WHERE is_active = TRUE
      ORDER BY is_fallback DESC, display_name
    `);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
  }
}

// ─── List (admin full view) ─────────────────────────────────
aiProviderRouter.get('/', async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
  try {
    const result = await authzPool.query(`
      SELECT provider_id, display_name, description, provider_kind, base_url,
             api_key_last4, api_key_rotated_at,
             default_model, available_models, default_temperature, default_max_tokens,
             timeout_ms, pricing, purpose_tags, is_fallback,
             monthly_budget_usd, rate_limit_rpm,
             last_tested_at, last_test_status, last_test_detail,
             is_active, owner_subject, registered_by, created_at, updated_at,
             (api_key_encrypted IS NOT NULL) AS api_key_set
      FROM authz_ai_provider
      ${includeInactive ? '' : 'WHERE is_active = TRUE'}
      ORDER BY is_active DESC, is_fallback DESC, display_name
    `);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Detail ─────────────────────────────────────────────────
aiProviderRouter.get('/:id', async (req, res) => {
  try {
    const result = await authzPool.query(`
      SELECT * FROM authz_ai_provider WHERE provider_id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    res.json(sanitizeRow(result.rows[0]));
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Create ─────────────────────────────────────────────────
aiProviderRouter.post('/', async (req, res) => {
  const {
    provider_id, display_name, description,
    provider_kind = 'openai', base_url,
    api_key,                                   // plaintext, one-shot
    default_model, available_models = [],
    default_temperature = 0.2, default_max_tokens = 4096,
    timeout_ms = 30000,
    pricing = {},
    purpose_tags = [], is_fallback = false,
    monthly_budget_usd = null, rate_limit_rpm = null,
    owner_subject = null,
    is_active = true,
  } = req.body ?? {};

  if (!provider_id || !display_name || !base_url) {
    return res.status(400).json({ error: 'provider_id, display_name, base_url are required' });
  }
  if (!/^ai:[a-z0-9_\-]+$/i.test(provider_id)) {
    return res.status(400).json({ error: "provider_id must match /^ai:[a-z0-9_\\-]+$/" });
  }

  const registeredBy = getUserId(req);
  const apiKeyEncrypted = api_key ? encrypt(api_key) : null;
  const apiKeyLast4 = last4OfKey(api_key);
  const apiKeyRotatedAt = api_key ? new Date() : null;

  try {
    const result = await authzPool.query(`
      INSERT INTO authz_ai_provider (
        provider_id, display_name, description,
        provider_kind, base_url,
        api_key_encrypted, api_key_last4, api_key_rotated_at,
        default_model, available_models,
        default_temperature, default_max_tokens, timeout_ms,
        pricing, purpose_tags, is_fallback,
        monthly_budget_usd, rate_limit_rpm,
        owner_subject, registered_by, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING provider_id, display_name, provider_kind, is_active, created_at
    `, [
      provider_id, display_name, description,
      provider_kind, base_url,
      apiKeyEncrypted, apiKeyLast4, apiKeyRotatedAt,
      default_model, available_models,
      default_temperature, default_max_tokens, timeout_ms,
      JSON.stringify(pricing), purpose_tags, is_fallback,
      monthly_budget_usd, rate_limit_rpm,
      owner_subject, registeredBy, is_active,
    ]);

    await logAdminAction(authzPool, {
      userId: registeredBy,
      action: 'CREATE_AI_PROVIDER',
      resourceType: 'ai_provider',
      resourceId: provider_id,
      details: { provider_kind, base_url, purpose_tags, is_fallback, key_provided: !!api_key },
      ip: getClientIp(req),
      actorType: 'human',
      consentGiven: 'human_explicit',
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Update (non-key fields) ────────────────────────────────
aiProviderRouter.patch('/:id', async (req, res) => {
  const b = req.body ?? {};
  // Explicit field allow-list. api_key rotations go through /key.
  const fields: Record<string, any> = {};
  const allowed = [
    'display_name', 'description', 'provider_kind', 'base_url',
    'default_model', 'available_models',
    'default_temperature', 'default_max_tokens', 'timeout_ms',
    'pricing', 'purpose_tags', 'is_fallback',
    'monthly_budget_usd', 'rate_limit_rpm',
    'owner_subject', 'is_active',
  ];
  for (const k of allowed) {
    if (k in b) fields[k] = k === 'pricing' ? JSON.stringify(b[k]) : b[k];
  }
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const setClauses = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = [req.params.id, ...Object.values(fields)];

  try {
    const result = await authzPool.query(
      `UPDATE authz_ai_provider SET ${setClauses} WHERE provider_id = $1
       RETURNING provider_id, display_name, is_active, updated_at`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    await logAdminAction(authzPool, {
      userId: getUserId(req),
      action: 'UPDATE_AI_PROVIDER',
      resourceType: 'ai_provider',
      resourceId: req.params.id,
      details: { changed_fields: Object.keys(fields) },
      ip: getClientIp(req),
      actorType: 'human',
      consentGiven: 'human_explicit',
    });

    res.json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Rotate API key (separate endpoint — keeps config PATCH small and
// makes rotation auditable as its own action) ───────────────
aiProviderRouter.patch('/:id/key', async (req, res) => {
  const { api_key } = req.body ?? {};
  if (!api_key || typeof api_key !== 'string' || api_key.trim().length === 0) {
    return res.status(400).json({ error: 'api_key is required' });
  }

  try {
    const result = await authzPool.query(`
      UPDATE authz_ai_provider SET
        api_key_encrypted = $2,
        api_key_last4     = $3,
        api_key_rotated_at = now()
      WHERE provider_id = $1
      RETURNING provider_id, api_key_last4, api_key_rotated_at
    `, [req.params.id, encrypt(api_key), last4OfKey(api_key)]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    await logAdminAction(authzPool, {
      userId: getUserId(req),
      action: 'ROTATE_AI_PROVIDER_KEY',
      resourceType: 'ai_provider',
      resourceId: req.params.id,
      details: { new_last4: result.rows[0].api_key_last4 },
      ip: getClientIp(req),
      actorType: 'human',
      consentGiven: 'human_explicit',
    });

    res.json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Soft delete ───────────────────────────────────────────
aiProviderRouter.delete('/:id', async (req, res) => {
  try {
    const result = await authzPool.query(
      `UPDATE authz_ai_provider SET is_active = FALSE WHERE provider_id = $1
       RETURNING provider_id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    await logAdminAction(authzPool, {
      userId: getUserId(req),
      action: 'DEACTIVATE_AI_PROVIDER',
      resourceType: 'ai_provider',
      resourceId: req.params.id,
      ip: getClientIp(req),
      actorType: 'human',
      consentGiven: 'human_explicit',
    });
    res.json({ deactivated: req.params.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Reactivate ────────────────────────────────────────────
aiProviderRouter.post('/:id/reactivate', async (req, res) => {
  try {
    const result = await authzPool.query(
      `UPDATE authz_ai_provider SET is_active = TRUE WHERE provider_id = $1
       RETURNING provider_id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    await logAdminAction(authzPool, {
      userId: getUserId(req),
      action: 'REACTIVATE_AI_PROVIDER',
      resourceType: 'ai_provider',
      resourceId: req.params.id,
      ip: getClientIp(req),
      actorType: 'human',
      consentGiven: 'human_explicit',
    });
    res.json({ reactivated: req.params.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Test unsaved form data ────────────────────────────────
// Wizard calls this before persisting, so an invalid key never lands in the DB.
// Two layers: always probe /v1/models (cheap, free). Caller can opt in to a
// chat probe by setting run_chat_probe=true; costs a few tokens.
aiProviderRouter.post('/_test', async (req, res) => {
  const { base_url, api_key, default_model, timeout_ms = 15000, run_chat_probe = false } = req.body ?? {};
  if (!base_url) return res.status(400).json({ error: 'base_url is required' });

  const modelsResult = await probeModels({ base_url, api_key: api_key ?? null, timeout_ms });
  if (!modelsResult.ok) {
    const { ok: _ok, ...rest } = modelsResult;
    return res.json({ status: 'failed', layer: 'models', ...rest });
  }

  const body: any = {
    status: 'ok',
    models_reachable: true,
    model_count: modelsResult.models.length,
    models_sample: modelsResult.models.slice(0, 20),
  };

  if (run_chat_probe) {
    const modelToUse = default_model || modelsResult.models[0];
    if (!modelToUse) {
      body.chat_probe = { ok: false, reason: 'bad_response', message: 'No model to probe (models list empty and no default_model).' };
    } else {
      const chatResult = await probeChat({ base_url, api_key: api_key ?? null, model: modelToUse, timeout_ms: timeout_ms + 5000 });
      if (chatResult.ok) {
        body.chat_probe = { ok: true, model: modelToUse, sample: chatResult.sample, latency_ms: chatResult.latency_ms };
      } else {
        const { ok: _ok, ...rest } = chatResult;
        body.chat_probe = { ok: false, model: modelToUse, ...rest };
        body.status = 'partial';
      }
    }
  }

  res.json(body);
});

// ─── Test saved provider (uses stored key) ─────────────────
aiProviderRouter.post('/:id/test', async (req, res) => {
  const { run_chat_probe = false } = req.body ?? {};
  try {
    const dsResult = await authzPool.query(
      `SELECT provider_id, base_url, api_key_encrypted, default_model, timeout_ms
       FROM authz_ai_provider WHERE provider_id = $1`,
      [req.params.id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    const p = dsResult.rows[0];
    const api_key = p.api_key_encrypted ? decrypt(p.api_key_encrypted) : null;

    const models = await probeModels({ base_url: p.base_url, api_key, timeout_ms: p.timeout_ms });
    let finalStatus: 'ok' | 'partial' | 'failed' = models.ok ? 'ok' : 'failed';
    let body: any;
    if (models.ok) {
      body = { status: 'ok', models_reachable: true, model_count: models.models.length, models_sample: models.models.slice(0, 20) };
    } else {
      const { ok: _ok, ...rest } = models;
      body = { status: 'failed', layer: 'models', ...rest };
    }

    if (models.ok && run_chat_probe) {
      const modelToUse = p.default_model || models.models[0];
      if (modelToUse) {
        const chat = await probeChat({ base_url: p.base_url, api_key, model: modelToUse, timeout_ms: p.timeout_ms + 5000 });
        if (chat.ok) {
          body.chat_probe = { ok: true, model: modelToUse, sample: chat.sample, latency_ms: chat.latency_ms };
        } else {
          const { ok: _ok, ...rest } = chat;
          body.chat_probe = { ok: false, model: modelToUse, ...rest };
          finalStatus = 'partial';
        }
      }
    }

    body.status = finalStatus;

    // Stamp health fields so the list view can show a freshness badge.
    const stamp = finalStatus === 'ok' ? 'ok' : finalStatus;
    const detail = finalStatus === 'ok' ? null : (body.message ?? body.chat_probe?.message ?? null);
    await authzPool.query(
      `UPDATE authz_ai_provider SET
         last_tested_at = now(),
         last_test_status = $2,
         last_test_detail = $3
       WHERE provider_id = $1`,
      [req.params.id, stamp, detail]
    );

    res.json(body);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Refresh models list (re-query /v1/models and overwrite available_models) ──
aiProviderRouter.post('/:id/refresh-models', async (req, res) => {
  try {
    const pr = await authzPool.query(
      `SELECT base_url, api_key_encrypted, timeout_ms
       FROM authz_ai_provider WHERE provider_id = $1`,
      [req.params.id]
    );
    if (pr.rows.length === 0) return res.status(404).json({ error: 'Provider not found' });
    const p = pr.rows[0];
    const api_key = p.api_key_encrypted ? decrypt(p.api_key_encrypted) : null;

    const result = await probeModels({ base_url: p.base_url, api_key, timeout_ms: p.timeout_ms });
    if (!result.ok) {
      const { ok: _ok, ...rest } = result;
      return res.status(400).json({ status: 'failed', ...rest });
    }

    await authzPool.query(
      `UPDATE authz_ai_provider SET available_models = $2 WHERE provider_id = $1`,
      [req.params.id, result.models]
    );

    await logAdminAction(authzPool, {
      userId: getUserId(req),
      action: 'REFRESH_AI_PROVIDER_MODELS',
      resourceType: 'ai_provider',
      resourceId: req.params.id,
      details: { model_count: result.models.length },
      ip: getClientIp(req),
      actorType: 'human',
      consentGiven: 'human_explicit',
    });

    res.json({ status: 'ok', model_count: result.models.length, available_models: result.models });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Usage summary ─────────────────────────────────────────
aiProviderRouter.get('/:id/usage', async (req, res) => {
  const period = (req.query.period as string) || '30d';
  const interval = period === '7d' ? "7 days" : period === '24h' ? "1 day" : "30 days";
  try {
    const rollup = await authzPool.query(`
      SELECT
        count(*) AS call_count,
        count(*) FILTER (WHERE status = 'ok') AS ok_count,
        count(*) FILTER (WHERE status <> 'ok') AS error_count,
        coalesce(sum(prompt_tokens), 0) AS prompt_tokens_total,
        coalesce(sum(completion_tokens), 0) AS completion_tokens_total,
        coalesce(sum(cost_usd), 0) AS cost_usd_total,
        avg(latency_ms)::int AS avg_latency_ms
      FROM authz_ai_usage
      WHERE provider_id = $1 AND called_at > now() - $2::interval
    `, [req.params.id, interval]);

    const byFeature = await authzPool.query(`
      SELECT feature_tag, count(*) AS calls, coalesce(sum(cost_usd), 0) AS cost_usd
      FROM authz_ai_usage
      WHERE provider_id = $1 AND called_at > now() - $2::interval
      GROUP BY feature_tag
      ORDER BY calls DESC
      LIMIT 20
    `, [req.params.id, interval]);

    // Month-to-date cost for budget headroom display (calendar month, UTC).
    const mtd = await authzPool.query(`
      SELECT coalesce(sum(cost_usd), 0) AS cost_usd_mtd
      FROM authz_ai_usage
      WHERE provider_id = $1 AND called_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
    `, [req.params.id]);

    res.json({
      period,
      summary: rollup.rows[0],
      by_feature: byFeature.rows,
      cost_usd_month_to_date: mtd.rows[0].cost_usd_mtd,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Audit strip (last 20 admin actions against this provider) ──
aiProviderRouter.get('/:id/audit', async (req, res) => {
  try {
    const result = await authzPool.query(`
      SELECT id, timestamp, user_id, action, details, actor_type, agent_id, model_id, consent_given
      FROM authz_admin_audit_log
      WHERE resource_type = 'ai_provider' AND resource_id = $1
      ORDER BY timestamp DESC
      LIMIT 20
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
  }
});
