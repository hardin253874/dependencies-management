/**
 * Ground-truth classifier (v2 Stage 0.3) — canned `git diff -z` output, no repo.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTruthSet,
  diffPackageJson,
  keptKind,
  parseNameStatusZ,
  parseNumstatZ
} from '../../../eval/lib/truth';

/** Build -z name-status text from [status, path, newPath?] tuples. */
function ns(rows: Array<[string, string, string?]>): string {
  return rows.map(([s, p, n]) => (n === undefined ? `${s}\0${p}\0` : `${s}\0${p}\0${n}\0`)).join('');
}

/** Build -z numstat text from [added, deleted, path, newPath?] tuples. */
function numstat(rows: Array<[string, string, string, string?]>): string {
  return rows.map(([a, d, p, n]) => (n === undefined ? `${a}\t${d}\t${p}\0` : `${a}\t${d}\t\0${p}\0${n}\0`)).join('');
}

function truth(
  rows: Array<[string, string, string?]>,
  stats: Array<[string, string, string, string?]>,
  opts: { projectDirs?: string[]; excludeGlobs?: string[] } = {}
): ReturnType<typeof buildTruthSet> {
  return buildTruthSet({
    nameStatusZ: ns(rows),
    numstatZ: numstat(stats),
    projectDirs: opts.projectDirs ?? ['.'],
    excludeGlobs: opts.excludeGlobs ?? []
  });
}

function reasonOf(set: ReturnType<typeof buildTruthSet>, p: string): string | undefined {
  return set.dropped.find((d) => d.path === p)?.reason;
}

describe('parsers', () => {
  it('parses name-status with renames and paths containing spaces and non-ASCII', () => {
    const raw = ns([
      ['M', 'src/my file.ts'],
      ['R087', 'src/old.ts', 'src/new.ts'],
      ['M', 'src/Über/ä.tsx']
    ]);
    expect(parseNameStatusZ(raw)).toEqual([
      { status: 'M', path: 'src/my file.ts' },
      { status: 'R', path: 'src/old.ts', newPath: 'src/new.ts' },
      { status: 'M', path: 'src/Über/ä.tsx' }
    ]);
  });

  it('keys numstat renames by the old path and marks binaries', () => {
    const map = parseNumstatZ(numstat([['3', '1', 'a.ts'], ['0', '0', 'old.ts', 'new.ts'], ['-', '-', 'img.png']]));
    expect(map.get('a.ts')).toEqual({ added: 3, deleted: 1 });
    expect(map.get('old.ts')).toEqual({ added: 0, deleted: 0 });
    expect(map.get('img.png')).toEqual({ added: null, deleted: null });
  });
});

describe('buildTruthSet — one row per §3.2 kind', () => {
  const rows: Array<[string, string, string?]> = [
    ['M', '.env.local'],
    ['M', 'yarn.lock'],
    ['M', 'packages/app/package.json'],
    ['M', 'generated/models/item.ts'],
    ['M', 'src/__snapshots__/a.test.tsx.snap'],
    ['M', 'README.md'],
    ['M', 'CHANGELOG'],
    ['M', 'public/logo.png'],
    ['M', 'src/ws-only.ts'],
    ['A', 'src/brand-new.ts'],
    ['M', 'src/app.tsx'],
    ['M', 'next.config.js'],
    ['M', 'src/styles/main.scss'],
    ['M', 'Dockerfile']
  ];
  const stats: Array<[string, string, string, string?]> = [
    ['1', '1', '.env.local'],
    ['10', '10', 'yarn.lock'],
    ['1', '1', 'packages/app/package.json'],
    ['2', '2', 'generated/models/item.ts'],
    ['5', '5', 'src/__snapshots__/a.test.tsx.snap'],
    ['1', '0', 'README.md'],
    ['1', '0', 'CHANGELOG'],
    ['-', '-', 'public/logo.png'],
    ['0', '0', 'src/ws-only.ts'],
    ['20', '0', 'src/brand-new.ts'],
    ['4', '2', 'src/app.tsx'],
    ['1', '1', 'next.config.js'],
    ['3', '3', 'src/styles/main.scss'],
    ['1', '1', 'Dockerfile']
  ];
  const set = truth(rows, stats, { excludeGlobs: ['generated/**'] });

  it.each([
    ['.env.local', 'env'],
    ['yarn.lock', 'lockfile'],
    ['packages/app/package.json', 'package-json'],
    ['generated/models/item.ts', 'excluded'],
    ['src/__snapshots__/a.test.tsx.snap', 'snapshot'],
    ['README.md', 'docs'],
    ['CHANGELOG', 'docs'],
    ['public/logo.png', 'binary'],
    ['src/ws-only.ts', 'formatting'],
    ['src/brand-new.ts', 'added'],
    ['Dockerfile', 'other']
  ])('drops %s as %s', (p, reason) => {
    expect(reasonOf(set, p)).toBe(reason);
  });

  it('keeps source, config and style with their kind', () => {
    expect(set.kept.map((k) => [k.path, k.kind])).toEqual([
      ['next.config.js', 'config'],
      ['src/app.tsx', 'source'],
      ['src/styles/main.scss', 'style']
    ]);
    expect(set.addedCount).toBe(1);
  });
});

