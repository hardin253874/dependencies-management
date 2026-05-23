/**
 * POST /api/config/api-key/test — validate the provider key (spec §9.3).
 *
 * Spec §9.3: "fixed 10/10 token budget, 10s timeout, bypasses concurrency cap".
 * Stage 1 ships a structural validator only (length + provider-specific prefix
 * sanity). The real round-trip test against the live LLM lands in Stage 3 when
 * LLMClient is implemented. The endpoint shape (request + response) is final.
 */
import { NextResponse } from 'next/server';
import { withCsrf, readJsonBody, isNextResponse } from '@/lib/http/guards';
import { badRequest } from '@/lib/http/errors';
import type { ApiKeySetRequest, ApiKeyTestResponse } from '@/lib/api-types';

const TIMEOUT_MS = 10_000;
const MIN_KEY_LENGTH = 20;

export const POST = withCsrf<unknown>(async (req) => {
  const body = await readJsonBody<ApiKeySetRequest>(req);
  if (isNextResponse(body)) return body;

  if (
    typeof body !== 'object' ||
    body === null ||
    (body.provider !== 'anthropic' && body.provider !== 'openai') ||
    typeof body.apiKey !== 'string'
  ) {
    return badRequest('INVALID_BODY', 'Body must be { provider, apiKey }.');
  }

  const result = await Promise.race<ApiKeyTestResponse>([
    validateKeyFormat(body),
    new Promise<ApiKeyTestResponse>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            message: `Validation timed out after ${TIMEOUT_MS / 1000}s.`
          }),
        TIMEOUT_MS
      )
    )
  ]);

  return NextResponse.json<ApiKeyTestResponse>(result);
});

async function validateKeyFormat(body: ApiKeySetRequest): Promise<ApiKeyTestResponse> {
  const key = body.apiKey.trim();
  if (key.length < MIN_KEY_LENGTH) {
    return { ok: false, message: `Key looks too short (${key.length} chars).` };
  }
  if (body.provider === 'anthropic' && !key.startsWith('sk-ant-')) {
    return { ok: false, message: 'Anthropic keys should start with `sk-ant-`.' };
  }
  if (body.provider === 'openai' && !key.startsWith('sk-')) {
    return { ok: false, message: 'OpenAI keys should start with `sk-`.' };
  }
  return {
    ok: true,
    message:
      'Key format looks valid. Live provider test will run after the LLM client lands in Stage 3.'
  };
}
