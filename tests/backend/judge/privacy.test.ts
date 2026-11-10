/**
 * 5b.3 payload builders + privacy guard. A sentinel string from a fixture
 * source file must never appear in a metadata payload; code-like strings
 * throw; private / unknown-privacy projects send nothing; flags gate uses.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { capSnippet, isMetadataString, metadataPayload, publicTextPayload, sourcePayload, SNIPPET_MAX_BYTES } from '@/core/judge/payload';
import { assertAllowed } from '@/core/judge/privacy';
import { Judge } from '@/core/judge/judge';
import { MockJudgeClient } from '@/core/judge/mock';
import { coUpgradeJ5, relatedUnknownJ6, rankFilesJ1 } from '@/core/judge/uses';
import { routeModel, routerPayloadState, type RouterFacts } from '@/core/llm/router';
import { JudgePrivacyError, USE_CLASS, normalizeJudgeSwitches, type JudgeSubject, type JudgeSwitches } from '@/core/judge/types';

const ALL_ON: JudgeSwitches = normalizeJudgeSwitches({ enabled: true, router: true, flags: { J1: true, J2: true, J3: true, J4: true, J5: true, J6: true, J7: true, J8: true } });
const PUBLIC: JudgeSubject = { privacy: 'public' };
const SENTINEL = 'SENTINEL_9f3c_do_not_send';

const unclearFacts: RouterFacts = { view: 'update-report', jump: 'minor', packageCount: 1, graphFileCount: 50, apiDiff: null, cveCount: 0, configuredModel: 'claude-sonnet-5-5' };

describe('metadataPayload', () => {
  it('accepts numbers, booleans, enums, package names, semver, ISO dates', () => {
    expect(() =>
      metadataPayload({ view: 'agent', jump: 'major', n: 3, ok: true, none: null, pkg: '@scope/pkg-name', v: '1.2.3-beta.1', range: '^1.0.0 || >=2.1.0 <3', at: '2026-11-10T10:00:00Z' })
    ).not.toThrow();
  });

  it.each([
    ['a path', 'src/app/page.tsx'],
    ['a windows path', 'C:\\Users\\x'],
    ['code', 'const x = require("react")'],
    ['multi-line', 'line one\nline two'],
    ['a sentence', 'hello world this is text'],
    ['the sentinel', SENTINEL]
  ])('throws on %s', (_why, value) => {
    expect(() => metadataPayload({ field: value })).toThrow(JudgePrivacyError);
  });

  it('refuses data-shaped keys', () => {
    expect(() => metadataPayload({ 'src/app/page.tsx': 1 })).toThrow(JudgePrivacyError);
  });

  it('isMetadataString: words with spaces are not semver ranges', () => {
    expect(isMetadataString('hello world')).toBe(false);
    expect(isMetadataString('>=1.2.3 <2.0.0')).toBe(true);
  });
});

describe('source / public payloads', () => {
  it('caps a snippet at 40 lines and 2 KB', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
    const capped = capSnippet(long);
    expect(capped.split('\n').length).toBeLessThanOrEqual(40);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(SNIPPET_MAX_BYTES);
  });

  it('a source payload over the request bound throws (callers batch)', () => {
    const snippets = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts`, text: 'y'.repeat(2_000) }));
    expect(() => sourcePayload({ snippets })).toThrow(/bound/);
  });

  it('public text payload checks its meta like metadata', () => {
    expect(() => publicTextPayload({ meta: { package: 'react' }, text: { summary: 'XSS in render' } })).not.toThrow();
    expect(() => publicTextPayload({ meta: { file: 'src/a.ts' }, text: {} })).toThrow(JudgePrivacyError);
  });
});

describe('sentinel from a fixture source file never reaches a metadata payload', () => {
  it('router, J5 and J6 builders over a fixture project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-privacy-'));
    try {
      await fs.writeFile(path.join(dir, 'index.ts'), `import React from 'react';\nexport const secret = '${SENTINEL}';\n`);
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^17.0.2', 'react-dom': '^17.0.2' } }));
      const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
      const deps = Object.entries(pkg.dependencies).map(([name, version]) => ({ name, version }));
      const mock = new MockJudgeClient();
      const judge = new Judge({ client: mock, cache: null, switches: ALL_ON });
      const ctx = { judge, subject: PUBLIC };
      await routeModel(unclearFacts, { judge, subject: PUBLIC });
      await coUpgradeJ5(ctx, { target: 'react', from: '17.0.2', to: '18.2.0', deps });
      await relatedUnknownJ6(ctx, { viewedDep: 'react', from: '17.0.2', to: '18.2.0', deps });
      expect(mock.requests.map((r) => r.use)).toEqual(['router', 'J5', 'J6']);
      for (const r of mock.requests) expect(JSON.stringify(r)).not.toContain(SENTINEL);
      expect(JSON.stringify(routerPayloadState(unclearFacts))).not.toMatch(/[\\/]/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('assertAllowed', () => {
  it('USE_CLASS matches the plan table', () => {
    expect(USE_CLASS).toEqual({ router: 'metadata', J1: 'source', J2: 'source', J3: 'source', J4: 'public-text', J5: 'metadata', J6: 'metadata', J7: 'public-text', J8: 'public-text' });
  });

  it('global off refuses everything', () => {
    expect(() => assertAllowed({ use: 'J5', payloadClass: 'metadata', subject: PUBLIC, switches: normalizeJudgeSwitches({}) })).toThrow(/off/);
  });

  it('a use flag off refuses that use only', () => {
    const sw = normalizeJudgeSwitches({ enabled: true, flags: { J5: true } });
    expect(() => assertAllowed({ use: 'J5', payloadClass: 'metadata', subject: PUBLIC, switches: sw })).not.toThrow();
    expect(() => assertAllowed({ use: 'J6', payloadClass: 'metadata', subject: PUBLIC, switches: sw })).toThrow(/J6 is off/);
    expect(() => assertAllowed({ use: 'router', payloadClass: 'metadata', subject: PUBLIC, switches: sw })).toThrow(/router is off/);
  });

  it('per-project off beats global on', () => {
    expect(() => assertAllowed({ use: 'J5', payloadClass: 'metadata', subject: { privacy: 'public', judge: 'off' }, switches: ALL_ON })).toThrow(/this project/);
  });

  it.each(['router', 'J5', 'J6'] as const)('%s refuses source and public-text payloads', (use) => {
    expect(() => assertAllowed({ use, payloadClass: 'source', subject: PUBLIC, switches: ALL_ON })).toThrow(/metadata-only/);
    expect(() => assertAllowed({ use, payloadClass: 'public-text', subject: PUBLIC, switches: ALL_ON })).toThrow(/metadata-only/);
  });

  it.each(['router', 'J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8'] as const)('private and unknown-privacy projects send nothing for %s', (use) => {
    const cls = USE_CLASS[use];
    expect(() => assertAllowed({ use, payloadClass: cls, subject: { privacy: 'private' }, switches: ALL_ON })).toThrow(/private project/);
    expect(() => assertAllowed({ use, payloadClass: cls, subject: { privacy: undefined }, switches: ALL_ON })).toThrow(/unknown/);
  });

  it('the per-project opt-in lets J1–J3 source through for a private project, nothing else', () => {
    const optIn: JudgeSubject = { privacy: 'private', sourceOptIn: true };
    for (const use of ['J1', 'J2', 'J3'] as const) expect(() => assertAllowed({ use, payloadClass: 'source', subject: optIn, switches: ALL_ON })).not.toThrow();
    for (const use of ['router', 'J4', 'J5', 'J6', 'J7', 'J8'] as const) expect(() => assertAllowed({ use, payloadClass: USE_CLASS[use], subject: optIn, switches: ALL_ON })).toThrow(/private/);
    // An opt-in on an unknown-privacy project does not count.
    expect(() => assertAllowed({ use: 'J1', payloadClass: 'source', subject: { privacy: undefined, sourceOptIn: true }, switches: ALL_ON })).toThrow();
  });

  it('a private eval case is refused even with an opt-in', () => {
    expect(() => assertAllowed({ use: 'J1', payloadClass: 'source', subject: { privacy: 'private', sourceOptIn: true, privateEvalCase: true }, switches: ALL_ON })).toThrow(/private eval case/);
    expect(() => assertAllowed({ use: 'J5', payloadClass: 'metadata', subject: { privacy: 'public', privateEvalCase: true }, switches: ALL_ON })).toThrow(/private eval case/);
  });

  it('source for a private project → refused, the mock client saw 0 requests', async () => {
    const mock = new MockJudgeClient();
    const judge = new Judge({ client: mock, cache: null, switches: ALL_ON });
    const out = await rankFilesJ1({ judge, subject: { privacy: 'private' } }, { pkg: 'react', from: '17.0.2', to: '18.2.0', files: [{ path: 'a.ts', snippet: SENTINEL }] });
    expect(out).toBeNull();
    expect(mock.requests).toHaveLength(0);
  });
});
