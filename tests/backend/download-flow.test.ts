/**
 * Download endpoint integration tests (Stage 4, spec §9.3).
 *
 * Covers:
 *   - 404 NOT_CACHED when no underlying report
 *   - 200 with markdown when format=md
 *   - 200 with HTML when format=html
 *   - 400 INVALID_FORMAT for unknown format
 *   - both [D] and [D-Deep] paths
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { writeEnvelope } from '@/lib/storage/envelope';
import { reportFilePath, deepReportFilePath } from '@/lib/paths';
import type { DeepUpdateReportDetail, UpdateReportDetail } from '@/lib/api-types';

import { GET as downloadReport } from '@/app/api/projects/[slug]/reports/[name]/[from]/[to]/download/route';
import { GET as downloadDeepReport } from '@/app/api/projects/[slug]/deep-reports/[name]/[from]/[to]/download/route';

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  sandbox = undefined;
});

function req(url: string): Request {
  return new Request(url, { method: 'GET' });
}

const FIXTURE_REPORT: UpdateReportDetail = {
  fromVersion: '18.3.1',
  toVersion: '19.0.0',
  summary: 'Sample summary.',
  riskLevel: 'medium',
  resolverCheck: { kind: 'enabled', wouldResolve: true, conflicts: [], legacyPeerDepsUsed: false },
  coUpgradeDeps: [],
  breakingChanges: [],
  filesToModify: [],
  recommendations: []
};

const FIXTURE_DEEP_BASE: Omit<DeepUpdateReportDetail, 'lockfileStateHashShort'> = {
  fromVersion: '17.0.2',
  toVersion: '19.0.0',
  summary: 'Deep summary.',
  riskLevel: 'high',
  narrative: 'Narrative content.',
  estimatedEffort: 'large',
  lockfileSummary: { totalPackages: 100, packagesByDirectDep: {}, peerDepsOnTarget: [] },
  transitiveDelta: { packagesAdded: [], packagesRemoved: [], packagesUpgraded: [] },
  cveDelta: { newCves: [], resolvedCves: [] },
  criticalBlockers: [],
  suggestedUpgradeOrder: [],
  resolverCheck: { kind: 'disabled', reason: 'failure', failureMessage: 'test' },
  coUpgradeDeps: []
};

describe('GET /api/projects/:slug/reports/:name/:from/:to/download', () => {
  it('returns 404 NOT_CACHED when the report has not been generated', async () => {
    sandbox = await createSandbox('download-d-not-cached');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    const r = await downloadReport(req('http://x/?format=md'), {
      params: { slug: result.slug, name: 'react', from: '18.3.1', to: '19.0.0' }
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_CACHED');
  });

  it('returns markdown with proper content-type when format=md', async () => {
    sandbox = await createSandbox('download-d-md');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    await writeEnvelope<UpdateReportDetail>(
      reportFilePath(result.slug, 'react', '18.3.1', '19.0.0'),
      { source: 'anthropic:test', ttlHours: null, data: FIXTURE_REPORT }
    );

    const r = await downloadReport(req('http://x/?format=md'), {
      params: { slug: result.slug, name: 'react', from: '18.3.1', to: '19.0.0' }
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toContain('text/markdown');
    expect(r.headers.get('Content-Disposition')).toContain('attachment');
    const body = await r.text();
    expect(body).toContain('# Update Report — react');
    expect(body).toContain('**Upgrade:** 18.3.1 → 19.0.0');
  });

  it('returns HTML when format=html', async () => {
    sandbox = await createSandbox('download-d-html');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    await writeEnvelope<UpdateReportDetail>(
      reportFilePath(result.slug, 'react', '18.3.1', '19.0.0'),
      { source: 'anthropic:test', ttlHours: null, data: FIXTURE_REPORT }
    );

    const r = await downloadReport(req('http://x/?format=html'), {
      params: { slug: result.slug, name: 'react', from: '18.3.1', to: '19.0.0' }
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toContain('text/html');
    const body = await r.text();
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('<h1>Update Report — react</h1>');
  });

  it('rejects unknown formats with 400 INVALID_FORMAT', async () => {
    sandbox = await createSandbox('download-d-bad-format');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    const r = await downloadReport(req('http://x/?format=pdf'), {
      params: { slug: result.slug, name: 'react', from: '18.3.1', to: '19.0.0' }
    });
    expect(r.status).toBe(400);
  });

  it('rejects path-traversal version param `..`', async () => {
    sandbox = await createSandbox('download-d-traverse');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    const r = await downloadReport(req('http://x/?format=md'), {
      params: { slug: result.slug, name: 'react', from: '..', to: '19.0.0' }
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_VERSION');
  });
});

describe('GET /api/projects/:slug/deep-reports/:name/:from/:to/download', () => {
  it('returns 404 NOT_CACHED when no deep report exists', async () => {
    sandbox = await createSandbox('download-deep-not-cached');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    const r = await downloadDeepReport(req('http://x/?format=md'), {
      params: { slug: result.slug, name: 'react', from: '17.0.2', to: '19.0.0' }
    });
    expect(r.status).toBe(404);
  });

  it('returns markdown when the deep report exists', async () => {
    sandbox = await createSandbox('download-deep-md');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    const hashShort = result.projectJson.lockfileStateHash.slice(0, 5);
    await writeEnvelope<DeepUpdateReportDetail>(
      deepReportFilePath(result.slug, 'react', '17.0.2', '19.0.0', hashShort),
      {
        source: 'anthropic:test',
        ttlHours: null,
        data: { ...FIXTURE_DEEP_BASE, lockfileStateHashShort: hashShort }
      }
    );
    const r = await downloadDeepReport(req('http://x/?format=md'), {
      params: { slug: result.slug, name: 'react', from: '17.0.2', to: '19.0.0' }
    });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('# Deep Update Report — react');
  });

  it('returns 404 when the lockfile state hash has changed (filename suffix differs)', async () => {
    sandbox = await createSandbox('download-deep-stale-hash');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    // Persist under a DIFFERENT short hash than the project's current one.
    await writeEnvelope<DeepUpdateReportDetail>(
      deepReportFilePath(result.slug, 'react', '17.0.2', '19.0.0', 'xxxxx'),
      {
        source: 'anthropic:test',
        ttlHours: null,
        data: { ...FIXTURE_DEEP_BASE, lockfileStateHashShort: 'xxxxx' }
      }
    );
    const r = await downloadDeepReport(req('http://x/?format=md'), {
      params: { slug: result.slug, name: 'react', from: '17.0.2', to: '19.0.0' }
    });
    expect(r.status).toBe(404);
  });
});
