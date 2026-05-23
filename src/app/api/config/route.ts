/**
 * GET /api/config  — returns the active config + API-key presence booleans.
 * PATCH /api/config — partial-update llm/ui/features sections.
 *
 * Per spec §5.5: API key values never appear in any GET response.
 */
import { NextResponse } from 'next/server';
import { readConfig, patchConfig } from '@/lib/storage/config';
import { hasKey } from '@/lib/config';
import { withCsrf, withRequestLog, readJsonBody, isNextResponse } from '@/lib/http/guards';
import { badRequest, internalError } from '@/lib/http/errors';
import type { ConfigPatch, ConfigResponse } from '@/lib/api-types';

export const GET = withRequestLog<unknown>(async () => {
  const cfg = await readConfig();
  return NextResponse.json<ConfigResponse>({
    schemaVersion: 1,
    llm: cfg.llm,
    ui: cfg.ui,
    features: cfg.features,
    apiKeys: {
      hasAnthropicKey: hasKey('anthropic'),
      hasOpenAIKey: hasKey('openai')
    }
  });
});

export const PATCH = withCsrf<unknown>(async (req) => {
  const body = await readJsonBody<ConfigPatch>(req);
  if (isNextResponse(body)) return body;
  if (typeof body !== 'object' || body === null) {
    return badRequest('INVALID_BODY', 'Body must be an object.');
  }
  try {
    const next = await patchConfig(body);
    return NextResponse.json<ConfigResponse>({
      schemaVersion: 1,
      llm: next.llm,
      ui: next.ui,
      features: next.features,
      apiKeys: {
        hasAnthropicKey: hasKey('anthropic'),
        hasOpenAIKey: hasKey('openai')
      }
    });
  } catch (err) {
    return internalError('CONFIG_WRITE_FAILED', (err as Error).message);
  }
});
