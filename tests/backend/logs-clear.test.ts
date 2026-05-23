/**
 * POST /api/logs/clear test (Stage 4, spec §7.7, §9.3).
 *
 * Verifies:
 *   - CSRF protection
 *   - Deletes contents of `library/_logs/`
 *   - Returns accurate filesRemoved + bytesRemoved
 *   - Idempotent (running again when empty returns zeros)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { logsDir } from '@/lib/paths';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { POST as logsClear } from '@/app/api/logs/clear/route';

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  sandbox = undefined;
});

function req(withCsrf = true): Request {
  const headers: Record<string, string> = {};
  if (withCsrf) headers[CSRF_HEADER] = getCsrfToken();
  return new Request('http://127.0.0.1/api/logs/clear', { method: 'POST', headers });
}

describe('POST /api/logs/clear', () => {
  it('rejects requests without X-Local-Token', async () => {
    sandbox = await createSandbox('logs-csrf');
    const r = await logsClear(req(false), {});
    expect(r.status).toBe(403);
  });

  it('returns zeros when logs/ does not exist', async () => {
    sandbox = await createSandbox('logs-empty');
    const r = await logsClear(req(), {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as { filesRemoved: number; bytesRemoved: number };
    expect(body.filesRemoved).toBe(0);
    expect(body.bytesRemoved).toBe(0);
  });

  it('removes every file inside logs/ and returns accurate counts', async () => {
    sandbox = await createSandbox('logs-with-files');
    const dir = logsDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'server.log'), 'hello world');
    await fs.writeFile(path.join(dir, 'old.log'), 'older content');
    const r = await logsClear(req(), {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as { filesRemoved: number; bytesRemoved: number };
    expect(body.filesRemoved).toBe(2);
    expect(body.bytesRemoved).toBe('hello world'.length + 'older content'.length);
    const remaining = await fs.readdir(dir);
    expect(remaining).toEqual([]);
  });

  it('is idempotent — second call returns zeros', async () => {
    sandbox = await createSandbox('logs-idempotent');
    const dir = logsDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'server.log'), 'x');
    await logsClear(req(), {});
    const r2 = await logsClear(req(), {});
    const body = (await r2.json()) as { filesRemoved: number; bytesRemoved: number };
    expect(body.filesRemoved).toBe(0);
    expect(body.bytesRemoved).toBe(0);
  });
});
