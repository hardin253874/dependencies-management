/**
 * Pure argv parser for `npm run eval -- <subcommand> …`. No I/O, so every
 * usage rule is unit-testable; the CLI maps UsageError to exit code 1.
 */
import type { PredictorId } from './types';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const PREDICTORS: readonly PredictorId[] = ['v1-code-scan'];

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
    } & CorpusPaths)
  | ({ command: 'score-findings'; resultsPath: string } & CorpusPaths)
  | { command: 'compare'; a: string; b: string };

export const HELP_TEXT = `Usage: npm run eval -- <command> [options]

Commands:
  validate        [--corpus <dir>] [--local <file>]
                  Validate and merge the corpora; print case counts.
  truth           --case <id> [--phase <id>] [--cache-dir <dir>] [--offline]
                  Prepare the pinned clone; print the truth set and package.json diff.
  run             --label <label> [--cases id,id] [--cache-dir <dir>] [--offline]
                  [--predictor v1-code-scan]
                  Score every case; write eval/results/<date>-<label>.json.
  score-findings  <results.json>
                  Merge the hand-filled findings sheet into the results file.
  compare         <a.json> <b.json>
                  Print a Markdown delta table.

Exit codes: 0 ok · 1 usage/validation error · 2 results written with case errors.
`;

/** Flags that take a value, per command. Anything else is boolean or unknown. */
const VALUE_FLAGS: Record<string, readonly string[]> = {
  validate: ['corpus', 'local'],
  truth: ['case', 'phase', 'cache-dir', 'corpus', 'local'],
  run: ['label', 'cases', 'cache-dir', 'predictor', 'corpus', 'local'],
  'score-findings': ['corpus', 'local'],
  compare: []
};
const BOOL_FLAGS: Record<string, readonly string[]> = {
  validate: [],
  truth: ['offline'],
  run: ['offline'],
  'score-findings': [],
  compare: []
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

function noPositionals(raw: RawArgs, command: string): void {
  if (raw.positionals.length > 0) {
    throw new UsageError(`unexpected argument "${raw.positionals[0]}" for "${command}"`);
  }
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
      const label = required(raw, 'label', command);
      if (!LABEL_RE.test(label)) {
        throw new UsageError(`invalid --label "${label}" (must match ${LABEL_RE.source})`);
      }
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
      const cases = str(raw, 'cases');
      if (cases !== undefined) {
        const ids = cases.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (ids.length === 0) throw new UsageError('--cases needs at least one id');
        out.cases = ids;
      }
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
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}
