/**
 * Reads and writes `library/_config.json`. Per spec §5.4 this is re-read on
 * every request that needs it (no in-process caching beyond a single call).
 */
import { atomicWriteJson, readJson, pathExists } from './atomic';
import { configFilePath } from '../paths';

export type LlmProvider = 'anthropic' | 'openai';
export type ThemeChoice = 'light' | 'dark' | 'system';

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
  llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true }
};

export async function readConfig(): Promise<AppConfig> {
  const fp = configFilePath();
  if (!(await pathExists(fp))) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
  }
  const raw = await readJson<AppConfig>(fp);
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported _config.json schemaVersion: ${raw.schemaVersion}`);
  }
  return raw;
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
