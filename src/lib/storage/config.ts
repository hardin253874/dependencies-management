/**
 * Reads and writes `library/_config.json`. Per spec §5.4 this is re-read on
 * every request that needs it (no in-process caching beyond a single call).
 */
import { atomicWriteJson, readJson, pathExists } from './atomic';
import { configFilePath } from '../paths';
import { DEFAULT_AGENT_MODEL, MODEL_OPTIONS, defaultModel } from '../llm/models';
import type { ConfigNotice, LegacyLlmProvider, LlmProvider, ReportEngine } from '../api-types';
import { DEFAULT_AGENT_BUDGETS, normalizeBudgetSettings, type AgentBudgetSettings, type AgentBudgetView } from '../../core/agent/budgets';
import { DEFAULT_JUDGE_SWITCHES, J_FLAGS, normalizeJudgeSwitches, type JudgeSwitches } from '../../core/judge/types';

export type { LlmProvider };
export type ThemeChoice = 'light' | 'dark' | 'system';

/** What an on-disk `_config.json` may still say (v1 allowed OpenAI). Not exported to the FE. */
type StoredLlmProvider = LlmProvider | LegacyLlmProvider;

export interface AppConfig {
  schemaVersion: 1;
  llm: {
    provider: LlmProvider;
    /** Every AI view except the agent engine's [D] / [D-Deep] (file review, CVE impact, related upgrade, v1 report engine). */
    model: string;
    /**
     * D32: the model the agent engine (`reportEngine: 'agent'`) runs [D] and
     * [D-Deep] on. Default Sonnet 5.5 (`DEFAULT_AGENT_MODEL`); filled silently
     * by `migrateConfig` for older configs. The router (D28), when on, still
     * overrides it per run.
     */
    agentModel: string;
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
  /**
   * v2 Stage 5b: Jev (TypeSafe) switches. `enabled: false` = no Jev call
   * anywhere; `router` = the D28 model router (rules, then Jev for unclear
   * cases); `flags.J1…J8` = each judgment. All default off; filled silently
   * by `migrateConfig` for older configs.
   */
  judge: JudgeSwitches;
  /**
   * Ids of the one-time config migrations already applied (D32 onwards), so a
   * migration that flips a user-visible default runs once and never again
   * after the user changes the value back. Unknown ids are kept.
   */
  migrations: string[];
}

/**
 * D32: turn Jev + J1 on once. 5b persisted all-false judge blocks, which the
 * new "missing = default" rule alone would keep off.
 */
export const CONFIG_MIGRATION_D32 = 'd32-judge-j1-default';

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-5-5', reportEngine: 'agent', agentModel: DEFAULT_AGENT_MODEL },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  agentBudgets: { updateReport: { ...DEFAULT_AGENT_BUDGETS.updateReport }, deepReport: { ...DEFAULT_AGENT_BUDGETS.deepReport } },
  judge: { enabled: DEFAULT_JUDGE_SWITCHES.enabled, router: DEFAULT_JUDGE_SWITCHES.router, flags: { ...DEFAULT_JUDGE_SWITCHES.flags } },
  // A fresh config already has the D32 defaults.
  migrations: [CONFIG_MIGRATION_D32]
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

/** Only strings survive; order kept, duplicates dropped. */
function migrationsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string'))];
}

/** D32 once: Jev + J1 on (router and J2–J8 untouched), then recorded. */
function applyJudgeMigrations(judge: JudgeSwitches, applied: string[]): { judge: JudgeSwitches; migrations: string[] } {
  if (applied.includes(CONFIG_MIGRATION_D32)) return { judge, migrations: applied };
  return { judge: { ...judge, enabled: true, flags: { ...judge.flags, J1: true } }, migrations: [...applied, CONFIG_MIGRATION_D32] };
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
 * - `llm.agentModel` (D32) missing → Sonnet 5.5 silently; not in the picker →
 *   Sonnet 5.5 with a notice.
 * - one-time `migrations` (D32: Jev + J1 on once), recorded by id.
 *
 * Never throws on a legacy provider; it throws only on a file that is not a
 * JSON object or has an unsupported schemaVersion.
 */
export function migrateConfig(raw: unknown): MigratedConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('_config.json must be a JSON object.');
  }
  const stored = raw as Omit<AppConfig, 'llm' | 'agentBudgets' | 'judge' | 'migrations'> & {
    llm?: { provider: StoredLlmProvider; model: string; reportEngine?: unknown; agentModel?: unknown };
    agentBudgets?: unknown;
    judge?: unknown;
    migrations?: unknown;
  };
  if (stored.schemaVersion !== 1) {
    throw new Error(`Unsupported _config.json schemaVersion: ${String(stored.schemaVersion)}`);
  }
  const notices: ConfigNotice[] = [];
  let llm: Omit<AppConfig['llm'], 'agentModel'>;
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
  const agentModel = agentModelOf(storedLlm, notices);
  // Stage 4a / 5b / D32: the agent and judge fields are filled silently (no notice).
  const { judge, migrations } = applyJudgeMigrations(normalizeJudgeSwitches(stored.judge), migrationsOf(stored.migrations));
  return { config: { ...stored, llm: { ...llm, agentModel }, agentBudgets: agentBudgetsOf(stored.agentBudgets), judge, migrations }, notices };
}

/** D32: missing → Sonnet 5.5 silently; an id the picker no longer offers → default with a notice (like `llm.model`). */
function agentModelOf(storedLlm: { agentModel?: unknown } | undefined | null, notices: ConfigNotice[]): string {
  const raw = typeof storedLlm === 'object' && storedLlm !== null ? storedLlm.agentModel : undefined;
  if (raw === undefined) return DEFAULT_AGENT_MODEL;
  if (typeof raw === 'string' && MODEL_OPTIONS.anthropic.includes(raw)) return raw;
  notices.push({
    code: 'MODEL_MIGRATED',
    message: `Agent report model ${String(raw)} is no longer offered; switched to ${DEFAULT_AGENT_MODEL}.`
  });
  return DEFAULT_AGENT_MODEL;
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
      agentModel: patch.llm?.agentModel ?? cur.llm.agentModel,
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
    agentBudgets: cur.agentBudgets,
    judge: mergeJudge(cur.judge, patch.judge),
    migrations: cur.migrations
  };
  await writeConfig(next);
  return { config: next, notices };
}

function mergeJudge(cur: JudgeSwitches, patch: JudgePatch | undefined): JudgeSwitches {
  if (patch === undefined) return cur;
  const flags = { ...cur.flags };
  for (const j of J_FLAGS) {
    const v = patch.flags?.[j];
    if (typeof v === 'boolean') flags[j] = v;
  }
  return {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    router: typeof patch.router === 'boolean' ? patch.router : cur.router,
    flags
  };
}

export interface JudgePatch {
  enabled?: boolean;
  router?: boolean;
  flags?: Partial<JudgeSwitches['flags']>;
}

export interface PatchInput {
  judge?: JudgePatch;
  llm?: Partial<AppConfig['llm']>;
  ui?: Partial<AppConfig['ui']>;
  features?: Partial<AppConfig['features']>;
}
