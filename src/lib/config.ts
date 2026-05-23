/**
 * Typed env-config module. Single source of truth for all process.env.* reads.
 *
 * Per spec §5.3 / §5.4 / §5.5: setup script is the canonical authority for which
 * env vars exist; this module is the only place application code reads them.
 *
 * Token-budget fields are read once at startup. Re-reading after the user changes
 * .env requires a server restart (UI shows a "Restart required" notice).
 * API-key fields are mutable in-process via setApiKey().
 */

export type LlmProvider = 'anthropic' | 'openai';

export interface TokenBudget {
  input: number;
  output: number;
}

export interface AppEnv {
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  mockLlm: boolean;
  budgets: {
    fileReview: TokenBudget;
    updateReport: TokenBudget;
    deepReport: TokenBudget;
  };
  /** Set to true when the agent is running unit/integration tests. */
  isTest: boolean;
}

const DEFAULT_BUDGETS: AppEnv['budgets'] = {
  fileReview: { input: 30_000, output: 4_000 },
  updateReport: { input: 10_000, output: 6_000 },
  deepReport: { input: 100_000, output: 8_000 }
};

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid integer for env ${name}: ${raw}`);
  }
  return n;
}

function readNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

function readLogLevel(): AppEnv['logLevel'] {
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  const allowed: AppEnv['logLevel'][] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  return (allowed as string[]).includes(raw) ? (raw as AppEnv['logLevel']) : 'info';
}

let cached: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cached !== null) return cached;
  cached = {
    anthropicApiKey: readNonEmpty('ANTHROPIC_API_KEY'),
    openaiApiKey: readNonEmpty('OPENAI_API_KEY'),
    logLevel: readLogLevel(),
    mockLlm: (process.env.MOCK_LLM ?? 'false').toLowerCase() === 'true',
    budgets: {
      fileReview: {
        input: readInt('TOKEN_BUDGET_FILE_REVIEW_IN', DEFAULT_BUDGETS.fileReview.input),
        output: readInt('TOKEN_BUDGET_FILE_REVIEW_OUT', DEFAULT_BUDGETS.fileReview.output)
      },
      updateReport: {
        input: readInt('TOKEN_BUDGET_UPDATE_REPORT_IN', DEFAULT_BUDGETS.updateReport.input),
        output: readInt('TOKEN_BUDGET_UPDATE_REPORT_OUT', DEFAULT_BUDGETS.updateReport.output)
      },
      deepReport: {
        input: readInt('TOKEN_BUDGET_DEEP_REPORT_IN', DEFAULT_BUDGETS.deepReport.input),
        output: readInt('TOKEN_BUDGET_DEEP_REPORT_OUT', DEFAULT_BUDGETS.deepReport.output)
      }
    },
    isTest: process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined
  };
  return cached;
}

/** Reset cache. Used by tests. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Mutate the in-process API key fields after the user updates them via
 * POST /api/config/api-key. The LLMClient singleton must be re-instantiated
 * separately (per spec §5.4).
 */
export function setApiKey(provider: LlmProvider, value: string | null): void {
  const env = loadEnv();
  const cleaned = value === null || value.trim() === '' ? null : value.trim();
  if (provider === 'anthropic') {
    env.anthropicApiKey = cleaned;
    if (cleaned === null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = cleaned;
  } else {
    env.openaiApiKey = cleaned;
    if (cleaned === null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = cleaned;
  }
}

export function hasKey(provider: LlmProvider): boolean {
  const env = loadEnv();
  return provider === 'anthropic' ? env.anthropicApiKey !== null : env.openaiApiKey !== null;
}

/**
 * The list of env keys considered required given the active provider.
 * Used by the .env / .env.example reconciliation on boot (§5.2).
 */
export function requiredKeysForProvider(provider: LlmProvider): string[] {
  return provider === 'anthropic' ? ['ANTHROPIC_API_KEY'] : ['OPENAI_API_KEY'];
}
