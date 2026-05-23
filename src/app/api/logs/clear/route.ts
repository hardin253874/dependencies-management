/**
 * POST /api/logs/clear — empties `library/_logs/` (spec §7.7, §9.3).
 *
 * Removes every file inside the logs directory but leaves the directory itself
 * in place so pino can keep appending. Returns `{ filesRemoved, bytesRemoved }`
 * so the UI can confirm what was deleted.
 *
 * CSRF-protected.
 */
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { withCsrf } from '@/lib/http/guards';
import { internalError } from '@/lib/http/errors';
import { logsDir } from '@/lib/paths';
import type { LogsClearResponse } from '@/lib/api-types';

export const POST = withCsrf<unknown>(async () => {
  try {
    const dir = logsDir();
    let filesRemoved = 0;
    let bytesRemoved = 0;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return NextResponse.json<LogsClearResponse>({ filesRemoved: 0, bytesRemoved: 0 });
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(full);
        bytesRemoved += stat.size;
      } catch {
        // ignore — file may have disappeared between readdir and stat
      }
      try {
        await fs.unlink(full);
        filesRemoved += 1;
      } catch {
        // ignore — best-effort
      }
    }
    return NextResponse.json<LogsClearResponse>({ filesRemoved, bytesRemoved });
  } catch (err) {
    return internalError('LOGS_CLEAR_FAILED', (err as Error).message);
  }
});
