/**
 * Resolver check (spec §10.7).
 *
 * Verifies whether `npm install <target>@<toVersion> --dry-run
 * --package-lock-only --json` would resolve cleanly in the target project's
 * dependency graph. Runs inside a `TempSandbox` so the target directory is
 * never modified (spec §3.1 architectural invariant).
 *
 * Flow:
 *   1. Caller checks `_config.json.features.resolverCheckEnabled`. If false,
 *      caller short-circuits with `{ enabled: false, reason: 'kill-switch' }`.
 *   2. Caller checks `project.packageManager`. If yarn-*, returns
 *      `{ enabled: false, reason: 'yarn-not-supported' }` per spec §10.7.
 *   3. We copy `package.json`, lockfile, `.npmrc`, `.yarnrc[.yml]` (when
 *      present) into `os.tmpdir()/dep-agent/<jobId>/`.
 *   4. We resolve the `npm` binary: Volta first, system PATH second, fail
 *      with `RESOLVER_NPM_MISSING` third (G32).
 *   5. We shell out to `npm install <target>@<to> --dry-run --package-lock-only
 *      --json`. On `ERESOLVE`, we retry once with `--legacy-peer-deps` and
 *      flag the project as needing the flag.
 *   6. We delete the temp dir, success or failure (the boot-time sweep is a
 *      backstop for crashes).
 *
 * Output is the data block for the LLM's `resolverCheck` input contract.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { spawn, type SpawnOptions } from 'child_process';
import { getLogger } from '../logger';
import { depAgentTempRoot } from '../jobs/tempSweep';

export type ResolverDisabledReason = 'kill-switch' | 'yarn-not-supported' | 'resolver-failed';

export interface ResolverEnabledResult {
  enabled: true;
  /** Sandbox temp dir created for this run (deleted on cleanup). */
  sandboxDir: string;
  wouldResolve: boolean;
  conflicts: Array<{ package: string; reason: string }>;
  legacyPeerDepsUsed: boolean;
  /** Raw exit code from the npm process. */
  exitCode: number;
  /** Raw stderr captured (first 4KB) — useful for the [D] view's debug line. */
  stderrSnippet: string;
}

export interface ResolverDisabledResult {
  enabled: false;
  reason: ResolverDisabledReason;
  /** Human-readable message surfaced in the [D] banner. */
  message: string;
  /** When reason === 'resolver-failed' the raw error code is here. */
  errorCode?: string;
}

export type ResolverResult = ResolverEnabledResult | ResolverDisabledResult;

