/**
 * Read/write the agent's `.env` file. Per spec §5.5:
 *   - `.env` is chmod 600 on Unix after first write (best-effort on Windows).
 *   - The setup script is the canonical authority for which keys exist; this
 *     helper preserves unknown keys when patching.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { agentRepoRoot } from '../paths';

function envPath(): string {
  return path.join(agentRepoRoot(), '.env');
}

async function readRaw(): Promise<string> {
  try {
    return await fs.readFile(envPath(), 'utf8');
  } catch {
    return '';
  }
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function serializeEnv(values: Record<string, string>, preserve = ''): string {
  // Strategy: keep existing key positions when present in `preserve`; append new keys at the end.
  const lines = preserve.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      out.push(`${key}=${values[key] ?? ''}`);
      seen.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(values)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  // Strip trailing blank lines, end with one newline.
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return `${out.join('\n')}\n`;
}

export async function readEnvFile(): Promise<Record<string, string>> {
  const raw = await readRaw();
  return parseEnv(raw);
}

export async function writeEnvFile(updates: Record<string, string>): Promise<void> {
  const raw = await readRaw();
  const serialized = serializeEnv({ ...parseEnv(raw), ...updates }, raw);
  const target = envPath();
  await fs.writeFile(target, serialized, { encoding: 'utf8' });
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(target, 0o600);
    } catch {
      // best-effort
    }
  }
}
