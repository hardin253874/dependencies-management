/**
 * Reads and writes `library/_config.json`. Per spec §5.4 this is re-read on
 * every request that needs it (no in-process caching beyond a single call).
 */
import { atomicWriteJson, readJson, pathExists } from './atomic';
import { configFilePath } from '../paths';
import { MODEL_OPTIONS, defaultModel } from '../llm/models';
import type { ConfigNotice, LegacyLlmProvider, LlmProvider } from '../api-types';

export type { LlmProvider };
export type ThemeChoice = 'light' | 'dark' | 'system';

/** What an on-disk `_config.json` may still say (v1 allowed OpenAI). Not exported to the FE. */
type StoredLlmProvider = LlmProvider | LegacyLlmProvider;

export interface AppConfig {
  schemaVersion: 1;
  llm: {
    provider: LlmProvider;
    model: string;
  };
  ui: {
    sidebarCollapsed: boolean;
    theme: ThemeChoice;
    showDeepAnalyzeWarning: boolean;
  };
  features: {
    resolverCheckEnabled: boolean;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-5-5' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true }
};

export interface MigratedConfig {
  config: AppConfig;
  notices: ConfigNotice[];
}

/**
 * Pure: bring a config written by an older build up to the current shape.
 * - provider other than `anthropic` (v1 `openai`) → anthropic + default model.
 * - a model id no longer in the picker (`MODEL_OPTIONS`) → default model.
 *
 * Never throws on a legacy provider; it throws only on an unsupported
 * schemaVersion (same as before).
 */
export function migrateConfig(raw: unknown): MigratedConfig {
  const stored = raw as Omit<AppConfig, 'llm'> & { llm: { provider: StoredLlmProvider; model: string } };
  if (stored.schemaVersion !== 1) {
    throw new Error(`Unsupported _config.json schemaVersion: ${String(stored.schemaVersion)}`);
  }
  const notices: ConfigNotice[] = [];
  let llm: AppConfig['llm'];
  if (stored.llm.provider !== 'anthropic') {
    const model = defaultModel('anthropic');
    llm = { provider: 'anthropic', model };
    notices.push({
      code: 'PROVIDER_MIGRATED',
      message: `OpenAI support was removed in v2; switched to Anthropic ${model}.`
    });
  } else if (!MODEL_OPTIONS.anthropic.includes(stored.llm.model)) {
    const model = defaultModel('anthropic');
    llm = { provider: 'anthropic', model };
    notices.push({
      code: 'MODEL_MIGRATED',
      message: `Model ${stored.llm.model} is no longer offered; switched to ${model}.`
    });
  } else {
    llm = { provider: stored.llm.provider, model: stored.llm.model };
  }
  return { config: { ...stored, llm }, notices };
}

/**
 * Read `_config.json`, migrated in memory. Never writes, so any route may call
 * it. The one-time persist + notices go through `readConfigWithNotices`.
 */
export async function readConfig(): Promise<AppConfig> {
  return (await readConfigWithNotices({ persist: false })).config;
}

/**
 * Read `_config.json`; when a migration happened and `persist` is true, write
 * the migrated config back once (to `library/`, never a target project) and
 * return the notices. Only `GET /api/config` persists, so the notice reaches
 * the UI exactly once: the next read finds nothing left to migrate.
 */
export async function readConfigWithNotices(
  opts: { persist: boolean } = { persist: true }
): Promise<MigratedConfig> {
  const fp = configFilePath();
  if (!(await pathExists(fp))) {
    return { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig, notices: [] };
  }
  const migrated = migrateConfig(await readJson<unknown>(fp));
  if (migrated.notices.length > 0 && opts.persist) {
    await writeConfig(migrated.config);
  }
  return migrated;
}

export async function writeConfig(cfg: AppConfig): Promise<void> {
  await atomicWriteJson(configFilePath(), cfg);
}

/**
 * Deep-merge patch into config. Only known top-level sections are accepted;
 * unknown fields are silently dropped to prevent UI typos from corrupting state.
 */
export async function patchConfig(patch: PatchInput): Promise<AppConfig> {
  const cur = await readConfig();
  const next: AppConfig = {
    schemaVersion: 1,
    llm: {
      provider: patch.llm?.provider ?? cur.llm.provider,
      model: patch.llm?.model ?? cur.llm.model
    },
    ui: {
      sidebarCollapsed: patch.ui?.sidebarCollapsed ?? cur.ui.sidebarCollapsed,
      theme: patch.ui?.theme ?? cur.ui.theme,
      showDeepAnalyzeWarning: patch.ui?.showDeepAnalyzeWarning ?? cur.ui.showDeepAnalyzeWarning
    },
    features: {
      resolverCheckEnabled: patch.features?.resolverCheckEnabled ?? cur.features.resolverCheckEnabled
    }
  };
  await writeConfig(next);
  return next;
}

export interface PatchInput {
  llm?: Partial<AppConfig['llm']>;
  ui?: Partial<AppConfig['ui']>;
  features?: Partial<AppConfig['features']>;
}
