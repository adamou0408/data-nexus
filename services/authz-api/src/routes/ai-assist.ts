// ============================================================
// AI-Assisted PG Function Authoring (dogfood phase)
//
// Three endpoints surface inside DataQueryTab → AuthorPanel:
//   POST /function-draft   — natural language → CREATE FUNCTION SQL
//   POST /function-refine  — current SQL + instruction → revised SQL
//   POST /function-explain — SQL → markdown explanation
//
// Constitution refs:
//   §11.2 — schema context is filtered through authz_check before the prompt.
//   §11.3 — AI never deploys; output lands in the textarea, Adam clicks Deploy.
//           Destructive keyword guard rejects DROP / TRUNCATE / GRANT / etc.
//   §11.6 — only SHA-256 hashes hit authz_ai_usage (raw prompt forbidden).
//   §11.7 — every call writes authz_admin_audit_log with actor_type='ai_assist',
//           consent_given='human_explicit' (user clicked the button).
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

    await logUsage({ userId, featureTag: FEATURE_TAG, promptText: `${systemPrompt}\n${userPrompt}`, result });
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

    await logUsage({ userId, featureTag: FEATURE_TAG, promptText: `${systemPrompt}\n${userPrompt}`, result });
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

    await logUsage({ userId, featureTag: FEATURE_TAG, promptText: `${systemPrompt}\n${userPrompt}`, result });
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
