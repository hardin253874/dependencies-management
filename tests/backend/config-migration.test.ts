/**
 * v2 Stage 1.2.c — `_config.json` migration (OpenAI removed).
 *
 * A v1 config may still say `llm.provider: 'openai'`. It migrates to Anthropic
 * + the default model, persists once (GET /api/config only), and yields a
 * one-time notice.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { configFilePath } from '@/lib/paths';
import {
  DEFAULT_CONFIG,
  migrateConfig,
  readConfig,
  readConfigWithNotices
} from '@/lib/storage/config';
import { DEFAULT_AGENT_MODEL, defaultModel } from '@/lib/llm/models';
import { GET, PATCH } from '@/app/api/config/route';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import type { ConfigResponse } from '@/lib/api-types';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

function legacyOpenAiConfig(): Record<string, unknown> {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    llm: { provider: 'openai', model: 'gpt-4o' }
  };
}

async function writeRawConfig(value: unknown): Promise<void> {
  await fs.writeFile(configFilePath(), JSON.stringify(value, null, 2), 'utf8');
}

async function readRawConfig(): Promise<{ llm: { provider: string; model: string } }> {
  return JSON.parse(await fs.readFile(configFilePath(), 'utf8')) as {
    llm: { provider: string; model: string };
  };
}

describe('migrateConfig (pure)', () => {
  it("provider 'openai' → anthropic + default model + one PROVIDER_MIGRATED notice", () => {
    const { config, notices } = migrateConfig(legacyOpenAiConfig());
    expect(config.llm).toEqual({ provider: 'anthropic', model: defaultModel('anthropic'), agentModel: DEFAULT_AGENT_MODEL });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe('PROVIDER_MIGRATED');
    expect(notices[0]!.message).toContain(defaultModel('anthropic'));
    // Other sections are carried over untouched.
    expect(config.ui).toEqual(DEFAULT_CONFIG.ui);
    expect(config.features).toEqual(DEFAULT_CONFIG.features);
  });

  it('an anthropic config passes through with no notice', () => {
    const { config, notices } = migrateConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(notices).toEqual([]);
  });

  it('a stored model id no longer in the picker → default model + MODEL_MIGRATED notice', () => {
    const raw = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), llm: { provider: 'anthropic', model: 'claude-opus-4-7' } };
    const { config, notices } = migrateConfig(raw);
    expect(config.llm.model).toBe(defaultModel());
    expect(notices.map((n) => n.code)).toEqual(['MODEL_MIGRATED']);
    expect(notices[0]!.message).toContain('claude-opus-4-7');
  });

  it('still rejects an unsupported schemaVersion', () => {
    expect(() => migrateConfig({ ...DEFAULT_CONFIG, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it('a config with no llm section → default llm + MODEL_MIGRATED notice, other sections kept', () => {
    const raw = { schemaVersion: 1, ui: { ...DEFAULT_CONFIG.ui, theme: 'dark' }, features: DEFAULT_CONFIG.features };
    const { config, notices } = migrateConfig(raw);
    expect(config.llm).toEqual({ provider: 'anthropic', model: defaultModel('anthropic'), agentModel: DEFAULT_AGENT_MODEL });
    expect(config.ui.theme).toBe('dark');
    expect(notices.map((n) => n.code)).toEqual(['MODEL_MIGRATED']);
    expect(notices[0]!.message).toContain(defaultModel('anthropic'));
  });

  it('an llm section that is not an object is treated as missing', () => {
    const raw = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), llm: 'claude' };
    const { config, notices } = migrateConfig(raw);
    expect(config.llm).toEqual({ provider: 'anthropic', model: defaultModel('anthropic'), agentModel: DEFAULT_AGENT_MODEL });
    expect(notices.map((n) => n.code)).toEqual(['MODEL_MIGRATED']);
  });

  it('a non-object _config.json throws a descriptive error, not a TypeError', () => {
    expect(() => migrateConfig(null)).toThrow(/_config\.json must be a JSON object/);
    expect(() => migrateConfig([1])).toThrow(/_config\.json must be a JSON object/);
  });
});

describe('readConfigWithNotices / readConfig (sandboxed library)', () => {
  it('first read migrates + persists once; second read has no notice', async () => {
    sandbox = await createSandbox('config-migration-once');
    await writeRawConfig(legacyOpenAiConfig());

    const first = await readConfigWithNotices();
    expect(first.config.llm.provider).toBe('anthropic');
    expect(first.notices.map((n) => n.code)).toEqual(['PROVIDER_MIGRATED']);
    expect((await readRawConfig()).llm.provider).toBe('anthropic');

    const second = await readConfigWithNotices();
    expect(second.notices).toEqual([]);
    expect(second.config.llm).toEqual(first.config.llm);
  });

  it('readConfig migrates in memory only and never writes', async () => {
    sandbox = await createSandbox('config-migration-readonly');
    await writeRawConfig(legacyOpenAiConfig());
    const cfg = await readConfig();
    expect(cfg.llm.provider).toBe('anthropic');
    expect((await readRawConfig()).llm.provider).toBe('openai');
  });

  it('an already-anthropic config is not rewritten (mtime unchanged)', async () => {
    sandbox = await createSandbox('config-migration-nowrite');
    await writeRawConfig(DEFAULT_CONFIG);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(configFilePath(), past, past);
    const before = (await fs.stat(configFilePath())).mtimeMs;

    const { notices } = await readConfigWithNotices();
    expect(notices).toEqual([]);
    expect((await fs.stat(configFilePath())).mtimeMs).toBe(before);
  });
});

describe('GET/PATCH /api/config — migration notices + provider validation', () => {
  it('GET returns notices once, then omits them', async () => {
    sandbox = await createSandbox('config-route-notices');
    await writeRawConfig(legacyOpenAiConfig());

    const r1 = (await (await GET(new Request('http://127.0.0.1:3000/api/config'), undefined)).json()) as ConfigResponse;
    expect(r1.llm.provider).toBe('anthropic');
    expect(r1.notices?.map((n) => n.code)).toEqual(['PROVIDER_MIGRATED']);

    const r2 = (await (await GET(new Request('http://127.0.0.1:3000/api/config'), undefined)).json()) as ConfigResponse;
    expect(r2.notices).toBeUndefined();
  });

  it("PATCH with llm.provider 'openai' → 400 INVALID_BODY", async () => {
    sandbox = await createSandbox('config-route-patch-openai');
    const res = await PATCH(
      new Request('http://127.0.0.1:3000/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: getCsrfToken() },
        body: JSON.stringify({ llm: { provider: 'openai', model: 'gpt-4o' } })
      }),
      undefined
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('INVALID_BODY');
  });

  function patchRequest(body: unknown): Request {
    return new Request('http://127.0.0.1:3000/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: getCsrfToken() },
      body: JSON.stringify(body)
    });
  }

  it('PATCH with an llm.model not offered in the picker → 400 INVALID_BODY naming the model; nothing written', async () => {
    sandbox = await createSandbox('config-route-patch-model');
    await writeRawConfig(DEFAULT_CONFIG);
    const res = await PATCH(patchRequest({ llm: { model: 'claude-opus-4-7' } }), undefined);
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('INVALID_BODY');
    expect(text).toContain('claude-opus-4-7');
    expect((await readRawConfig()).llm.model).toBe(DEFAULT_CONFIG.llm.model);
  });

  it('PATCH with a picker model is accepted', async () => {
    sandbox = await createSandbox('config-route-patch-model-ok');
    await writeRawConfig(DEFAULT_CONFIG);
    const res = await PATCH(patchRequest({ llm: { provider: 'anthropic', model: defaultModel('anthropic') } }), undefined);
    expect(res.status).toBe(200);
  });

  it('a PATCH before the first GET returns the migration notice instead of dropping it', async () => {
    sandbox = await createSandbox('config-route-patch-first');
    await writeRawConfig(legacyOpenAiConfig());

    const res = await PATCH(patchRequest({ ui: { theme: 'dark' } }), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    expect(body.llm.provider).toBe('anthropic');
    expect(body.ui.theme).toBe('dark');
    expect(body.notices?.map((n) => n.code)).toEqual(['PROVIDER_MIGRATED']);

    // The migrated config is persisted, so the next GET has nothing left to say.
    expect((await readRawConfig()).llm.provider).toBe('anthropic');
    const r2 = (await (await GET(new Request('http://127.0.0.1:3000/api/config'), undefined)).json()) as ConfigResponse;
    expect(r2.notices).toBeUndefined();
  });

  it('a PATCH on an already-current config has no notices', async () => {
    sandbox = await createSandbox('config-route-patch-current');
    await writeRawConfig(DEFAULT_CONFIG);
    const body = (await (await PATCH(patchRequest({ ui: { theme: 'dark' } }), undefined)).json()) as ConfigResponse;
    expect(body.notices).toBeUndefined();
  });
});
