/**
 * Corpus loader + hand-written validator (no schema library, by design).
 *
 * Public cases: one JSON file per case in `eval/corpus/cases/<id>.json`
 * (tracked; curators add files in parallel, so one file per case avoids
 * merge conflicts). Private cases: `eval/corpus.local.json`
 * (`{ schemaVersion: 1, cases: [...] }`, gitignored).
 *
 * Every rule reports `<file> <caseId> <json path>: message`, and all errors
 * are collected — a curator fixing a case wants the whole list at once.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type {
  CorpusCase,
  CorpusPhase,
  GoldenExpected,
  GoldenFinding,
  LoadedCase,
  PackageChange,
  Visibility
} from './types';

export const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
const PHASE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// npm's validate-npm-package-name rules for new packages, minus the
// blacklist (core module names never appear as upgrade targets here).
const NPM_NAME_RE = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const EXPECTED: readonly GoldenExpected[] = ['yes', 'partial', 'no', 'l3'];

const CASE_KEYS = new Set([
  '$schema',
  'id',
  'repo',
  'baseCommit',
  'projectDirs',
  'phases',
  'tags',
  'truthExcludeGlobs',
  'source',
  'goldenFindings',
  'notes'
]);
const PHASE_KEYS = new Set(['id', 'toCommit', 'packages', 'tags']);
const PACKAGE_KEYS = new Set(['name', 'from', 'to']);
const FINDING_KEYS = new Set(['id', 'phase', 'title', 'category', 'expected', 'evidenceFiles', 'verified']);

export interface CorpusLoadResult {
  cases: LoadedCase[];
  errors: string[];
}

export interface LoadCorpusOptions {
  /** Directory of public case files. Missing dir = no public cases. */
  casesDir: string;
  /** Private corpus file. Missing file = no private cases (no warning). */
  localFile: string;
}

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: Json): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Absolute local path on either Windows (C:\…, \\server\…) or POSIX. */
export function isLocalPath(repo: string): boolean {
  return path.win32.isAbsolute(repo) || path.posix.isAbsolute(repo);
}

