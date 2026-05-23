/**
 * Atomic file write via temp-file + fsync + rename (spec §8.4).
 *
 * Windows note: fs.rename uses MoveFileExW under the hood with REPLACE_EXISTING
 * semantics in Node ≥14, which gives us crash-safe overwrites. The .tmp suffix
 * uses a random nonce so concurrent writers don't collide.
 *
 * Windows rename race: when two writers rename to the same destination at the
 * same time, the OS can return EPERM/EBUSY/EACCES because the file is briefly
 * held by the other rename (or by a virus scanner). We retry on those codes
 * with quadratic backoff. This is the standard atomic-write-on-Windows pattern.
 */
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
  let lastError: NodeJS.ErrnoException | null = null;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === undefined || !RENAME_RETRYABLE_CODES.has(e.code)) {
        throw err;
      }
      lastError = e;
      if (attempt === RENAME_RETRY_ATTEMPTS - 1) break;
      const delayMs = 10 * (attempt + 1) ** 2; // 10, 40, 90, 160ms
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // After exhausting retries, attempt to clean up the temp file (best-effort)
  // so we don't leave .tmp residue, then surface the original error.
  try {
    await fs.unlink(tmpPath);
  } catch {
    // ignore — the temp file may have been swept by another writer's rename
  }
  throw lastError ?? new Error(`rename failed after ${RENAME_RETRY_ATTEMPTS} attempts`);
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const nonce = crypto.randomBytes(6).toString('hex');
  const tmpPath = `${filePath}.${nonce}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;

  let fh: FileHandle | null = null;
  try {
    fh = await fs.open(tmpPath, 'w');
    await fh.writeFile(content, { encoding: 'utf8' });
    await fh.sync();
  } finally {
    if (fh !== null) await fh.close();
  }

  await renameWithRetry(tmpPath, filePath);
}

export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const nonce = crypto.randomBytes(6).toString('hex');
  const tmpPath = `${filePath}.${nonce}.tmp`;

  let fh: FileHandle | null = null;
  try {
    fh = await fs.open(tmpPath, 'w');
    await fh.writeFile(content, { encoding: 'utf8' });
    await fh.sync();
  } finally {
    if (fh !== null) await fh.close();
  }

  await renameWithRetry(tmpPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
