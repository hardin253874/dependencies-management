import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadPlaybookDir, matchPlaybooks, parsePlaybook, playbookBlock, playbookMatches, PlaybookFormatError } from '@/core/agent/playbooks';

const REPO_PLAYBOOKS = path.join(process.cwd(), 'playbooks');

describe('repo playbooks (4a.11)', () => {
  it('the three playbooks load, each citing official https sources', async () => {
    const all = await loadPlaybookDir(REPO_PLAYBOOKS);
    expect(all.map((p) => p.id)).toEqual(['moment-to-dayjs', 'next-12-to-13', 'react-17-to-18']);
    for (const p of all) {
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.sources.every((s) => s.startsWith('https://'))).toBe(true);
    }
    expect(all.find((p) => p.id === 'react-17-to-18')!.sources.some((s) => s.startsWith('https://react.dev/'))).toBe(true);
    expect(all.find((p) => p.id === 'next-12-to-13')!.sources.some((s) => s.startsWith('https://nextjs.org/'))).toBe(true);
  });

  it.each([
    ['react', '17.0.2', '18.2.0', ['react-17-to-18']],
    ['react-dom', '^17.0.0', '18.3.1', ['react-17-to-18']],
    ['react', '16.14.0', '18.2.0', []],
    ['react', '18.2.0', '19.0.0', []],
    ['next', '12.3.4', '13.5.6', ['next-12-to-13']],
    ['next', '13.0.0', '14.0.0', []],
    ['moment', '2.29.4', null, ['moment-to-dayjs']],
    ['dayjs', null, '1.11.10', ['moment-to-dayjs']],
    ['axios', '0.27.2', '1.6.8', []]
  ] as Array<[string, string | null, string | null, string[]]>)('%s %s → %s matches %j', async (name, from, to, ids) => {
    const all = await loadPlaybookDir(REPO_PLAYBOOKS);
    expect(matchPlaybooks(all, [{ name, from, to }]).map((p) => p.id)).toEqual(ids);
  });
});

describe('front matter validation (4a.11)', () => {
  const ok = '---\npackages: [a]\nfromMajor: 1\ntoMajor: 2\nsources: [https://example.org/guide]\n---\nBody.\n';

  it('parses a valid playbook', () => {
    expect(parsePlaybook('x', ok)).toEqual({ id: 'x', packages: ['a'], fromMajor: 1, toMajor: 2, sources: ['https://example.org/guide'], body: 'Body.' });
  });

  it.each([
    ['no front matter', 'Body only'],
    ['empty packages', ok.replace('[a]', '[]')],
    ['non-https source', ok.replace('https://example.org/guide', 'http://example.org')],
    ['missing sources', ok.replace('sources: [https://example.org/guide]\n', '')],
    ['bad major', ok.replace('fromMajor: 1', 'fromMajor: one')],
    ['empty body', ok.replace('Body.\n', '')]
  ])('rejects %s', (_label, text) => {
    expect(() => parsePlaybook('x', text)).toThrow(PlaybookFormatError);
  });

  it('toMajor null matches only a removal; * matches anything', () => {
    const removal = parsePlaybook('r', ok.replace('toMajor: 2', 'toMajor: null'));
    expect(playbookMatches(removal, 'a', '1.0.0', null)).toBe(true);
    expect(playbookMatches(removal, 'a', '1.0.0', '2.0.0')).toBe(false);
    const any = parsePlaybook('s', ok.replace('fromMajor: 1', 'fromMajor: *').replace('toMajor: 2', 'toMajor: *'));
    expect(playbookMatches(any, 'a', null, '5.0.0')).toBe(true);
  });

  it('playbookBlock is null without a match and names the sources with one', () => {
    expect(playbookBlock([])).toBeNull();
    expect(playbookBlock([parsePlaybook('x', ok)])).toContain('https://example.org/guide');
  });
});
