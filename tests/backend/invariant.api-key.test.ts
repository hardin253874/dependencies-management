import { describe, it, expect, afterEach } from 'vitest';
import { GET } from '@/app/api/config/route';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { setApiKey, resetEnvCache } from '@/lib/config';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  // Clear keys we set during the test.
  setApiKey('anthropic', null);
  setApiKey('openai', null);
  resetEnvCache();
});

describe('invariant: API key values never appear in GET responses (spec §5.5 / §16.3)', () => {
  it('GET /api/config returns presence booleans only, never the value', async () => {
    sandbox = await createSandbox('api-key-leak');
    const sensitiveAnthropic = 'sk-ant-supersecret-DO-NOT-LEAK-ME-1234567890abc';
    const sensitiveOpenai = 'sk-supersecret-OPENAI-NEVER-LEAK-9876543210abc';
    setApiKey('anthropic', sensitiveAnthropic);
    setApiKey('openai', sensitiveOpenai);

    const response = await GET(new Request('http://127.0.0.1:3000/api/config'), undefined);
    const json = (await response.json()) as Record<string, unknown>;
    const body = JSON.stringify(json);

    expect(body).not.toContain(sensitiveAnthropic);
    expect(body).not.toContain(sensitiveOpenai);
    expect(body).not.toContain('supersecret');
    expect((json.apiKeys as { hasAnthropicKey: boolean }).hasAnthropicKey).toBe(true);
    expect((json.apiKeys as { hasOpenAIKey: boolean }).hasOpenAIKey).toBe(true);
  });

  it('presence booleans correctly report missing keys', async () => {
    sandbox = await createSandbox('api-key-missing');
    setApiKey('anthropic', null);
    setApiKey('openai', null);
    const response = await GET(new Request('http://127.0.0.1:3000/api/config'), undefined);
    const json = (await response.json()) as { apiKeys: { hasAnthropicKey: boolean; hasOpenAIKey: boolean } };
    expect(json.apiKeys.hasAnthropicKey).toBe(false);
    expect(json.apiKeys.hasOpenAIKey).toBe(false);
  });
});
