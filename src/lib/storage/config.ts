/**
 * Reads and writes `library/_config.json`. Per spec §5.4 this is re-read on
 * every request that needs it (no in-process caching beyond a single call).
 */
import { atomicWriteJson, readJson, pathExists } from './atomic';
import { configFilePath } from '../paths';
import { MODEL_OPTIONS, defaultModel } from '../llm/models';
import type { ConfigNotice, LegacyLlmProvider, LlmProvider, ReportEngine } from '../api-types';
import { DEFAULT_AGENT_BUDGETS, normalizeBudgetSettings, type AgentBudgetSettings, type AgentBudgetView } from '../../core/agent/budgets';

export type { LlmProvider };
export type ThemeChoice = 'light' | 'dark' | 'system';

/** What an on-disk `_config.json` may still say (v1 allowed OpenAI). Not exported to the FE. */
type StoredLlmProvider = LlmProvider | LegacyLlmProvider;

export interface AppConfig {
  schemaVersion: 1;
  llm: {
    provider: LlmProvider;
    model: string;
    /**
     * v2 Stage 4a.12: which service answers [D] / [D-Deep]. `agent` = the
     * bounded tool loop over the code graph, `v1` = the single-shot v1
     * services (kept reachable, like D21 kept the v1 scanner). Missing = agent
     * (read with `reportEngineOf`); optional so hand-written configs stay valid.
     */
    reportEngine?: ReportEngine;
  };
  ui: {
    sidebarCollapsed: boolean;
    theme: ThemeChoice;
    showDeepAnalyzeWarning: boolean;
  };
  features: {
    resolverCheckEnabled: boolean;
  };
  /** v2 Stage 4a: per-view agent run budgets (read-only in the Settings UI for now). */
  agentBudgets: Record<AgentBudgetView, AgentBudgetSettings>;
}

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-5-5', reportEngine: 'agent' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  agentBudgets: { updateReport: { ...DEFAULT_AGENT_BUDGETS.updateReport }, deepReport: { ...DEFAULT_AGENT_BUDGETS.deepReport } }
};

export function reportEngineOf(raw: unknown): ReportEngine {
  return raw === 'v1' ? 'v1' : 'agent';
}

/** Keeps a stored `reportEngine` (normalized); an absent one stays absent (= agent). */
function engineField(raw: unknown): { reportEngine?: ReportEngine } {
  return raw === undefined ? {} : { reportEngine: reportEngineOf(raw) };
}

/** Fills missing / invalid agent budget fields with the defaults (a config from before Stage 4 has none). */
function agentBudgetsOf(raw: unknown): AppConfig['agentBudgets'] {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    updateReport: normalizeBudgetSettings(o.updateReport, DEFAULT_AGENT_BUDGETS.updateReport),
    deepReport: normalizeBudgetSettings(o.deepReport, DEFAULT_AGENT_BUDGETS.deepReport)
  };
}

export interface MigratedConfig {
  config: AppConfig;
  notices: ConfigNotice[];
}

/**
 * Pure: bring a config written by an older build up to the current shape.
 * - provider other than `anthropic` (v1 `openai`) → anthropic + default model.
 * - a model id no longer in the picker (`MODEL_OPTIONS`) → default model.
 *
 * - no usable `llm` section (hand-edited / partial file) → default llm, with
 *   a notice, like the other llm fallbacks.
 *
 * Never throws on a legacy provider; it throws only on a file that is not a
 * JSON object or has an unsupported schemaVersion.
 */
export function migrateConfig(raw: unknown): MigratedConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('_config.json must be a JSON object.');
  }
  const stored = raw as Omit<AppConfig, 'llm' | 'agentBudgets'> & {
    llm?: { provider: StoredLlmProvider; model: string; reportEngine?: unknown };
    agentBudgets?: unknown;
  };
  if (stored.schemaVersion !== 1) {
    throw new Error(`Unsupported _config.json schemaVersion: ${String(stored.schemaVersion)}`);
  }
  const notices: ConfigNotice[] = [];
  let llm: AppConfig['llm'];
  const storedLlm = stored.llm;
  if (typeof storedLlm !== 'object' || storedLlm === null || typeof storedLlm.provider !== 'string') {
    const model = defaultModel('anthropic');
    llm = { provider: 'anthropic', model };
    notices.push({
      code: 'MODEL_MIGRATED',
      message: `_config.json had no LLM settings; using Anthropic ${model}.`
    });
  } else if (storedLlm.provider !== 'anthropic') {
    const model = defaultModel('anthropic');
    llm = { provider: 'anthropic', model, ...engineField(storedLlm.reportEngine) };
    notices.push({
      code: 'PROVIDER_MIGRATED',
      message: `OpenAI support was removed in v2; switched to Anthropic ${model}.`
    });
  } else if (!MODEL_OPTIONS.anthropic.includes(storedLlm.model)) {
    const model = defaultModel('anthropic');
    llm = { provider: 'anthropic', model, ...engineField(storedLlm.reportEngine) };
    notices.push({
      code: 'MODEL_MIGRATED',
      message: `Model ${storedLlm.model} is no longer offered; switched to ${model}.`
    });
  } else {
    llm = { provider: storedLlm.provider, model: storedLlm.model, ...engineField(storedLlm.reportEngine) };
  }
  // Stage 4a: the agent fields are filled silently (no notice); nothing the user chose changes.
  return { config: { ...stored, llm, agentBudgets: agentBudgetsOf(stored.agentBudgets) }, notices };
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
 * return the notices. `GET /api/config` persists here; `patchConfig` also
 * writes the migrated config and hands the notices back on the PATCH response
 * (so a PATCH before the first GET does not drop them). Either way the notice
 * reaches the UI exactly once: the next read finds nothing left to migrate.
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
 *
 * The write persists any pending `_config.json` migration, so the migration
 * notices are returned with the result for the caller to surface.
 */
export async function patchConfig(patch: PatchInput): Promise<MigratedConfig> {
  const { config: cur, notices } = await readConfigWithNotices({ persist: false });
  const next: AppConfig = {
    schemaVersion: 1,
    llm: {
      provider: patch.llm?.provider ?? cur.llm.provider,
      model: patch.llm?.model ?? cur.llm.model,
      reportEngine: patch.llm?.reportEngine ?? cur.llm.reportEngine
    },
    ui: {
      sidebarCollapsed: patch.ui?.sidebarCollapsed ?? cur.ui.sidebarCollapsed,
      theme: patch.ui?.theme ?? cur.ui.theme,
      showDeepAnalyzeWarning: patch.ui?.showDeepAnalyzeWarning ?? cur.ui.showDeepAnalyzeWarning
    },
    features: {
      resolverCheckEnabled: patch.features?.resolverCheckEnabled ?? cur.features.resolverCheckEnabled
    },
    // Read-only in 4a: PATCH cannot change budgets (editing them is backlog).
    agentBudgets: cur.agentBudgets
  };
  await writeConfig(next);
  return { config: next, notices };
}

export interface PatchInput {
  llm?: Partial<AppConfig['llm']>;
  ui?: Partial<AppConfig['ui']>;
  features?: Partial<AppConfig['features']>;
}