function isHttpsUrl(repo: string): boolean {
  try {
    const u = new URL(repo);
    return u.protocol === 'https:' && u.hostname.length > 0 && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

function isSafeRelativeDir(dir: string): boolean {
  if (dir.length === 0 || dir.includes('\\')) return false;
  if (isLocalPath(dir) || /^[a-zA-Z]:/.test(dir)) return false;
  return !dir.split('/').some((seg) => seg === '..');
}

/**
 * Validate one raw case. Returns the normalised case (defaults applied) and
 * the errors; the case is only usable when `errors` is empty.
 */
export function validateCase(
  raw: Json,
  ctx: { file: string; visibility: Visibility; index?: number }
): { value: CorpusCase | null; errors: string[] } {
  const errors: string[] = [];
  const idForMsg = isObject(raw) && typeof raw.id === 'string' ? raw.id : `#${ctx.index ?? 0}`;
  const err = (jsonPath: string, msg: string): void => {
    errors.push(`${ctx.file} ${idForMsg} ${jsonPath}: ${msg}`);
  };

  if (!isObject(raw)) {
    err('$', 'case must be a JSON object');
    return { value: null, errors };
  }
  for (const key of Object.keys(raw)) {
    if (!CASE_KEYS.has(key)) err(`$.${key}`, 'unknown field');
  }

  const { id, repo, baseCommit } = raw;
  if (typeof id !== 'string' || !CASE_ID_RE.test(id)) err('$.id', `must match ${CASE_ID_RE.source}`);

  if (typeof repo !== 'string' || repo.length === 0) {
    err('$.repo', 'required string');
  } else if (isLocalPath(repo)) {
    if (ctx.visibility !== 'private') err('$.repo', 'a local path is allowed only in the private corpus');
  } else if (!isHttpsUrl(repo)) {
    err('$.repo', 'must be an https URL without credentials (or an absolute local path, private only)');
  }

  if (typeof baseCommit !== 'string' || !SHA_RE.test(baseCommit)) {
    err('$.baseCommit', 'must be a full 40-hex lowercase SHA');
  }

  let projectDirs = ['.'];
  if (raw.projectDirs !== undefined) {
    if (!isStringArray(raw.projectDirs) || raw.projectDirs.length === 0) {
      err('$.projectDirs', 'must be a non-empty array of strings');
    } else {
      raw.projectDirs.forEach((d, i) => {
        if (!isSafeRelativeDir(d)) err(`$.projectDirs[${i}]`, 'must be relative, POSIX separators, no ".."');
      });
      projectDirs = raw.projectDirs;
    }
  }

  let tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!isStringArray(raw.tags)) err('$.tags', 'must be an array of strings');
    else tags = raw.tags;
  }

  const phases: CorpusPhase[] = [];
  const phaseIds = new Set<string>();
  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    err('$.phases', 'must be a non-empty array');
  } else {
    raw.phases.forEach((p, i) => {
      const at = `$.phases[${i}]`;
      if (!isObject(p)) {
        err(at, 'must be an object');
        return;
      }
      for (const key of Object.keys(p)) if (!PHASE_KEYS.has(key)) err(`${at}.${key}`, 'unknown field');
      if (typeof p.id !== 'string' || !PHASE_ID_RE.test(p.id)) {
        err(`${at}.id`, `must match ${PHASE_ID_RE.source}`);
      } else if (phaseIds.has(p.id)) {
        err(`${at}.id`, `duplicate phase id "${p.id}"`);
      } else {
        phaseIds.add(p.id);
      }
      if (typeof p.toCommit !== 'string' || !SHA_RE.test(p.toCommit)) {
        err(`${at}.toCommit`, 'must be a full 40-hex lowercase SHA');
      }
      const packages: PackageChange[] = [];
      if (!Array.isArray(p.packages) || p.packages.length === 0) {
        err(`${at}.packages`, 'must be a non-empty array');
      } else {
        p.packages.forEach((pkg, j) => {
          const pat = `${at}.packages[${j}]`;
          if (!isObject(pkg)) {
            err(pat, 'must be an object');
            return;
          }
          for (const key of Object.keys(pkg)) if (!PACKAGE_KEYS.has(key)) err(`${pat}.${key}`, 'unknown field');
          if (typeof pkg.name !== 'string' || pkg.name.length > 214 || !NPM_NAME_RE.test(pkg.name)) {
            err(`${pat}.name`, 'must be a valid npm package name');
          }
          for (const k of ['from', 'to'] as const) {
            const v = pkg[k];
            if (v !== null && (typeof v !== 'string' || v.length === 0)) {
              err(`${pat}.${k}`, 'must be a version string or null');
            }
          }
          if (pkg.from === null && pkg.to === null) err(pat, '"from" and "to" cannot both be null');
          packages.push(pkg as unknown as PackageChange);
        });
      }
      let phaseTags: string[] | undefined;
      if (p.tags !== undefined) {
        if (!isStringArray(p.tags)) err(`${at}.tags`, 'must be an array of strings');
        else phaseTags = p.tags;
      }
      const phase: CorpusPhase = { id: String(p.id), toCommit: String(p.toCommit), packages };
      if (phaseTags !== undefined) phase.tags = phaseTags;
      phases.push(phase);
    });
  }

  if (raw.truthExcludeGlobs !== undefined && !isStringArray(raw.truthExcludeGlobs)) {
    err('$.truthExcludeGlobs', 'must be an array of strings');
  }
  if (raw.source !== undefined) {
    if (!isObject(raw.source) || !Object.values(raw.source).every((v) => typeof v === 'string')) {
      err('$.source', 'must be an object of strings');
    }
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') err('$.notes', 'must be a string');

  if (raw.goldenFindings !== undefined) {
    if (!Array.isArray(raw.goldenFindings)) {
      err('$.goldenFindings', 'must be an array');
    } else {
      const findingIds = new Set<string>();
      raw.goldenFindings.forEach((f, i) => {
        const at = `$.goldenFindings[${i}]`;
        if (!isObject(f)) {
          err(at, 'must be an object');
          return;
        }
        for (const key of Object.keys(f)) if (!FINDING_KEYS.has(key)) err(`${at}.${key}`, 'unknown field');
        if (typeof f.id !== 'string' || f.id.length === 0 || /[|\s]/.test(f.id)) {
          err(`${at}.id`, 'required string without spaces or "|"');
        } else if (findingIds.has(f.id)) {
          err(`${at}.id`, `duplicate finding id "${f.id}"`);
        } else {
          findingIds.add(f.id);
        }
        if (typeof f.phase !== 'string' || !phaseIds.has(f.phase)) {
          err(`${at}.phase`, `must name an existing phase id (${Array.from(phaseIds).join(', ') || 'none'})`);
        }
        if (typeof f.title !== 'string' || f.title.length === 0) err(`${at}.title`, 'required string');
        if (typeof f.category !== 'string') err(`${at}.category`, 'required string');
        if (typeof f.expected !== 'string' || !(EXPECTED as readonly string[]).includes(f.expected)) {
          err(`${at}.expected`, `must be one of ${EXPECTED.join(', ')}`);
        }
        if (f.evidenceFiles !== undefined && !isStringArray(f.evidenceFiles)) {
          err(`${at}.evidenceFiles`, 'must be an array of strings');
        }
        if (typeof f.verified !== 'boolean') err(`${at}.verified`, 'required boolean');
      });
    }
  }

  if (errors.length > 0) return { value: null, errors };

  const value: CorpusCase = {
    id: id as string,
    repo: repo as string,
    baseCommit: baseCommit as string,
    projectDirs,
    phases,
    tags
  };
  if (raw.truthExcludeGlobs !== undefined) value.truthExcludeGlobs = raw.truthExcludeGlobs as string[];
  if (raw.source !== undefined) value.source = raw.source as Record<string, string>;
  if (raw.goldenFindings !== undefined) value.goldenFindings = raw.goldenFindings as unknown as GoldenFinding[];
  if (raw.notes !== undefined) value.notes = raw.notes as string;
  return { value, errors };
}