describe('buildTruthSet — path rules', () => {
  it('keeps a rename under its old path, with the new path for display', () => {
    const set = truth([['R100', 'middleware.ts', 'proxy.ts']], [['0', '0', 'middleware.ts', 'proxy.ts']]);
    expect(set.kept).toEqual([{ path: 'middleware.ts', kind: 'source', status: 'R', newPath: 'proxy.ts' }]);
  });

  it('keeps a deletion', () => {
    const set = truth([['D', 'src/gone.js']], [['0', '12', 'src/gone.js']]);
    expect(set.kept.map((k) => [k.path, k.status])).toEqual([['src/gone.js', 'D']]);
  });

  it('drops a whitespace-only edit that -w numstat omits entirely', () => {
    const set = truth([['M', 'src/a.ts']], []);
    expect(reasonOf(set, 'src/a.ts')).toBe('formatting');
  });

  it('drops .env files even when git lists them', () => {
    const set = truth([['M', 'app/.env.production']], [['1', '1', 'app/.env.production']]);
    expect(set.kept).toEqual([]);
    expect(reasonOf(set, 'app/.env.production')).toBe('env');
  });

  it('puts kept-kind paths outside projectDirs in outOfScope', () => {
    const set = truth(
      [
        ['M', 'ui/src/a.tsx'],
        ['M', 'backend/tool.js']
      ],
      [
        ['1', '1', 'ui/src/a.tsx'],
        ['1', '1', 'backend/tool.js']
      ],
      { projectDirs: ['ui'] }
    );
    expect(set.kept.map((k) => k.path)).toEqual(['ui/src/a.tsx']);
    expect(set.outOfScope).toEqual(['backend/tool.js']);
  });

  it('handles paths with spaces and non-ASCII characters', () => {
    const set = truth(
      [
        ['M', 'src/my component.tsx'],
        ['M', 'src/Ünïcode.ts']
      ],
      [
        ['1', '1', 'src/my component.tsx'],
        ['2', '0', 'src/Ünïcode.ts']
      ]
    );
    expect(set.kept.map((k) => k.path)).toEqual(['src/my component.tsx', 'src/Ünïcode.ts']);
  });

  it('classifies next.config.js as config, not source', () => {
    expect(keptKind('next.config.js')).toBe('config');
    expect(keptKind('apps/web/tsconfig.base.json')).toBe('config');
    expect(keptKind('src/config/next.ts')).toBe('source');
    expect(keptKind('src/data.json')).toBeNull();
  });

  it('sorts output deterministically', () => {
    const set = truth(
      [
        ['M', 'z.ts'],
        ['M', 'a.ts']
      ],
      [
        ['1', '1', 'z.ts'],
        ['1', '1', 'a.ts']
      ]
    );
    expect(set.kept.map((k) => k.path)).toEqual(['a.ts', 'z.ts']);
  });
});

describe('diffPackageJson', () => {
  it('reports changed, added and removed dependencies per field', () => {
    const before = { dependencies: { react: '17.0.2', moment: '2.29.4' }, devDependencies: { eslint: '8.0.0' } };
    const after = { dependencies: { react: '18.2.0', dayjs: '1.11.9' }, devDependencies: { eslint: '8.0.0' } };
    expect(diffPackageJson(before, after)).toEqual([
      { field: 'dependencies', name: 'dayjs', from: null, to: '1.11.9' },
      { field: 'dependencies', name: 'moment', from: '2.29.4', to: null },
      { field: 'dependencies', name: 'react', from: '17.0.2', to: '18.2.0' }
    ]);
  });
});
