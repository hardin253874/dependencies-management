/**
 * Pure argv parser for `npm run eval -- <subcommand> …`. No I/O, so every
 * usage rule is unit-testable; the CLI maps UsageError to exit code 1.
 */
import type { GraphPackageSource, PredictorId } from './types';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const PREDICTORS: readonly PredictorId[] = ['v1-code-scan', 'v2-graph', 'v2-agent', 'v1-ai'];
export const AI_PREDICTORS: readonly PredictorId[] = ['v2-agent', 'v1-ai'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EvalEffort = (typeof EFFORTS)[number];
export const BUDGET_KINDS = ['update', 'deep'] as const;
export const PLAYBOOK_MODES = ['off', 'on'] as const;
/** Stage 4c measures Sonnet 5.5 (Q9); also the default so mock runs price like the real round. */
export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5';

/** Options of the AI predictors (Stage 4a.14 / 4a.15). Real API runs arrive in 4c (`--real`). */
export interface AiRunOptions {
  model: string;
  effort: EvalEffort;
  budget: (typeof BUDGET_KINDS)[number];
  playbooks: (typeof PLAYBOOK_MODES)[number];
  /** v2-agent: scripted model file (AgentScriptFile JSON or a { "<caseId>/<phaseId>": turns } map). */
  mockScript?: string;
  /** v1-ai: answer from MOCK_LLM fixtures (test-fixtures/llm/). */
  mock: boolean;
  /** Stage 4c: real Anthropic API through the spend gate (public cases only). */
  real: boolean;
  /** `--stop-at-usd`: lower ledger ceiling for this run; can never raise the round cap. */
  stopAtUsd?: number;
}
export const GRAPH_PACKAGE_SOURCES: readonly GraphPackageSource[] = ['declared', 'phase'];

export interface CorpusPaths {
  /** Directory holding public case files (default eval/corpus/cases). */
  corpus?: string;
  /** Private corpus file (default eval/corpus.local.json). */
  local?: string;
}

export type ParsedCommand =
  | { command: 'help' }
  | ({ command: 'validate' } & CorpusPaths)
  | ({
      command: 'truth';
      caseId: string;
      phase?: string;
      cacheDir?: string;
      offline: boolean;
    } & CorpusPaths)
  | ({
      command: 'run';
      label: string;
      cases?: string[];
      cacheDir?: string;
      offline: boolean;
      predictor: PredictorId;
      /** Set for v2-agent / v1-ai. */
      ai?: AiRunOptions;
    } & CorpusPaths)
  | ({
      command: 'graph';
      label: string;
      cases?: string[];
      cacheDir?: string;
      offline: boolean;
      packages: GraphPackageSource;
      refreshTruth: boolean;
    } & CorpusPaths)
  | ({ command: 'score-findings'; resultsPath: string } & CorpusPaths)
  | { command: 'compare'; a: string; b: string }
  | ({
      command: 'router-arms';
      label: string;
      opus: string;
      sonnet: string;
      haiku: string;
      jevCache?: string;
      configuredModel?: string;
    } & CorpusPaths)
  | ({
      command: 'judge';
      label: string;
      use: string;
      cases?: string[];
      /** `--use router` only: the three per-model v2-agent result files (as for router-arms). */
      opus?: string;
      sonnet?: string;
      haiku?: string;
      configuredModel?: string;
      cacheDir?: string;
      offline: boolean;
      real: boolean;
      stopAtUsd?: number;
    } & CorpusPaths);

export const HELP_TEXT = `Usage: npm run eval -- <command> [options]

Commands:
  validate        [--corpus <dir>] [--local <file>]
                  Validate and merge the corpora; print case counts.
  truth           --case <id> [--phase <id>] [--cache-dir <dir>] [--offline]
                  Prepare the pinned clone; print the truth set and package.json diff.
  run             --label <label> [--cases id,id] [--cache-dir <dir>] [--offline]
                  [--predictor v1-code-scan|v2-graph|v2-agent|v1-ai]
                  [--model <id>] [--effort low|medium|high|xhigh|max]
                  [--budget update|deep] [--playbooks off|on]
                  [--mock-script <file>] (v2-agent) · [--mock-llm] (v1-ai)
                  [--real [--stop-at-usd <n>]] (v2-agent / v1-ai, public cases only)
                  Score every case; write eval/results/<date>-<label>.json.
                  AI predictors need a mock, or --real: the real Anthropic API through the
                  spend ledger (hard round cap in code; --stop-at-usd can only lower it).
  graph           --label <label> [--cases id,id] [--packages declared|phase]
                  [--cache-dir <dir>] [--offline] [--refresh-truth]
                  Graph "files that use package X" vs TypeScript truth + unresolved %;
                  write eval/results/<date>-<label>-graph.json (private cases: results/private/).
  score-findings  <results.json>
                  Merge the hand-filled findings sheet into the results file.
  compare         <a.json> <b.json>
                  Print a Markdown delta table.
  router-arms     --opus <result> --sonnet <result> --haiku <result> --label <label>
                  [--jev-cache <dir>] [--configured-model <id>]
                  Offline D28 router arms (always-Opus, always-Sonnet, rules-only, rules+Jev)
                  from per-model v2-agent results; never calls Claude.
  judge           --use J1|J2|J3|J4|J5|J6|J7|J8 --label <label> [--cases id,id]
                  [--cache-dir <dir>] [--offline] [--real [--stop-at-usd <n>]]
                  Jev judgment measurement (mock by default; --real = TypeSafe through the
                  Jev ledger, HARD $0.50 cap in code; public cases only).
                  --use router --opus <result> --sonnet <result> --haiku <result>
                  [--configured-model <id>]: asks Jev only for the phases the router rules
                  leave unclear (max 5 requests) and caches the answers under
                  <evalCache>/_judge (mock: _judge-mock) for router-arms --jev-cache.

Exit codes: 0 ok · 1 usage/validation error · 2 results written with case errors.
`;

/** Flags that take a value, per command. Anything else is boolean or unknown. */
const VALUE_FLAGS: Record<string, readonly string[]> = {
  validate: ['corpus', 'local'],
  truth: ['case', 'phase', 'cache-dir', 'corpus', 'local'],
  run: ['label', 'cases', 'cache-dir', 'predictor', 'corpus', 'local', 'model', 'effort', 'budget', 'playbooks', 'mock-script', 'stop-at-usd'],
  graph: ['label', 'cases', 'cache-dir', 'packages', 'corpus', 'local'],
  'score-findings': ['corpus', 'local'],
  compare: [],
  'router-arms': ['label', 'opus', 'sonnet', 'haiku', 'jev-cache', 'configured-model', 'corpus'],
  judge: ['label', 'use', 'cases', 'cache-dir', 'corpus', 'stop-at-usd', 'opus', 'sonnet', 'haiku', 'configured-model']
};
const BOOL_FLAGS: Record<string, readonly string[]> = {
  validate: [],
  truth: ['offline'],
  run: ['offline', 'mock-llm', 'real'],
  graph: ['offline', 'refresh-truth'],
  'score-findings': [],
  compare: [],
  'router-arms': [],
  judge: ['offline', 'real']
};

interface RawArgs {
  flags: Map<string, string | true>;
  positionals: string[];
}

function splitArgs(command: string, argv: string[]): RawArgs {
  const valueFlags = VALUE_FLAGS[command] ?? [];
  const boolFlags = BOOL_FLAGS[command] ?? [];
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (flags.has(name)) throw new UsageError(`--${name} given more than once`);
    if (boolFlags.includes(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    if (!valueFlags.includes(name)) throw new UsageError(`unknown option --${name} for "${command}"`);
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (value === undefined || value.length === 0) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { flags, positionals };
}

function str(raw: RawArgs, name: string): string | undefined {
  const v = raw.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function required(raw: RawArgs, name: string, command: string): string {
  const v = str(raw, name);
  if (v === undefined) throw new UsageError(`"${command}" needs --${name} <value>`);
  return v;
}

function corpusPaths(raw: RawArgs): CorpusPaths {
  const out: CorpusPaths = {};
  const corpus = str(raw, 'corpus');
  const local = str(raw, 'local');
  if (corpus !== undefined) out.corpus = corpus;
  if (local !== undefined) out.local = local;
  return out;
}

function labelOf(raw: RawArgs, command: string): string {
  const label = required(raw, 'label', command);
  if (!LABEL_RE.test(label)) {
    throw new UsageError(`invalid --label "${label}" (must match ${LABEL_RE.source})`);
  }
  return label;
}

function caseIds(raw: RawArgs): string[] | undefined {
  const cases = str(raw, 'cases');
  if (cases === undefined) return undefined;
  const ids = cases.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (ids.length === 0) throw new UsageError('--cases needs at least one id');
  return ids;
}

function noPositionals(raw: RawArgs, command: string): void {
  if (raw.positionals.length > 0) {
    throw new UsageError(`unexpected argument "${raw.positionals[0]}" for "${command}"`);
  }
}

function oneOf<T extends string>(raw: RawArgs, name: string, allowed: readonly T[], fallback: T): T {
  const v = str(raw, name) ?? fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new UsageError(`unknown --${name} "${v}" (known: ${allowed.join(', ')})`);
  return v as T;
}

const AI_ONLY_FLAGS = ['model', 'effort', 'budget', 'playbooks', 'mock-script', 'mock-llm', 'real', 'stop-at-usd'];

/** AI predictor options; rejects AI-only flags on the deterministic predictors. */
function aiOptions(raw: RawArgs, predictor: PredictorId): AiRunOptions | undefined {
  if (!AI_PREDICTORS.includes(predictor)) {
    const stray = AI_ONLY_FLAGS.find((f) => raw.flags.has(f));
    if (stray !== undefined) throw new UsageError(`--${stray} only applies to --predictor ${AI_PREDICTORS.join(' / ')}`);
    return undefined;
  }
  const model = str(raw, 'model') ?? DEFAULT_AI_MODEL;
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(model)) throw new UsageError(`invalid --model "${model}"`);
  const out: AiRunOptions = {
    model,
    effort: oneOf(raw, 'effort', EFFORTS, 'medium'),
    budget: oneOf(raw, 'budget', BUDGET_KINDS, 'update'),
    playbooks: oneOf(raw, 'playbooks', PLAYBOOK_MODES, 'off'),
    mock: raw.flags.get('mock-llm') === true,
    real: raw.flags.get('real') === true
  };
  const mockScript = str(raw, 'mock-script');
  if (mockScript !== undefined) out.mockScript = mockScript;
  const stopAt = str(raw, 'stop-at-usd');
  if (stopAt !== undefined) {
    if (!out.real) throw new UsageError('--stop-at-usd only applies with --real');
    const n = Number(stopAt);
    if (!/^\d+(\.\d+)?$/.test(stopAt) || !Number.isFinite(n) || n <= 0) throw new UsageError(`invalid --stop-at-usd "${stopAt}" (a positive dollar amount)`);
    out.stopAtUsd = n;
  }
  if (out.real) {
    if (out.mock || out.mockScript !== undefined) throw new UsageError('--real cannot be combined with --mock-llm / --mock-script');
    // Privacy (4c.2): the private corpus never runs against a real API.
    if (raw.flags.has('local')) throw new UsageError('--real cannot be combined with --local (private cases never reach a real API)');
  }
  if (predictor === 'v2-agent' && out.mockScript === undefined && !out.real) {
    throw new UsageError('--predictor v2-agent needs --mock-script <file> or --real');
  }
  if (predictor === 'v1-ai' && !out.mock && !out.real) {
    throw new UsageError('--predictor v1-ai needs --mock-llm or --real');
  }
  if (predictor === 'v1-ai' && out.mockScript !== undefined) throw new UsageError('--mock-script only applies to --predictor v2-agent');
  if (predictor === 'v2-agent' && out.mock) throw new UsageError('--mock-llm only applies to --predictor v1-ai (v2-agent uses --mock-script)');
  return out;
}

export function parseArgs(argv: string[]): ParsedCommand {
  const rest = argv.filter((a) => a !== '--');
  const command = rest[0];
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  if (!(command in VALUE_FLAGS)) throw new UsageError(`unknown command "${command}"`);
  const raw = splitArgs(command, rest.slice(1));

  switch (command) {
    case 'validate':
      noPositionals(raw, command);
      return { command, ...corpusPaths(raw) };
    case 'truth': {
      noPositionals(raw, command);
      const out: ParsedCommand = {
        command,
        caseId: required(raw, 'case', command),
        offline: raw.flags.get('offline') === true,
        ...corpusPaths(raw)
      };
      const phase = str(raw, 'phase');
      const cacheDir = str(raw, 'cache-dir');
      if (phase !== undefined) out.phase = phase;
      if (cacheDir !== undefined) out.cacheDir = cacheDir;
      return out;
    }
    case 'run': {
      noPositionals(raw, command);
      const label = labelOf(raw, command);
      const predictor = str(raw, 'predictor') ?? 'v1-code-scan';
      if (!(PREDICTORS as readonly string[]).includes(predictor)) {
        throw new UsageError(`unknown --predictor "${predictor}" (known: ${PREDICTORS.join(', ')})`);
      }
      const out: ParsedCommand = {
        command,
        label,
        offline: raw.flags.get('offline') === true,
        predictor: predictor as PredictorId,
        ...corpusPaths(raw)
      };
      const cases = caseIds(raw);
      if (cases !== undefined) out.cases = cases;
      const cacheDir = str(raw, 'cache-dir');
      if (cacheDir !== undefined) out.cacheDir = cacheDir;
      const ai = aiOptions(raw, predictor as PredictorId);
      if (ai !== undefined) out.ai = ai;
      return out;
    }
    case 'graph': {
      noPositionals(raw, command);
      const label = labelOf(raw, command);
      const packages = str(raw, 'packages') ?? 'declared';
      if (!(GRAPH_PACKAGE_SOURCES as readonly string[]).includes(packages)) {
        throw new UsageError(`unknown --packages "${packages}" (known: ${GRAPH_PACKAGE_SOURCES.join(', ')})`);
      }
      const out: ParsedCommand = {
        command,
        label,
        offline: raw.flags.get('offline') === true,
        packages: packages as GraphPackageSource,
        refreshTruth: raw.flags.get('refresh-truth') === true,
        ...corpusPaths(raw)
      };
      const cases = caseIds(raw);
      if (cases !== undefined) out.cases = cases;
      const cacheDir = str(raw, 'cache-dir');
      if (cacheDir !== undefined) out.cacheDir = cacheDir;
      return out;
    }
    case 'score-findings': {
      if (raw.positionals.length !== 1) throw new UsageError('"score-findings" needs exactly one <results.json>');
      return { command, resultsPath: raw.positionals[0] as string, ...corpusPaths(raw) };
    }
    case 'compare': {
      if (raw.positionals.length !== 2) throw new UsageError('"compare" needs exactly two files: <a.json> <b.json>');
      return { command, a: raw.positionals[0] as string, b: raw.positionals[1] as string };
    }
    case 'router-arms': {
      noPositionals(raw, command);
      const out: ParsedCommand = {
        command,
        label: labelOf(raw, command),
        opus: required(raw, 'opus', command),
        sonnet: required(raw, 'sonnet', command),
        haiku: required(raw, 'haiku', command),
        ...corpusPaths(raw)
      };
      const jevCache = str(raw, 'jev-cache');
      if (jevCache !== undefined) out.jevCache = jevCache;
      const configured = str(raw, 'configured-model');
      if (configured !== undefined) {
        if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(configured)) throw new UsageError(`invalid --configured-model "${configured}"`);
        out.configuredModel = configured;
      }
      return out;
    }
    case 'judge': {
      noPositionals(raw, command);
      const use = required(raw, 'use', command);
      if (!/^J[1-8]$/.test(use) && use !== 'router') throw new UsageError(`unknown --use "${use}" (known: J1-J8, router)`);
      const out: ParsedCommand = {
        command,
        label: labelOf(raw, command),
        use,
        offline: raw.flags.get('offline') === true,
        real: raw.flags.get('real') === true,
        ...corpusPaths(raw)
      };
      const cases = caseIds(raw);
      if (cases !== undefined) out.cases = cases;
      const cacheDir = str(raw, 'cache-dir');
      if (cacheDir !== undefined) out.cacheDir = cacheDir;
      const stopAt = str(raw, 'stop-at-usd');
      if (stopAt !== undefined) {
        if (!out.real) throw new UsageError('--stop-at-usd only applies with --real');
        const n = Number(stopAt);
        if (!/^\d+(\.\d+)?$/.test(stopAt) || !Number.isFinite(n) || n <= 0) throw new UsageError(`invalid --stop-at-usd "${stopAt}" (a positive dollar amount)`);
        out.stopAtUsd = n;
      }
      const files = { opus: str(raw, 'opus'), sonnet: str(raw, 'sonnet'), haiku: str(raw, 'haiku') };
      const configured = str(raw, 'configured-model');
      if (use === 'router') {
        out.opus = required(raw, 'opus', command);
        out.sonnet = required(raw, 'sonnet', command);
        out.haiku = required(raw, 'haiku', command);
        if (configured !== undefined) {
          if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(configured)) throw new UsageError(`invalid --configured-model "${configured}"`);
          out.configuredModel = configured;
        }
      } else if (Object.values(files).some((f) => f !== undefined) || configured !== undefined) {
        throw new UsageError('--opus/--sonnet/--haiku/--configured-model only apply with --use router');
      }
      // Privacy: the private corpus never feeds Jev, mock or real.
      if (raw.flags.has('local')) throw new UsageError('judge cannot be combined with --local (private cases never run Jev judgments)');
      return out;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}
