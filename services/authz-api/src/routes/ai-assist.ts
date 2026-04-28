// ============================================================
// AI-Assisted PG Function Authoring (dogfood phase)
//
// Three endpoints surface inside DataQueryTab → AuthorPanel:
//   POST /function-draft   — natural language → CREATE FUNCTION SQL
//   POST /function-refine  — current SQL + instruction → revised SQL
//   POST /function-explain — SQL → markdown explanation
//
// Constitution refs:
//   §9.2 — schema context is filtered through authz_check before the prompt.
//   §9.3 — AI never deploys; output lands in the textarea, Adam clicks Deploy.
//          Destructive keyword guard rejects DROP / TRUNCATE / GRANT / etc.
//   §9.6 — only SHA-256 hashes hit authz_ai_usage (raw prompt forbidden by
//          default). §9.9 carve-out: when user clicks 👍/👎, full plaintext
//          may be written to authz_eval_case via POST /eval-mark.
//   §9.7 — every call writes authz_admin_audit_log with actor_type='ai_agent',
//          consent_given='human_explicit' (user clicked the button).
// ============================================================

import { Router } from 'express';
import { pool as authzPool } from '../db';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';
import {
  resolveProvider, callChat, logUsage, extractSql, rejectIfDestructive,
  NoProviderError, DestructiveSqlError,
} from '../lib/ai-call';
import { buildSchemaContext } from '../lib/ai-context';

export const aiAssistRouter = Router();

const PURPOSE = 'sql_authoring';
const FEATURE_TAG = 'pg_function_authoring';

const SYSTEM_PROMPT_BASE = `You are an expert PostgreSQL function author embedded in an internal data platform.
You produce ONLY \`CREATE OR REPLACE FUNCTION\` statements; never DROP, ALTER, TRUNCATE, GRANT, REVOKE, COPY, INSERT, UPDATE, or DELETE.
You will be given a schema context for one data source. Use only identifiers from that context.
When asked to refine an existing function, preserve its signature unless the instruction requires changing it.
When asked to explain SQL, return concise GitHub-flavoured Markdown.`;

function userGroups(req: any): string[] {
  const raw = (req.headers['x-user-groups'] as string) || '';
  return raw.split(',').map((g) => g.trim()).filter(Boolean);
}

function handleAIError(res: any, err: unknown) {
  if (err instanceof NoProviderError) {
    return res.status(503).json({
      error: 'No AI provider available',
      detail: err.message,
      hint: 'Open the AI Providers tab and register one with purpose_tags including \'sql_authoring\'.',
    });
  }
  if (err instanceof DestructiveSqlError) {
    return res.status(422).json({
      error: 'AI output blocked by safety guard',
      detail: err.message,
    });
  }
  handleApiError(res, err);
}

// ─── POST /function-draft ───────────────────────────────────
aiAssistRouter.post('/function-draft', async (req, res) => {
  const { data_source_id, prompt } = req.body as { data_source_id?: string; prompt?: string };
  const userId = getUserId(req);
  if (!data_source_id || !prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'data_source_id and non-empty prompt are required' });
  }

  try {
    const provider = await resolveProvider(PURPOSE);
    const ctx = await buildSchemaContext({ userId, groups: userGroups(req), dataSourceId: data_source_id });

    const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\n--- SCHEMA CONTEXT ---\n${ctx.text}\n--- END SCHEMA CONTEXT ---`;
    const userPrompt = `Author a PostgreSQL function for data source \`${data_source_id}\`.\nRequest: ${prompt.trim()}`;

    const result = await callChat({ provider, systemPrompt, userPrompt });
    const sql = extractSql(result.text);
    rejectIfDestructive(sql);

    const usage_id = await logUsage({ userId, featureTag: FEATURE_TAG, promptText: `${systemPrompt}\n${userPrompt}`, result });
    await logAdminAction(authzPool, {
      userId,
      action: 'AI_ASSIST_FUNCTION_DRAFT',
      resourceType: 'ai_provider',
      resourceId: result.provider_id,
      details: {
        data_source_id,
        prompt_chars: prompt.length,
        schema_tables: ctx.table_count,
        truncated: ctx.truncated,
        sql_chars: sql.length,
      },
      ip: getClientIp(req),
      actorType: 'ai_agent',
      agentId: result.provider_id,
      modelId: result.model_id,
      consentGiven: 'human_explicit',
    });

    res.json({
      sql,
      rationale: result.text.length > sql.length ? result.text : null,
      provider_id: result.provider_id,
      model_id: result.model_id,
      usage_id,
      schema_truncated: ctx.truncated,
      schema_tables: ctx.table_count,
      usage: {
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        cost_usd: result.cost_usd,
        latency_ms: result.latency_ms,
      },
    });
  } catch (err) {
    handleAIError(res, err);
  }
});