async function readJson(file: string): Promise<{ ok: true; value: Json } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    return { ok: false, error: `${file}: cannot read (${(e as Error).message})` };
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) as Json };
  } catch (e) {
    return { ok: false, error: `${file}: malformed JSON (${(e as Error).message})` };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadCorpus(opts: LoadCorpusOptions): Promise<CorpusLoadResult> {
  const errors: string[] = [];
  const cases: LoadedCase[] = [];

  if (await exists(opts.casesDir)) {
    const names = (await fs.readdir(opts.casesDir)).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const file = path.join(opts.casesDir, name);
      const read = await readJson(file);
      if (!read.ok) {
        errors.push(read.error);
        continue;
      }
      const { value, errors: caseErrors } = validateCase(read.value, { file, visibility: 'public' });
      errors.push(...caseErrors);
      if (value === null) continue;
      const expectedName = `${value.id}.json`;
      if (name !== expectedName) {
        errors.push(`${file} ${value.id} $.id: file name must be "${expectedName}"`);
        continue;
      }
      cases.push({ ...value, visibility: 'public', sourceFile: file });
    }
  }

  if (await exists(opts.localFile)) {
    const read = await readJson(opts.localFile);
    if (!read.ok) {
      errors.push(read.error);
    } else if (!isObject(read.value) || read.value.schemaVersion !== 1 || !Array.isArray(read.value.cases)) {
      errors.push(`${opts.localFile}: must be { "schemaVersion": 1, "cases": [...] }`);
    } else {
      read.value.cases.forEach((rawCase, index) => {
        const { value, errors: caseErrors } = validateCase(rawCase, {
          file: opts.localFile,
          visibility: 'private',
          index
        });
        errors.push(...caseErrors);
        if (value !== null) cases.push({ ...value, visibility: 'private', sourceFile: opts.localFile });
      });
    }
  }

  // A duplicate id is always an error — never a silent private-over-public override.
  const seen = new Map<string, string>();
  for (const c of cases) {
    const first = seen.get(c.id);
    if (first !== undefined) errors.push(`${c.sourceFile} ${c.id} $.id: duplicate case id (also in ${first})`);
    else seen.set(c.id, c.sourceFile);
  }

  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, errors };
}

/** Case tags merged with phase tags, sorted and unique. */
export function phaseTags(c: CorpusCase, phase: CorpusPhase): string[] {
  return Array.from(new Set([...c.tags, ...(phase.tags ?? [])])).sort();
}

/** The commit each phase's truth range starts from. */
export function phaseFromCommit(c: CorpusCase, phaseIndex: number): string {
  if (phaseIndex === 0) return c.baseCommit;
  const prev = c.phases[phaseIndex - 1];
  if (prev === undefined) throw new Error(`phase index ${phaseIndex} out of range for ${c.id}`);
  return prev.toCommit;
}

export function summarise(cases: LoadedCase[]): string {
  const pub = cases.filter((c) => c.visibility === 'public').length;
  const priv = cases.length - pub;
  const byTag = new Map<string, number>();
  for (const c of cases) {
    const tags = new Set([...c.tags, ...c.phases.flatMap((p) => p.tags ?? [])]);
    for (const t of tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
  }
  const tagLines = Array.from(byTag.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([t, n]) => `  ${t}: ${n}`);
  return [`${pub} public, ${priv} private`, ...(tagLines.length > 0 ? ['by tag:', ...tagLines] : [])].join('\n');
}
