/**
 * Server boot hooks (spec §5.2, §10.7).
 *
 * Runs once per server process. Called lazily from the first route handler that
 * needs it. Idempotent — repeated calls are no-ops after the first success.
 *
 * Steps:
 *   1. .env / .env.example reconciliation surfacing (logs a warning when a
 *      required key is missing for the active provider). In Stage 1 the actual
 *      interactive prompt happens in the setup script, not the running server.
 *   2. Boot-time temp sandbox sweep — removes orphans older than 1h.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { agentRepoRoot, logsDir } from './paths';
import { sweepTempSandboxes } from './jobs/tempSweep';
import { parseEnv } from './storage/envFile';
import { readConfig } from './storage/config';
import { requiredKeysForProvider } from './config';

let booted: Promise<void> | null = null;

export async function ensureBooted(): Promise<void> {
  if (booted !== null) return booted;
  booted = runBoot();
  return booted;
}

async function runBoot(): Promise<void> {
  await fs.mkdir(logsDir(), { recursive: true }).catch(() => undefined);
  await sweepTempSandboxes().catch(() => undefined);
  await reconcileEnv().catch(() => undefined);
}

interface ReconciliationResult {
  missingRequired: string[];
  missingOptional: string[];
}

export async function reconcileEnv(): Promise<ReconciliationResult> {
  const envExample = await readMaybe(path.join(agentRepoRoot(), '.env.example'));
  const envFile = await readMaybe(path.join(agentRepoRoot(), '.env'));
  const exampleKeys = Object.keys(parseEnv(envExample));
  const presentKeys = new Set(Object.keys(parseEnv(envFile)));

  const cfg = await readConfig();
  const required = new Set(requiredKeysForProvider(cfg.llm.provider));
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  for (const key of exampleKeys) {
    if (presentKeys.has(key)) continue;
    if (required.has(key)) missingRequired.push(key);
    else missingOptional.push(key);
  }
  return { missingRequired, missingOptional };
}

async function readMaybe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Test hook — reset the boot state. */
export function resetBoot(): void {
  booted = null;
}
