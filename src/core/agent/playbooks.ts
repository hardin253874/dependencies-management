/**
 * Playbooks as data (V2_STAGE4_SPEC 4a.11, design §8 seam).
 *
 * Upgrade know-how lives in `playbooks/*.md` with a small front matter:
 *
 *   ---
 *   packages: [react, react-dom]
 *   fromMajor: 17
 *   toMajor: 18
 *   sources: [https://react.dev/blog/2022/03/08/react-18-upgrade-guide]
 *   ---
 *
 * Written only from the packages' official public migration guides (listed in
 * `sources`), never from eval truth diffs. A playbook matches when the
 * package is listed and the from/to majors match (`*` = any; `toMajor: null`
 * matches a removal). The loader is pure over the files it is given; reading
 * the directory is the caller's job (`loadPlaybookDir`).
 */
import { promises as fs } from 'fs';
import path from 'path';
import semver from 'semver';

export interface Playbook {
  id: string;
  packages: string[];
  fromMajor: number | '*';
  toMajor: number | '*' | null;
  sources: string[];
  body: string;
}

export class PlaybookFormatError extends Error {
  constructor(id: string, message: string) {
    super(`playbook ${id}: ${message}`);
    this.name = 'PlaybookFormatError';
  }
}

function parseList(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return [];
  return t
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s !== '');
}

function parseMajor(raw: string | undefined, id: string, key: string, allowNull: boolean): number | '*' | null {
  const t = (raw ?? '').trim();
  if (t === '*') return '*';
  if (allowNull && t === 'null') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) throw new PlaybookFormatError(id, `${key} must be an integer${allowNull ? ', null' : ''} or *`);
  return n;
}

export function parsePlaybook(id: string, text: string): Playbook {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (m === null) throw new PlaybookFormatError(id, 'missing front matter');
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const packages = parseList(fields.packages ?? '');
  if (packages.length === 0) throw new PlaybookFormatError(id, 'packages must be a non-empty [list]');
  const sources = parseList(fields.sources ?? '');
  if (sources.length === 0 || !sources.every((s) => /^https:\/\//.test(s))) throw new PlaybookFormatError(id, 'sources must list official https URLs');
  const body = m[2]!.trim();
  if (body === '') throw new PlaybookFormatError(id, 'empty body');
  return { id, packages, fromMajor: parseMajor(fields.fromMajor, id, 'fromMajor', false) as number | '*', toMajor: parseMajor(fields.toMajor, id, 'toMajor', true), sources, body };
}

function majorOf(v: string | null): number | null {
  if (v === null) return null;
  const c = semver.coerce(v);
  return c === null ? null : c.major;
}

export function playbookMatches(p: Playbook, pkg: string, from: string | null, to: string | null): boolean {
  if (!p.packages.includes(pkg)) return false;
  const fm = majorOf(from);
  const tm = majorOf(to);
  const fromOk = p.fromMajor === '*' || (fm !== null && fm === p.fromMajor);
  const toOk = p.toMajor === '*' ? true : p.toMajor === null ? to === null : tm !== null && tm === p.toMajor;
  return fromOk && toOk;
}

export function matchPlaybooks(all: readonly Playbook[], packages: ReadonlyArray<{ name: string; from: string | null; to: string | null }>): Playbook[] {
  const out: Playbook[] = [];
  for (const p of [...all].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (packages.some((x) => playbookMatches(p, x.name, x.from, x.to))) out.push(p);
  }
  return out;
}

/** The text block appended after the seed prompt (one per matched playbook, joined). */
export function playbookBlock(matched: readonly Playbook[]): string | null {
  if (matched.length === 0) return null;
  return matched
    .map((p) => `PLAYBOOK ${p.id} (from the official guides: ${p.sources.join(', ')}). Use it as background; verify against the project with the tools.\n\n${p.body}`)
    .join('\n\n---\n\n');
}

export async function loadPlaybookDir(dir: string): Promise<Playbook[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md').sort();
  } catch {
    return [];
  }
  const out: Playbook[] = [];
  for (const n of names) out.push(parsePlaybook(n.replace(/\.md$/, ''), await fs.readFile(path.join(dir, n), 'utf8')));
  return out;
}
