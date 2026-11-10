/**
 * 5b.10–5b.15 call sites over the mock judge: each flag off → today's output
 * exactly; on → the documented, labelled change. No network (fake OSV fetch,
 * injected LLM clients).
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Judge } from '@/core/judge/judge';
import { MockJudgeClient } from '@/core/judge/mock';
import { normalizeJudgeSwitches, J_FLAGS, type JudgeSubject } from '@/core/judge/types';
import { rankFilesJ1, estimateSeverityJ7, type JudgeContext } from '@/core/judge/uses';
import { extractImportSiteContext } from '@/lib/scanners/importSiteContext';
import { runCveImpact } from '@/lib/llm/cveImpactService';
import { runRelatedUpgrade } from '@/lib/llm/relatedUpgradeService';
import { queryCves, keyFor } from '@/lib/scanners/cve';
import { addJevCoUpgrades, applyJevRenames, applyReportEvidenceCheck, markJevCoUpgrades } from '@/lib/judge/apply';
import { computeCoUpgradeCandidates } from '@/lib/llm/coUpgrade';
import { apiDiffSeedLines } from '@/core/agent/seedFacts';
import { LLMError, type LLMClient } from '@/lib/llm/client';
import type { ApiDiffResult } from '@/core/intel/apiDiff';
import type { CveRecord, RelatedDep, UpdateReportDetail } from '@/lib/api-types';

const PUBLIC: JudgeSubject = { privacy: 'public' };
const ALL = normalizeJudgeSwitches({ enabled: true, router: true, flags: Object.fromEntries(J_FLAGS.map((j) => [j, true])) });

function ctx(mock: MockJudgeClient, subject: JudgeSubject = PUBLIC): JudgeContext {
  return { judge: new Judge({ client: mock, cache: null, switches: ALL }), subject };
}

async function tmpProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-cs-'));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), c);
  }
  return dir;
}

function failingClient(): LLMClient {
  return { provider: 'anthropic', call: vi.fn(async () => { throw new LLMError('LLM_NETWORK', 'down', false); }) } as unknown as LLMClient;
}

function okCveClient(rows: unknown[]): LLMClient {
  return {
    provider: 'anthropic',
    call: vi.fn(async () => ({ output: { globalNotes: '', rows }, inputTokens: 1, outputTokens: 1, model: 'claude-test', provider: 'anthropic', costEstimateUsd: 0 }))
  } as unknown as LLMClient;
}

const CVES: CveRecord[] = [
  { id: 'CVE-1', severity: 'high', summary: 'Prototype pollution in template' },
  { id: 'CVE-2', severity: 'medium', summary: 'ReDoS in trim' }
];
const FILES = [{ relativePath: 'src/a.ts', windows: [{ startLine: 1, endLine: 2, code: 'import _ from "lodash";\n_.template(x);' }] }];
const BASE = { model: 'claude-test', depName: 'lodash', installedVersion: '4.17.21', cves: CVES, files: FILES, contextTruncated: false, approxContextTokens: 10 };

describe('J1 import-site ranking (cve-impact context)', () => {
  it('no hook → identical to today; hook reorders before the cap drops files', async () => {
    const dir = await tmpProject({
      'a.ts': `import x from 'dep';\n${'a'.repeat(50)}\n`,
      'b.ts': `import x from 'dep';\n${'b'.repeat(50)}\n`,
      'c.ts': `import x from 'dep';\n${'c'.repeat(50)}\n`
    });
    try {
      const plain = await extractImportSiteContext({ projectRoot: dir, depName: 'dep', importingFiles: ['a.ts', 'b.ts', 'c.ts'], maxTotalChars: 160 });
      expect(plain.files.map((f) => f.relativePath)).toEqual(['a.ts', 'b.ts']);
      const mock = new MockJudgeClient({ responder: () => ({ f0: { score: 0 }, f1: { score: 1 }, f2: { score: 4 } }) });
      const j = ctx(mock);
      const ranked = await extractImportSiteContext({
        projectRoot: dir,
        depName: 'dep',
        importingFiles: ['a.ts', 'b.ts', 'c.ts'],
        maxTotalChars: 160,
        rankFiles: async (files) => (await rankFilesJ1(j, { pkg: 'dep', from: '1.0.0', to: '2.0.0', files }))?.order ?? null
      });
      expect(ranked.files.map((f) => f.relativePath)).toEqual(['c.ts', 'b.ts']);
      expect(ranked.truncated).toBe(true);
      const keep = await extractImportSiteContext({ projectRoot: dir, depName: 'dep', importingFiles: ['a.ts', 'b.ts', 'c.ts'], maxTotalChars: 160, rankFiles: async () => null });
      expect(keep).toEqual(plain);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('J3 / J2 in runCveImpact', () => {
  it('LLM failure + J3 → rows estimated (Jev); without J3 → today all inconclusive', async () => {
    const today = await runCveImpact(failingClient(), BASE);
    expect(today.detail.rows.every((r) => r.verdict === 'inconclusive' && r.estimatedBy === undefined)).toBe(true);
    let i = 0;
    const picks = [{ choice: 'likely-affected', confidence: 0.9 }, { choice: 'not-affected', confidence: 0.8 }];
    const mock = new MockJudgeClient({ responder: () => ({ verdict: picks[i++] }) });
    const run = await runCveImpact(failingClient(), { ...BASE, jev: { j3: ctx(mock) } });
    expect(run.source).toBe('deterministic-partial');
    expect(run.detail.rows.map((r) => [r.verdict, r.estimatedBy])).toEqual([
      ['likely-affected', 'jev'],
      ['not-affected', 'jev']
    ]);
  });

  it('LLM success → J3 not used, output unchanged; J2 flags low support only', async () => {
    const rows = [
      { cveId: 'CVE-1', verdict: 'likely-affected', confidence: 'high', reasoning: 'calls template', citedFiles: ['src/a.ts'] },
      { cveId: 'CVE-2', verdict: 'not-affected', confidence: 'high', reasoning: 'no trim', citedFiles: [] }
    ];
    const plain = await runCveImpact(okCveClient(rows), BASE);
    const mock3 = new MockJudgeClient();
    const withJ3 = await runCveImpact(okCveClient(rows), { ...BASE, jev: { j3: ctx(mock3) } });
    expect(withJ3.detail).toEqual(plain.detail);
    expect(mock3.requests).toHaveLength(0);
    const mock2 = new MockJudgeClient({ responder: () => ({ supported: { noul: 0.1 } }) });
    const withJ2 = await runCveImpact(okCveClient(rows), { ...BASE, jev: { j2: ctx(mock2) } });
    expect(withJ2.detail.rows.map((r) => r.support)).toEqual(['low', undefined]);
    expect(withJ2.detail.rows).toHaveLength(2);
  });
});

describe('J6 in runRelatedUpgrade', () => {
  const rel = (name: string, reasons: RelatedDep['reasons']): RelatedDep => ({ name, installedVersion: '1.0.0', reasons, health: { deprecated: null, cveCount: null, maxCveSeverity: null, eol: null, ageDays: null } });
  const input = {
    model: 'claude-test',
    viewedDep: 'node',
    fromVersion: '18.16.0',
    toVersion: '24.13.0',
    relatedDeps: [rel('breaks', [{ kind: 'inbound-engine', range: '>=10 <20', satisfied: null }]), rel('mystery', [{ kind: 'naming', range: null, satisfied: null }])],
    relatedDetails: {}
  } as const;

  it('fallback: unknown dep gets the Jev suggestion (labelled); semver verdicts unchanged', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ a0: { choice: 'upgrade', confidence: 0.9 }, b0: { choice: 'major', confidence: 0.9 } }) });
    const run = await runRelatedUpgrade(failingClient(), { ...input, relatedDeps: [...input.relatedDeps], jev: ctx(mock) });
    const byName = Object.fromEntries(run.detail.recommendations.map((r) => [r.name, r]));
    expect(byName.mystery).toMatchObject({ action: 'upgrade', severity: 'major', suggestedBy: 'jev', deterministicVerdict: 'unknown' });
    expect(byName.breaks).toMatchObject({ action: 'investigate', deterministicVerdict: 'breaks' });
    expect(byName.breaks!.suggestedBy).toBeUndefined();
    // Only the unknown dep was sent.
    expect(JSON.stringify(mock.requests[0]!.state)).not.toContain('"breaks"');
  });

  it('flag off → today output', async () => {
    const a = await runRelatedUpgrade(failingClient(), { ...input, relatedDeps: [...input.relatedDeps] });
    const b = await runRelatedUpgrade(failingClient(), { ...input, relatedDeps: [...input.relatedDeps], jev: null });
    expect(b.detail).toEqual(a.detail);
  });
});

describe('J7 in queryCves', () => {
  const fetcher = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/v1/querybatch')) return new Response(JSON.stringify({ results: [{ vulns: [{ id: 'GHSA-a' }, { id: 'GHSA-b' }] }] }), { status: 200 });
    if (u.endsWith('GHSA-a')) return new Response(JSON.stringify({ id: 'GHSA-a', summary: 'Unknown sev', database_specific: {} }), { status: 200 });
    return new Response(JSON.stringify({ id: 'GHSA-b', summary: 'Known', database_specific: { severity: 'HIGH' } }), { status: 200 });
  };

  it('only `unknown` advisories are estimated; severity stays unknown', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ severity: { score: 3 } }) });
    const j = ctx(mock);
    const map = await queryCves([{ name: 'p', version: '1.0.0' }], { fetcher: fetcher as unknown as typeof fetch, estimateSeverity: async (v) => (await estimateSeverityJ7(j, v))?.band ?? null });
    const cves = map.get(keyFor('p', '1.0.0'))!;
    const a = cves.find((c) => c.id === 'GHSA-a')!;
    const b = cves.find((c) => c.id === 'GHSA-b')!;
    expect(a).toMatchObject({ severity: 'unknown', severityEstimated: 'critical' });
    expect(b.severityEstimated).toBeUndefined();
    expect(mock.requests).toHaveLength(1);
    const plain = await queryCves([{ name: 'p', version: '1.0.0' }], { fetcher: fetcher as unknown as typeof fetch });
    expect(plain.get(keyFor('p', '1.0.0'))!.every((c) => c.severityEstimated === undefined)).toBe(true);
  });
});

describe('J5 / J4 / J2 report helpers', () => {
  it('J5 adds suggestions without touching semver-derived candidates; off → same object', async () => {
    const directDeps = [{ name: 'react-dom', installedVersion: '17.0.2' }, { name: 'swr', installedVersion: '1.0.0' }];
    const base = computeCoUpgradeCandidates({ targetName: 'react', toVersion: '18.2.0', directDeps });
    const off = await addJevCoUpgrades(null, { target: 'react', from: '17.0.2', to: '18.2.0', directDeps, coUpgrade: base });
    expect(off.coUpgrade).toBe(base);
    const mock = new MockJudgeClient({ responder: () => ({ d0: { noul: 0.95 }, d1: { noul: 0.9 } }) });
    const on = await addJevCoUpgrades(ctx(mock), { target: 'react', from: '17.0.2', to: '18.2.0', directDeps, coUpgrade: base });
    expect(on.coUpgrade.sources['react-dom']).toEqual(base.sources['react-dom']);
    expect(on.coUpgrade.sources.swr).toEqual(['suggested-jev']);
    expect([...on.suggested]).toEqual(['swr']);
    const marked = markJevCoUpgrades({ coUpgradeDeps: [{ name: 'swr', currentVersion: '1.0.0', suggestedVersion: '', required: true, reason: 'common-pairing' as const, explanation: '' }] }, on.suggested);
    expect(marked.coUpgradeDeps[0]).toMatchObject({ reason: 'suggested-jev', required: false, explanation: 'suggested (Jev)' });
  });

  it('J4 adds Jev renames only for unmatched removed exports; seed lists them; off → unchanged seed', async () => {
    const diff: ApiDiffResult = {
      status: 'ok',
      pkg: 'react-dom',
      from: '17.0.2',
      to: '18.2.0',
      sources: { from: { package: 'react-dom', version: '17.0.2', entry: 'i.d.ts', via: 'own' }, to: { package: 'react-dom', version: '18.2.0', entry: 'i.d.ts', via: 'own' } },
      removed: [{ name: 'render', kind: 'function', signature: 'render(): void' }, { name: 'old', kind: 'function', signature: 'old(): void' }],
      signatureChanged: [],
      added: [{ name: 'createRoot', kind: 'function', signature: 'createRoot(): Root' }],
      renamedCandidate: [{ from: 'old', to: 'createRoot', confidence: 'low' }]
    };
    expect(await applyJevRenames(null, diff)).toBe(diff);
    const mock = new MockJudgeClient({ responder: () => ({ replacement: { choice: 'createRoot', confidence: 0.8 } }) });
    const out = await applyJevRenames(ctx(mock), diff);
    expect(mock.requests).toHaveLength(1);
    expect(out !== null && out.status === 'ok' && out.renamedCandidate).toEqual([...diff.renamedCandidate, { from: 'render', to: 'createRoot', confidence: 0.8, source: 'jev' }]);
    expect(apiDiffSeedLines(diff).join('\n')).not.toContain('Jev');
    expect(apiDiffSeedLines(out).join('\n')).toContain('likely renames (Jev');
  });

  it('J2 on the [D] report: badges, nothing removed; off → same detail', async () => {
    const dir = await tmpProject({ 'src/a.tsx': "import React from 'react';\nReact.render();\n" });
    try {
      const detail = {
        fromVersion: '17.0.2',
        toVersion: '18.2.0',
        summary: '',
        riskLevel: 'medium',
        resolverCheck: { kind: 'disabled', reason: 'kill-switch' },
        coUpgradeDeps: [],
        breakingChanges: [{ title: 'render removed', description: 'use createRoot', affectsFilesInProject: true }],
        filesToModify: [{ path: 'src/a.tsx', brief: 'uses render', estimatedChangeSize: 'small' }],
        recommendations: []
      } as UpdateReportDetail;
      expect(await applyReportEvidenceCheck(null, detail, { projectRoot: dir, depName: 'react', allowedFiles: new Set(['src/a.tsx']) })).toBe(detail);
      const mock = new MockJudgeClient({ responder: (r) => ({ supported: { noul: JSON.stringify(r.state).includes('render removed') ? 0.5 : 0.1 } }) });
      const out = await applyReportEvidenceCheck(ctx(mock), detail, { projectRoot: dir, depName: 'react', allowedFiles: new Set(['src/a.tsx']) });
      expect(out.filesToModify).toHaveLength(1);
      expect(out.filesToModify[0]!.support).toBe('low');
      expect(out.breakingChanges[0]!.support).toBe('unclear');
      expect(JSON.stringify(mock.requests[0]!.state)).toContain('React.render');
      // Private project: nothing sent, detail unchanged.
      const mockP = new MockJudgeClient();
      expect(await applyReportEvidenceCheck(ctx(mockP, { privacy: 'private' }), detail, { projectRoot: dir, depName: 'react', allowedFiles: new Set(['src/a.tsx']) })).toBe(detail);
      expect(mockP.requests).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('J2 [D] never reads or sends LLM paths outside the allowed set (../, absolute, .env, unknown) — review 5b M1', async () => {
    const outside = await tmpProject({ 'outside.ts': "import React from 'react';\nOUTSIDE_SENTINEL();\n" });
    const dir = await tmpProject({
      'src/a.tsx': "import React from 'react';\nReact.render();\n",
      '.env': "import React from 'react';\nENV_SENTINEL\n",
      'src/unlisted.ts': "import React from 'react';\nUNLISTED_SENTINEL();\n"
    });
    try {
      const abs = path.join(outside, 'outside.ts');
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      const detail = {
        fromVersion: '17.0.2',
        toVersion: '18.2.0',
        summary: '',
        riskLevel: 'medium',
        resolverCheck: { kind: 'disabled', reason: 'kill-switch' },
        coUpgradeDeps: [],
        breakingChanges: [{ title: 'render removed', description: 'use createRoot', affectsFilesInProject: true }],
        filesToModify: [
          { path: rel, brief: 'x', estimatedChangeSize: 'small' },
          { path: abs, brief: 'x', estimatedChangeSize: 'small' },
          { path: '.env', brief: 'x', estimatedChangeSize: 'small' },
          { path: 'src/../.env', brief: 'x', estimatedChangeSize: 'small' },
          { path: 'src/unlisted.ts', brief: 'x', estimatedChangeSize: 'small' },
          { path: 'src/a.tsx', brief: 'uses render', estimatedChangeSize: 'small' }
        ],
        recommendations: []
      } as UpdateReportDetail;
      const reads: string[] = [];
      const readFile = async (p: string) => {
        reads.push(p);
        return fs.readFile(p, 'utf8');
      };
      // Even a hostile allow-list entry ('.env', '../…') is refused by the guard's string checks.
      const allowedFiles = new Set(['src/a.tsx', '.env', rel]);
      const mock = new MockJudgeClient({ responder: () => ({ supported: { noul: 0.1 } }) });
      const out = await applyReportEvidenceCheck(ctx(mock), detail, { projectRoot: dir, depName: 'react', allowedFiles, readFile });
      expect(reads.map((r) => path.basename(r))).toEqual(['a.tsx']);
      const sent = JSON.stringify(mock.requests);
      for (const s of ['OUTSIDE_SENTINEL', 'ENV_SENTINEL', 'UNLISTED_SENTINEL', 'outside.ts', '.env', 'unlisted']) expect(sent).not.toContain(s);
      expect(sent).toContain('React.render');
      // One file claim (src/a.tsx) + one breaking-change claim.
      expect(mock.requests).toHaveLength(2);
      expect(out.filesToModify.map((f) => f.support ?? null)).toEqual([null, null, null, null, null, 'low']);
      expect(out.filesToModify).toHaveLength(6);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
