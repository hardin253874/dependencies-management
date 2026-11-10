/**
 * GET /api/config  — returns the active config + API-key presence booleans.
 * PATCH /api/config — partial-update llm/ui/features sections.
 *
 * Per spec §5.5: API key values never appear in any GET response.
 *
 * GET and PATCH both persist a pending `_config.json` migration (v2: OpenAI
 * removed) and return its one-time `notices`; see `readConfigWithNotices`.
 */
import { NextResponse } from 'next/server';
import { readConfigWithNotices, patchConfig } from '@/lib/storage/config';
import { hasKey } from '@/lib/config';
import { MODEL_OPTIONS } from '@/lib/llm/models';
import { withCsrf, withRequestLog, readJsonBody, isNextResponse } from '@/lib/http/guards';
import { badRequest, internalError } from '@/lib/http/errors';
import type { ConfigPatch, ConfigResponse } from '@/lib/api-types';

export const GET = withRequestLog<unknown>(async () => {
  const { config: cfg, notices } = await readConfigWithNotices();
  return NextResponse.json<ConfigResponse>({
    schemaVersion: 1,
    llm: cfg.llm,
    ui: cfg.ui,
    features: cfg.features,
    agentBudgets: cfg.agentBudgets,
    apiKeys: {
      hasAnthropicKey: hasKey('anthropic')
    },
    ...(notices.length > 0 ? { notices } : {})
  });
});

export const PATCH = withCsrf<unknown>(async (req) => {
  const body = await readJsonBody<ConfigPatch>(req);
  if (isNextResponse(body)) return body;
  if (typeof body !== 'object' || body === null) {
    return badRequest('INVALID_BODY', 'Body must be an object.');
  }
  if (body.llm?.provider !== undefined && body.llm.provider !== 'anthropic') {
    return badRequest('INVALID_BODY', 'llm.provider must be "anthropic".');
  }
  // Same list as the model picker: an id it no longer offers would be
  // migrated back on the next GET, silently reverting the user's choice.
  if (body.llm?.model !== undefined && !MODEL_OPTIONS.anthropic.includes(body.llm.model)) {
    return badRequest(
      'INVALID_BODY',
      `llm.model "${String(body.llm.model)}" is not offered; pick one of: ${MODEL_OPTIONS.anthropic.join(', ')}.`
    );
  }
  if (body.llm?.reportEngine !== undefined && body.llm.reportEngine !== 'agent' && body.llm.reportEngine !== 'v1') {
    return badRequest('INVALID_BODY', 'llm.reportEngine must be "agent" or "v1".');
  }
  try {
    const { config: next, notices } = await patchConfig(body);
    return NextResponse.json<ConfigResponse>({
      schemaVersion: 1,
      llm: next.llm,
      ui: next.ui,
      features: next.features,
      agentBudgets: next.agentBudgets,
      apiKeys: {
        hasAnthropicKey: hasKey('anthropic')
      },
      ...(notices.length > 0 ? { notices } : {})
    });
  } catch (err) {
    return internalError('CONFIG_WRITE_FAILED', (err as Error).message);
  }
});
