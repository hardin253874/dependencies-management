import { describe, it, expect, afterEach } from 'vitest';
import { reconcileEnv } from '@/lib/boot';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { writeConfig, DEFAULT_CONFIG } from '@/lib/storage/config';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('.env / .env.example reconciliation on boot (spec §5.2)', () => {
  it('returns a reconciliation result shaped { missingRequired, missingOptional }', async () => {
    sandbox = await createSandbox('boot-recon');
    await writeConfig({ ...DEFAULT_CONFIG, llm: { provider: 'anthropic', model: 'claude-opus-4-7' } });
    const result = await reconcileEnv();
    expect(Array.isArray(result.missingRequired)).toBe(true);
    expect(Array.isArray(result.missingOptional)).toBe(true);
  });
});
