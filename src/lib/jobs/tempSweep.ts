/**
 * Boot-time temp sweep (spec §10.7 / G31).
 *
 * Removes orphaned entries under `os.tmpdir()/dep-agent/` that are older than
 * a threshold (default 1 hour). Catches crashes from prior resolver runs.
 *
 * Safe to call multiple times; failures are logged but never thrown.
 */
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

export const DEP_AGENT_TEMP_DIRNAME = 'dep-agent';

export function depAgentTempRoot(): string {
  return path.join(os.tmpdir(), DEP_AGENT_TEMP_DIRNAME);
}

export interface SweepResult {
  removed: string[];
  kept: string[];
  errors: Array<{ path: string; message: string }>;
}

export async function sweepTempSandboxes(maxAgeMs: number = 3_600_000): Promise<SweepResult> {
  const root = depAgentTempRoot();
  const result: SweepResult = { removed: [], kept: [], errors: [] };

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return result; // root doesn't exist; nothing to do
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const full = path.join(root, name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true });
        result.removed.push(full);
      } else {
        result.kept.push(full);
      }
    } catch (err) {
      result.errors.push({ path: full, message: (err as Error).message });
    }
  }
  return result;
}
