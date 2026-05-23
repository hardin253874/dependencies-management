/**
 * POST /api/config/api-key — write a provider key to `.env` (spec §9.3, §5.4).
 *
 * Body: { provider: 'anthropic' | 'openai', apiKey: string }
 * Response: { ok: true }
 *
 * The server writes the key to `.env` (chmod 600 on Unix), mutates the in-process
 * config module, and signals the LLMClient singleton to re-instantiate (deferred
 * until Stage 3 when the LLMClient lands).
 */
import { NextResponse } from 'next/server';
import { withCsrf, readJsonBody, isNextResponse } from '@/lib/http/guards';
import { badRequest, internalError } from '@/lib/http/errors';
import { writeEnvFile } from '@/lib/storage/envFile';
import { setApiKey } from '@/lib/config';
import type { ApiKeySetRequest, LlmProvider } from '@/lib/api-types';

function envKeyFor(provider: LlmProvider): 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' {
  return provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

export const POST = withCsrf<unknown>(async (req) => {
  const body = await readJsonBody<ApiKeySetRequest>(req);
  if (isNextResponse(body)) return body;

  if (
    typeof body !== 'object' ||
    body === null ||
    (body.provider !== 'anthropic' && body.provider !== 'openai') ||
    typeof body.apiKey !== 'string' ||
    body.apiKey.trim() === ''
  ) {
    return badRequest('INVALID_BODY', 'Body must be { provider, apiKey } with a non-empty key.');
  }

  try {
    await writeEnvFile({ [envKeyFor(body.provider)]: body.apiKey.trim() });
    setApiKey(body.provider, body.apiKey.trim());
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalError('ENV_WRITE_FAILED', (err as Error).message);
  }
});
