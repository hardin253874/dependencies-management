import { describe, it, expect, afterEach } from 'vitest';
import { GET } from '@/app/api/config/route';
import { POST as POST_API_KEY } from '@/app/api/config/api-key/route';
import { POST as POST_API_KEY_TEST } from '@/app/api/config/api-key/test/route';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { setApiKey, resetEnvCache } from '@/lib/config';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  // Clear keys we set during the test.
  setApiKey('anthropic', null);
  resetEnvCache();
});

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: getCsrfToken() },
    body: JSON.stringify(body)
  });
}

describe('invariant: API key values never appear in GET responses (spec §5.5 / §16.3)', () => {
  it('GET /api/config returns presence booleans only, never the value', async () => {
    sandbox = await createSandbox('api-key-leak');
    const sensitiveAnthropic = 'sk-ant-supersecret-DO-NOT-LEAK-ME-1234567890abc';
    setApiKey('anthropic', sensitiveAnthropic);

    const response = await GET(new Request('http://127.0.0.1:3000/api/config'), undefined);
    const json = (await response.json()) as Record<string, unknown>;
    const body = JSON.stringify(json);

    expect(body).not.toContain(sensitiveAnthropic);
    expect(body).not.toContain('supersecret');
    expect((json.apiKeys as { hasAnthropicKey: boolean }).hasAnthropicKey).toBe(true);
  });

  it('presence booleans correctly report missing keys', async () => {
    sandbox = await createSandbox('api-key-missing');
    setApiKey('anthropic', null);
    const response = await GET(new Request('http://127.0.0.1:3000/api/config'), undefined);
    const json = (await response.json()) as { apiKeys: Record<string, boolean> };
    expect(json.apiKeys.hasAnthropicKey).toBe(false);
    // v2 removed OpenAI: no OpenAI presence flag in the response.
    expect(json.apiKeys).not.toHaveProperty('hasOpenAIKey');
  });
});

describe('v2: OpenAI provider is rejected by the API-key routes', () => {
  it('POST /api/config/api-key with provider "openai" → 400 INVALID_BODY', async () => {
    sandbox = await createSandbox('api-key-openai-rejected');
    const res = await POST_API_KEY(
      postJson('http://127.0.0.1:3000/api/config/api-key', {
        provider: 'openai',
        apiKey: 'sk-something-long-enough-1234567890'
      }),
      undefined
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } } | { code: string };
    expect(JSON.stringify(json)).toContain('INVALID_BODY');
  });

  it('POST /api/config/api-key/test with provider "openai" → 400 INVALID_BODY', async () => {
    sandbox = await createSandbox('api-key-test-openai-rejected');
    const res = await POST_API_KEY_TEST(
      postJson('http://127.0.0.1:3000/api/config/api-key/test', {
        provider: 'openai',
        apiKey: 'sk-something-long-enough-1234567890'
      }),
      undefined
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('INVALID_BODY');
  });
});

describe('v2 Stage 5b: the TypeSafe key never appears in GET responses', () => {
  it('GET /api/config reports hasTypesafeKey only', async () => {
    sandbox = await createSandbox('typesafe-key-leak');
    const secret = 'tsk-supersecret-DO-NOT-LEAK-0123456789abcdef';
    process.env.TYPESAFE_API_KEY = secret;
    resetEnvCache();
    try {
      const response = await GET(new Request('http://127.0.0.1:3000/api/config'), undefined);
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(body).not.toContain('supersecret');
      expect((JSON.parse(body) as { apiKeys: { hasTypesafeKey: boolean } }).apiKeys.hasTypesafeKey).toBe(true);
    } finally {
      delete process.env.TYPESAFE_API_KEY;
      resetEnvCache();
    }
  });
});