// ─── POST /function-refine ──────────────────────────────────
aiAssistRouter.post('/function-refine', async (req, res) => {
  const { data_source_id, current_sql, instruction } = req.body as {
    data_source_id?: string; current_sql?: string; instruction?: string;
  };
  const userId = getUserId(req);
  if (!data_source_id || !current_sql || !instruction) {
    return res.status(400).json({ error: 'data_source_id, current_sql, instruction are required' });
  }

  try {
    const provider = await resolveProvider(PURPOSE);
    const ctx = await buildSchemaContext({ userId, groups: userGroups(req), dataSourceId: data_source_id });

    const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\n--- SCHEMA CONTEXT ---\n${ctx.text}\n--- END SCHEMA CONTEXT ---`;
    const userPrompt = `Refine the following PostgreSQL function based on the instruction below.
Return the FULL revised function (not a diff) inside a single \`\`\`sql fenced block.

CURRENT SQL:
\`\`\`sql
${current_sql}
\`\`\`

INSTRUCTION:
${instruction.trim()}`;

    const result = await callChat({ provider, systemPrompt, userPrompt });
    const sql = extractSql(result.text);
    rejectIfDestructive(sql);

    const usage_id = await logUsage({ userId, featureTag: FEATURE_TAG, promptText: `${systemPrompt}\n${userPrompt}`, result });
    await logAdminAction(authzPool, {
      userId,
      action: 'AI_ASSIST_FUNCTION_REFINE',
      resourceType: 'ai_provider',
      resourceId: result.provider_id,
      details: {
        data_source_id,
        instruction_chars: instruction.length,
        before_chars: current_sql.length,
        after_chars: sql.length,
      },
      ip: getClientIp(req),
      actorType: 'ai_agent',
      agentId: result.provider_id,
      modelId: result.model_id,
      consentGiven: 'human_explicit',
    });

    res.json({
      sql,
      diff_summary: null,
      provider_id: result.provider_id,
      model_id: result.model_id,
      usage_id,
      usage: {
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        cost_usd: result.cost_usd,
        latency_ms: result.latency_ms,
      },
    });
  } catch (err) {
    handleAIError(res, err);
  }
});

// ─── POST /function-explain ─────────────────────────────────
aiAssistRouter.post('/function-explain', async (req, res) => {
  const { sql } = req.body as { sql?: string };
  const userId = getUserId(req);
  if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
    return res.status(400).json({ error: 'sql is required' });
  }

  try {
    const provider = await resolveProvider(PURPOSE);
    const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\nFor explain mode you may write Markdown prose. Cover: purpose, parameters, output columns, side effects, suggested test query.`;
    const userPrompt = `Explain this PostgreSQL function in concise Markdown. Use headings: Purpose, Parameters, Returns, Notes, Test Query.\n\n\`\`\`sql\n${sql}\n\`\`\``;

    const result = await callChat({ provider, systemPrompt, userPrompt });

    const usage_id = await logUsage({ userId, featureTag: FEATURE_TAG, promptText: `${systemPrompt}\n${userPrompt}`, result });
    await logAdminAction(authzPool, {
      userId,
      action: 'AI_ASSIST_FUNCTION_EXPLAIN',
      resourceType: 'ai_provider',
      resourceId: result.provider_id,
      details: { sql_chars: sql.length },
      ip: getClientIp(req),
      actorType: 'ai_agent',
      agentId: result.provider_id,
      modelId: result.model_id,
      consentGiven: 'human_explicit',
    });

    res.json({
      markdown: result.text,
      provider_id: result.provider_id,
      model_id: result.model_id,
      usage_id,
      usage: {
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        cost_usd: result.cost_usd,
        latency_ms: result.latency_ms,
      },
    });
  } catch (err) {
    handleAIError(res, err);
  }
});

// ─── POST /eval-mark ────────────────────────────────────────
// §9.9 explicit-consent capture: user clicks 👍/👎 on an AI output, frontend
// posts the (usage_id, full prompt + response, verdict) here. We refuse if
// the usage row doesn't exist or doesn't belong to this caller — the user
// can only mark their own AI calls.
aiAssistRouter.post('/eval-mark', async (req, res) => {
  const { ai_usage_id, prompt_text, response_text, verdict, notes } = req.body as {
    ai_usage_id?: number;
    prompt_text?: string;
    response_text?: string;
    verdict?: 'good' | 'bad';
    notes?: string;
  };
  const userId = getUserId(req);
  if (!ai_usage_id || !prompt_text || !response_text || (verdict !== 'good' && verdict !== 'bad')) {
    return res.status(400).json({ error: 'ai_usage_id, prompt_text, response_text, verdict ("good"|"bad") are required' });
  }

  try {
    const usageRow = await authzPool.query<{
      provider_id: string; model_id: string; feature_tag: string; called_by: string;
    }>(
      `SELECT provider_id, model_id, feature_tag, called_by
         FROM authz_ai_usage
        WHERE usage_id = $1`,
      [ai_usage_id],
    );
    if (usageRow.rows.length === 0) {
      return res.status(404).json({ error: 'ai_usage_id not found' });
    }
    if (usageRow.rows[0].called_by !== userId) {
      return res.status(403).json({ error: 'You can only mark eval cases for your own AI calls.' });
    }
    const { provider_id, model_id, feature_tag } = usageRow.rows[0];

    const ins = await authzPool.query<{ case_id: string }>(
      `INSERT INTO authz_eval_case (
         ai_usage_id, feature_tag, provider_id, model_id, data_source_id,
         prompt_text, response_text, verdict, notes, marked_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING case_id`,
      [
        ai_usage_id,
        feature_tag,
        provider_id,
        model_id,
        null,                         // data_source_id is in the prompt; not a separate column in usage row
        prompt_text,
        response_text,
        verdict,
        notes ?? null,
        userId,
      ],
    );
    const case_id = Number(ins.rows[0].case_id);

    await logAdminAction(authzPool, {
      userId,
      action: 'AI_ASSIST_EVAL_MARK',
      resourceType: 'ai_provider',
      resourceId: provider_id,
      details: { case_id, ai_usage_id, feature_tag, verdict, prompt_chars: prompt_text.length, response_chars: response_text.length },
      ip: getClientIp(req),
      actorType: 'human',
      consentGiven: 'human_explicit',
    });

    res.json({ case_id, verdict });
  } catch (err) {
    handleAIError(res, err);
  }
});
