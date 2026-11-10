import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { createSmallNpmProject, routeCtx } from '../helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { projectDir, runFilePath, runsDir } from '@/lib/paths';
import { newRunId, readRunRecord, writeRunRecord, RunRecordError, type AgentRunRecord } from '@/lib/agent/runStore';
import { computeLibrarySize } from '@/lib/storage/size';
import { DELETE as deleteProject } from '@/app/api/projects/[slug]/route';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

function record(over: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: newRunId(new Date('2026-11-10T00:00:00Z')),
    trigger: 'user',
    view: 'update-report',
    dep: 'axios',
    from: '0.27.2',
    to: '1.6.8',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    budgets: { maxToolCalls: 20, maxInputTokens: 400_000, maxOutputTokens: 16_000, maxWallMs: 180_000, maxUsd: 1, perTurnMaxTokens: 8_000 },
    status: 'submitted',
    stopDetail: { reason: 'submitted', message: 'ok' },
    finalTurnReason: null,
    startedAt: '2026-11-10T00:00:00.000Z',
    durationMs: 1234,
    usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, requests: 2, toolCalls: 1 },
    costUsd: 0.01,
    trace: { calls: [{ turn: 1, tool: 'graph_summary', inputSummary: '{}', durationMs: 3, resultBytes: 10, truncated: false, isError: false }], turns: [] },
    graphBuiltAt: '2026-11-10T00:00:00.000Z',
    resultRef: null,
    droppedPaths: 0,
    ...over
  };
}

describe('run store (4a.8)', () => {
  it('write/read round trip as an envelope under library/<slug>/runs/', async () => {
    sandbox = await createSandbox('run-store');
    const r = record();
    const env = await writeRunRecord('proj', r);
    expect(env.source).toBe('anthropic:claude-sonnet-5-5');
    expect(existsSync(runFilePath('proj', r.runId))).toBe(true);
    const back = await readRunRecord('proj', r.runId);
    expect(back.data).toEqual(r);
    expect(back.ttlHours).toBeNull();
    expect(existsSync(`${projectDir('proj')}/memory`)).toBe(false);
  });

  it('rejects trigger "schedule" (v2 accepts only "user") and bad run ids', async () => {
    sandbox = await createSandbox('run-store-trigger');
    await expect(writeRunRecord('proj', record({ trigger: 'schedule' as never }))).rejects.toThrow(RunRecordError);
    await expect(writeRunRecord('proj', record({ runId: '../x' }))).rejects.toThrow(/invalid runId/);
    await expect(readRunRecord('proj', '..\\x')).rejects.toThrow(/invalid runId/);
    expect(existsSync(runsDir('proj'))).toBe(false);
  });

  it('library size counts runs; deleting the project with its data removes them', async () => {
    sandbox = await createSandbox('run-store-size');
    const dir = await sandbox.scratch('app');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) throw new Error(add.error.code);
    await writeRunRecord(add.slug, record());
    const size = await computeLibrarySize();
    expect(size.byKind.runs).toBeGreaterThan(0);

    const res = await deleteProject(
      new Request(`http://127.0.0.1/api/projects/${add.slug}?deleteData=true`, { method: 'DELETE', headers: { [CSRF_HEADER]: getCsrfToken() } }),
      routeCtx({ slug: add.slug })
    );
    expect(res.status).toBeLessThan(300);
    expect(existsSync(runsDir(add.slug))).toBe(false);
  });
});
