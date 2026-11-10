/**
 * Corpus loader + validator (v2 Stage 0.2). Fixtures live in a sandbox;
 * the private case uses the fake id `private-fixture`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { loadCorpus, phaseFromCommit, phaseTags, validateCase } from '../../../eval/lib/corpus';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function publicCase(id = 'demo-react18', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    repo: 'https://github.com/example/demo',
    baseCommit: SHA_A,
    phases: [{ id: 'main', toCommit: SHA_B, packages: [{ name: 'react', from: '17.0.2', to: '18.2.0' }] }],
    tags: ['react-major'],
    ...extra
  };
}

function privateCase(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'private-fixture',
    repo: 'C:\\private\\fixture-repo',
    baseCommit: SHA_A,
    phases: [
      { id: 'p1', toCommit: SHA_B, packages: [{ name: 'next', from: '12.3.4', to: '16.0.0' }] },
      { id: 'p2', toCommit: SHA_C, packages: [{ name: 'sass', from: null, to: '1.0.0' }], tags: ['styles'] }
    ],
    tags: ['complex'],
    goldenFindings: [{ id: 'G01', phase: 'p1', title: 't', category: 'c', expected: 'yes', verified: false }],
    ...extra
  };
}

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

async function setup(
  publicCases: Array<Record<string, unknown>>,
  local: unknown
): Promise<{ casesDir: string; localFile: string }> {
  sandbox = await createSandbox('eval-corpus');
  const casesDir = await sandbox.scratch('cases');
  for (const c of publicCases) {
    await fs.writeFile(path.join(casesDir, `${String(c.id)}.json`), JSON.stringify(c), 'utf8');
  }
  const localFile = path.join(sandbox.scratchRoot, 'corpus.local.json');
  if (local !== undefined) {
    await fs.writeFile(localFile, typeof local === 'string' ? local : JSON.stringify(local), 'utf8');
  }
  return { casesDir, localFile };
}

describe('loadCorpus', () => {
  it('merges public and private cases and assigns visibility', async () => {
    const paths = await setup([publicCase()], { schemaVersion: 1, cases: [privateCase()] });
    const { cases, errors } = await loadCorpus(paths);
    expect(errors).toEqual([]);
    expect(cases.map((c) => [c.id, c.visibility])).toEqual([
      ['demo-react18', 'public'],
      ['private-fixture', 'private']
    ]);
    expect(cases[0]?.projectDirs).toEqual(['.']);
  });

  it('treats a missing local file as public-only with no error', async () => {
    const paths = await setup([publicCase()], undefined);
    const { cases, errors } = await loadCorpus(paths);
    expect(errors).toEqual([]);
    expect(cases).toHaveLength(1);
  });

  it('reports a malformed local file by name', async () => {
    const paths = await setup([], '{ not json');
    const { errors } = await loadCorpus(paths);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('corpus.local.json');
    expect(errors[0]).toContain('malformed JSON');
  });

  it('rejects a duplicate id across files', async () => {
    const dup = { ...privateCase(), id: 'demo-react18', goldenFindings: [] };
    const paths = await setup([publicCase()], { schemaVersion: 1, cases: [dup] });
    const { errors } = await loadCorpus(paths);
    expect(errors.some((e) => e.includes('duplicate case id'))).toBe(true);
  });

  it('rejects a local-path repo in a public file', async () => {
    const paths = await setup([publicCase('demo-local', { repo: 'C:\\code\\repo' })], undefined);
    const { errors, cases } = await loadCorpus(paths);
    expect(cases).toEqual([]);
    expect(errors.join('\n')).toMatch(/demo-local \$\.repo: a local path is allowed only in the private corpus/);
  });

  it('requires the file name to equal the case id', async () => {
    const paths = await setup([], undefined);
    await fs.writeFile(path.join(paths.casesDir, 'wrong-name.json'), JSON.stringify(publicCase()), 'utf8');
    const { errors } = await loadCorpus(paths);
    expect(errors.join('\n')).toContain('file name must be "demo-react18.json"');
  });
});

describe('validateCase', () => {
  const ctx = { file: 'f.json', visibility: 'public' as const };

  it('rejects a short SHA with case id and JSON path', () => {
    const { errors } = validateCase(publicCase('demo-sha', { baseCommit: 'abc1234' }), ctx);
    expect(errors).toEqual(['f.json demo-sha $.baseCommit: must be a full 40-hex lowercase SHA']);
  });

  it('rejects ".." and backslashes in projectDirs', () => {
    const { errors } = validateCase(publicCase('demo-dirs', { projectDirs: ['../up', 'a\\b', 'ok/dir'] }), ctx);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('$.projectDirs[0]');
    expect(errors[1]).toContain('$.projectDirs[1]');
  });

  it('rejects a golden finding that points at an unknown phase', () => {
    const c = privateCase({
      goldenFindings: [{ id: 'G01', phase: 'p9', title: 't', category: 'c', expected: 'yes', verified: false }]
    });
    const { errors } = validateCase(c, { file: 'l.json', visibility: 'private' });
    expect(errors.join('\n')).toContain('$.goldenFindings[0].phase');
  });

  it('rejects duplicate finding ids within a case', () => {
    const f = { id: 'G01', phase: 'p1', title: 't', category: 'c', expected: 'yes', verified: false };
    const { errors } = validateCase(privateCase({ goldenFindings: [f, f] }), { file: 'l.json', visibility: 'private' });
    expect(errors.join('\n')).toContain('duplicate finding id');
  });

  it('collects all errors, not only the first', () => {
    const { errors } = validateCase({ id: 'Bad Id', repo: 'http://x', baseCommit: 'x', phases: [], extra: 1 }, ctx);
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects an invalid npm package name and duplicate phase ids', () => {
    const c = publicCase('demo-names', {
      phases: [
        { id: 'main', toCommit: SHA_B, packages: [{ name: 'Not Valid', from: '1', to: '2' }] },
        { id: 'main', toCommit: SHA_C, packages: [{ name: 'ok', from: '1', to: '2' }] }
      ]
    });
    const msg = validateCase(c, ctx).errors.join('\n');
    expect(msg).toContain('valid npm package name');
    expect(msg).toContain('duplicate phase id');
  });

  it('accepts null from/to for added and removed packages', () => {
    const c = publicCase('demo-swap', {
      phases: [
        {
          id: 'main',
          toCommit: SHA_B,
          packages: [
            { name: 'moment', from: '2.29.4', to: null },
            { name: 'dayjs', from: null, to: '1.11.9' }
          ]
        }
      ]
    });
    expect(validateCase(c, ctx).errors).toEqual([]);
  });
});

describe('phase helpers', () => {
  it('chains phase ranges and merges tags', () => {
    const { value } = validateCase(privateCase(), { file: 'l.json', visibility: 'private' });
    expect(value).not.toBeNull();
    if (value === null) return;
    expect(phaseFromCommit(value, 0)).toBe(SHA_A);
    expect(phaseFromCommit(value, 1)).toBe(SHA_B);
    const second = value.phases[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    expect(phaseTags(value, second)).toEqual(['complex', 'styles']);
  });
});