export interface ResolverOptions {
  /** Absolute path to the target project. Read-only. */
  projectRoot: string;
  /** Target dep name (e.g. 'react'). */
  depName: string;
  /** Target version (e.g. '19.0.0'). */
  toVersion: string;
  /** Job id — used as the sandbox directory name. */
  jobId: string;
  /** Pre-existing `legacyPeerDeps: true` from project.json forces the flag. */
  legacyPeerDepsAlready: boolean;
  /**
   * Optional spawn override for tests (return a fake stdout / stderr / exit
   * code without actually executing a binary).
   */
  spawnImpl?: SpawnLike;
  /**
   * Optional npm binary lookup override. Useful for tests so we don't depend
   * on the host having a real npm.
   */
  npmResolver?: () => Promise<NpmBinaryResolution>;
  /** Set true to skip the cleanup deletion (used by tests that snapshot the dir). */
  keepSandbox?: boolean;
  /** Volta-installed npm path for this project (when present in package.json). */
  voltaNpmBin?: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runResolverCheck(opts: ResolverOptions): Promise<ResolverEnabledResult | ResolverDisabledResult> {
  let sandboxDir: string | null = null;
  try {
    sandboxDir = await createTempSandbox(opts.projectRoot, opts.jobId);
    const npm = await (opts.npmResolver ?? (() => resolveNpmBinary({ voltaNpmBin: opts.voltaNpmBin ?? null })))();

    if (npm.kind === 'missing') {
      return {
        enabled: false,
        reason: 'resolver-failed',
        message: 'No npm binary found on PATH or via Volta. Install Node.js / npm to enable resolver check.',
        errorCode: 'RESOLVER_NPM_MISSING'
      };
    }

    const dryRun = await runDryRun({
      npm,
      sandboxDir,
      depName: opts.depName,
      toVersion: opts.toVersion,
      legacyPeerDeps: opts.legacyPeerDepsAlready,
      spawnImpl: opts.spawnImpl
    });

    let legacyPeerDepsUsed = dryRun.legacyPeerDepsAlready;
    let result = dryRun.result;
    // Auto-retry with --legacy-peer-deps on ERESOLVE.
    if (result.kind === 'eresolve' && !dryRun.legacyPeerDepsAlready) {
      const retry = await runDryRun({
        npm,
        sandboxDir,
        depName: opts.depName,
        toVersion: opts.toVersion,
        legacyPeerDeps: true,
        spawnImpl: opts.spawnImpl
      });
      if (retry.result.kind === 'ok') {
        legacyPeerDepsUsed = true;
        result = retry.result;
      } else {
        // Persist failure — use the retry's diagnostics if available.
        result = retry.result;
      }
    }

    if (result.kind === 'ok') {
      return {
        enabled: true,
        sandboxDir,
        wouldResolve: true,
        conflicts: [],
        legacyPeerDepsUsed,
        exitCode: result.exitCode,
        stderrSnippet: result.stderrSnippet
      };
    }

    if (result.kind === 'eresolve') {
      return {
        enabled: true,
        sandboxDir,
        wouldResolve: false,
        conflicts: result.conflicts,
        legacyPeerDepsUsed,
        exitCode: result.exitCode,
        stderrSnippet: result.stderrSnippet
      };
    }

    return {
      enabled: false,
      reason: 'resolver-failed',
      message: `npm dry-run exited with code ${result.exitCode}. ${result.stderrSnippet.slice(0, 200)}`.trim(),
      errorCode: 'RESOLVER_DRY_RUN_FAILED'
    };
  } catch (err) {
    const log = await getLogger();
    log.warn({ err: (err as Error).message, jobId: opts.jobId }, 'Resolver check failed');
    return {
      enabled: false,
      reason: 'resolver-failed',
      message: `Resolver check failed: ${(err as Error).message}`,
      errorCode: 'RESOLVER_FAILED'
    };
  } finally {
    if (sandboxDir !== null && opts.keepSandbox !== true) {
      await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// TempSandbox
// ---------------------------------------------------------------------------

export const SANDBOX_FILES = ['package.json', 'package-lock.json', '.npmrc', '.yarnrc', '.yarnrc.yml'] as const;

export async function createTempSandbox(projectRoot: string, jobId: string): Promise<string> {
  const root = depAgentTempRoot();
  await fs.mkdir(root, { recursive: true });
  const sandbox = path.join(root, jobId);
  await fs.mkdir(sandbox, { recursive: true });
  for (const fname of SANDBOX_FILES) {
    const src = path.join(projectRoot, fname);
    try {
      await fs.copyFile(src, path.join(sandbox, fname));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  }
  return sandbox;
}

// ---------------------------------------------------------------------------
// npm binary resolution (G32)
// ---------------------------------------------------------------------------

export interface NpmBinaryFound {
  kind: 'found';
  bin: string;
  source: 'volta' | 'path';
}

export interface NpmBinaryMissing {
  kind: 'missing';
  /** Diagnostic — list the locations we tried. */
  triedLocations: string[];
}

export type NpmBinaryResolution = NpmBinaryFound | NpmBinaryMissing;

export interface ResolveNpmOptions {
  voltaNpmBin: string | null;
  /** Test hook — override PATH lookup. */
  pathLookup?: (name: string) => Promise<string | null>;
}

export async function resolveNpmBinary(opts: ResolveNpmOptions): Promise<NpmBinaryResolution> {
  const tried: string[] = [];
  if (opts.voltaNpmBin !== null) {
    tried.push(`volta:${opts.voltaNpmBin}`);
    if (await isExecutable(opts.voltaNpmBin)) {
      return { kind: 'found', bin: opts.voltaNpmBin, source: 'volta' };
    }
  }
  const fromPath = await (opts.pathLookup ?? defaultPathLookup)('npm');
  if (fromPath !== null) {
    tried.push(`path:${fromPath}`);
    return { kind: 'found', bin: fromPath, source: 'path' };
  } else {
    tried.push('path:not-found');
  }
  return { kind: 'missing', triedLocations: tried };
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function defaultPathLookup(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? ['.cmd', '.exe', '.bat', '']
    : [''];
  for (const dir of pathEnv.split(sep)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawn npm install --dry-run --package-lock-only --json
// ---------------------------------------------------------------------------

export type SpawnLike = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: SpawnOptions
) => SpawnHandle;

export interface SpawnHandle {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

interface DryRunInput {
  npm: NpmBinaryFound;
  sandboxDir: string;
  depName: string;
  toVersion: string;
  legacyPeerDeps: boolean;
  spawnImpl?: SpawnLike;
}

type DryRunRawResult =
  | { kind: 'ok'; exitCode: number; stderrSnippet: string }
  | { kind: 'eresolve'; exitCode: number; conflicts: Array<{ package: string; reason: string }>; stderrSnippet: string }
  | { kind: 'failed'; exitCode: number; stderrSnippet: string };

interface DryRunOutput {
  legacyPeerDepsAlready: boolean;
  result: DryRunRawResult;
}

async function runDryRun(input: DryRunInput): Promise<DryRunOutput> {
  const args = ['install', `${input.depName}@${input.toVersion}`, '--dry-run', '--package-lock-only', '--json'];
  if (input.legacyPeerDeps) args.push('--legacy-peer-deps');
  const result = await spawnAndCapture(input.npm.bin, args, input.sandboxDir, input.spawnImpl);
  const stderrSnippet = result.stderr.slice(0, 4096);

  // Inspect npm's JSON output for ERESOLVE diagnostics; older npm versions
  // emit ERESOLVE on stderr in plain text.
  if (result.exitCode === 0) {
    return {
      legacyPeerDepsAlready: input.legacyPeerDeps,
      result: { kind: 'ok', exitCode: 0, stderrSnippet }
    };
  }
  const conflicts = parseEresolve(result.stdout, result.stderr);
  if (conflicts.length > 0 || /ERESOLVE/i.test(result.stderr) || /ERESOLVE/i.test(result.stdout)) {
    return {
      legacyPeerDepsAlready: input.legacyPeerDeps,
      result: { kind: 'eresolve', exitCode: result.exitCode, conflicts, stderrSnippet }
    };
  }
  return {
    legacyPeerDepsAlready: input.legacyPeerDeps,
    result: { kind: 'failed', exitCode: result.exitCode, stderrSnippet }
  };
}

interface CapturedSpawn {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnAndCapture(
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
  spawnImpl?: SpawnLike
): Promise<CapturedSpawn> {
  return new Promise<CapturedSpawn>((resolve, reject) => {
    const spawnFn = spawnImpl ?? (spawn as unknown as SpawnLike);
    const proc = spawnFn(cmd, args, { cwd, stdio: 'pipe', shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += String(chunk); });
    proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

/**
 * Extract conflicts from npm's `--json` output. npm@7+ surfaces ERESOLVE in
 * a structured way; we parse defensively because the shape changes between
 * minor versions.
 */
export function parseEresolve(stdoutJson: string, stderr: string): Array<{ package: string; reason: string }> {
  const out: Array<{ package: string; reason: string }> = [];
  // Attempt JSON parse first.
  try {
    const parsed = JSON.parse(stdoutJson) as unknown;
    extractFromParsedNpm(parsed, out);
  } catch {
    // Not JSON. Fall through to stderr scan.
  }
  if (out.length === 0) {
    extractFromStderr(stderr, out);
  }
  return out;
}

function extractFromParsedNpm(parsed: unknown, out: Array<{ package: string; reason: string }>): void {
  if (parsed === null || typeof parsed !== 'object') return;
  // npm 8/9/10 ERESOLVE shape: `{ code: 'ERESOLVE', error: { code, message, ... }, ... }`
  // We don't enumerate every variant — we look for fields that include the
  // word "conflict" or "peer" with a package name nearby.
  const root = parsed as Record<string, unknown>;
  const errField = root.error;
  if (errField !== undefined && typeof errField === 'object' && errField !== null) {
    const e = errField as Record<string, unknown>;
    if (typeof e.code === 'string' && e.code === 'ERESOLVE' && typeof e.summary === 'string') {
      out.push({ package: 'unknown', reason: e.summary });
    }
  }
  if (Array.isArray(root.problems)) {
    for (const p of root.problems) {
      if (typeof p === 'string') out.push({ package: extractPkgName(p), reason: p });
    }
  }
}

/**
 * Extract conflict entries from npm's stderr.
 *
 * Patterns covered (per Stage 3 review M3 — npm 10+ shapes added):
 *  1. `peer <name>@"..." from <other>@<v>` — the classic 8/9 shape.
 *  2. `npm WARN ERESOLVE overriding peer dependency <name>@"..."` — npm 10+
 *     emits warnings that aren't fatal but still indicate a peer mismatch.
 *  3. `Could not resolve dependency: <name>@<spec>` — npm 10+ "Could not
 *     resolve" preamble; useful when the structured JSON output is absent.
 *  4. `Conflicting peer dependency: <name>@<v>` — npm 10+ summary line.
 */
function extractFromStderr(stderr: string, out: Array<{ package: string; reason: string }>): void {
  const lines = stderr.split(/\r?\n/);
  const seen = new Set<string>();
  const push = (pkg: string, reason: string): void => {
    const k = `${pkg}|${reason}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ package: pkg, reason });
  };
  // Two-pass state — some patterns span lines (e.g. `ERESOLVE overriding peer
  // dependency\nFound: <name>@<v>`).
  let pendingOverride = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // (1) Classic: `peer <name>@"..." from <other>@<v>`.
    const peerMatch = line.match(/peer ([^@\s]+)@"?([^"\s]+)"?\s+from\s+([^@\s]+)@(\S+)/i);
    if (peerMatch !== null) {
      push(
        peerMatch[3]!,
        `peer ${peerMatch[1]} ${peerMatch[2]} from ${peerMatch[3]}@${peerMatch[4]}`
      );
      pendingOverride = false;
      continue;
    }
    // (2a) npm 10+ single-line: `ERESOLVE overriding peer dependency <name>@"..."`.
    const overrideInlineMatch = line.match(
      /ERESOLVE overriding peer dependency\s+(\S+?)@"?([^"\s]+)"?/i
    );
    if (overrideInlineMatch !== null) {
      push(
        overrideInlineMatch[1]!,
        `overriding peer ${overrideInlineMatch[1]}@${overrideInlineMatch[2]}`
      );
      pendingOverride = false;
      continue;
    }
    // (2b) npm 10+ multi-line preamble: `ERESOLVE overriding peer dependency` on
    // its own line, then the package appears on a `Found:` line below.
    if (/ERESOLVE overriding peer dependency\s*$/i.test(line)) {
      pendingOverride = true;
      continue;
    }
    if (pendingOverride) {
      const foundMatch = line.match(/Found:\s*(\S+?)@"?([^"\s]+)"?/i);
      if (foundMatch !== null) {
        push(foundMatch[1]!, `overriding peer ${foundMatch[1]}@${foundMatch[2]}`);
        pendingOverride = false;
        continue;
      }
    }
    // (3) npm 10+: `Could not resolve dependency: <name>@<spec>` preamble.
    const couldNotMatch = line.match(/Could not resolve dependency:\s*(\S+?)@"?([^"\s]+)"?/i);
    if (couldNotMatch !== null) {
      push(couldNotMatch[1]!, `could not resolve ${couldNotMatch[1]}@${couldNotMatch[2]}`);
      continue;
    }
    // (4) npm 10+: `Conflicting peer dependency: <name>@<v>` summary line.
    const conflictMatch = line.match(/Conflicting peer dependency:\s*(\S+?)@"?([^"\s]+)"?/i);
    if (conflictMatch !== null) {
      push(conflictMatch[1]!, `conflicting peer ${conflictMatch[1]}@${conflictMatch[2]}`);
      continue;
    }
    // (5) Fallback: generic `peer <name>@<spec>` without `from <other>` (npm 10+ alt).
    const looseMatch = line.match(/^\s*(?:npm (?:ERR!|WARN)\s+)?peer (\S+?)@"?([^"\s]+)"?\s*$/i);
    if (looseMatch !== null) {
      push(looseMatch[1]!, `peer ${looseMatch[1]}@${looseMatch[2]}`);
    }
  }
}

function extractPkgName(raw: string): string {
  const m = raw.match(/([@a-z0-9._/-]+)@/i);
  return m === null ? 'unknown' : m[1]!;
}
