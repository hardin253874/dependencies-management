/**
 * Interactive setup script (`npm run setup`) — spec §5.1, §5.2.
 *
 * Plain ESM JavaScript so it runs under any Node ≥18 without transpilation.
 * The TypeScript helpers in src/lib/storage/envFile.ts are re-implemented here
 * verbatim (small, no need for sharing) so this script has zero compile step.
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const TOKEN_BUDGET_KEYS = [
  'TOKEN_BUDGET_FILE_REVIEW_IN',
  'TOKEN_BUDGET_FILE_REVIEW_OUT',
  'TOKEN_BUDGET_UPDATE_REPORT_IN',
  'TOKEN_BUDGET_UPDATE_REPORT_OUT',
  'TOKEN_BUDGET_DEEP_REPORT_IN',
  'TOKEN_BUDGET_DEEP_REPORT_OUT'
];

const TOKEN_BUDGET_DEFAULTS = {
  TOKEN_BUDGET_FILE_REVIEW_IN: '30000',
  TOKEN_BUDGET_FILE_REVIEW_OUT: '4000',
  TOKEN_BUDGET_UPDATE_REPORT_IN: '10000',
  TOKEN_BUDGET_UPDATE_REPORT_OUT: '6000',
  TOKEN_BUDGET_DEEP_REPORT_IN: '100000',
  TOKEN_BUDGET_DEEP_REPORT_OUT: '8000'
};

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-5' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true }
};

function parseEnv(text) {
  const out = {};
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

function serializeEnv(values, preserve = '') {
  const lines = preserve.split(/\r?\n/);
  const seen = new Set();
  const out = [];
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
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return `${out.join('\n')}\n`;
}

async function readRawEnv() {
  try {
    return await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return '';
  }
}

async function writeEnvFile(existingRaw, updates) {
  const merged = { ...parseEnv(existingRaw), ...updates };
  const serialized = serializeEnv(merged, existingRaw);
  const target = path.join(REPO_ROOT, '.env');
  await fs.writeFile(target, serialized, { encoding: 'utf8' });
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(target, 0o600);
    } catch {
      // best-effort
    }
  }
}

async function readMaybeJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeConfig(cfg) {
  const libRoot = path.join(REPO_ROOT, 'library');
  await fs.mkdir(libRoot, { recursive: true });
  const target = path.join(libRoot, '_config.json');
  const tmp = `${target}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
}

async function yesNo(rl, prompt, defaultYes) {
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  if (answer.startsWith('y')) return true;
  if (answer.startsWith('n')) return false;
  return defaultYes;
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    output.write('Dependencies Management Agent — first-time setup\n');
    output.write('--------------------------------------------------\n\n');

    const existingRaw = await readRawEnv();
    const existing = parseEnv(existingRaw);

    // v2: Anthropic is the only provider. An existing OPENAI_API_KEY line in
    // .env is left alone (writeEnvFile only touches the keys it is given).
    const keyUpdates = {};
    const envKey = 'ANTHROPIC_API_KEY';
    const current = existing[envKey];
    const keep =
      current !== undefined &&
      current !== '' &&
      (await yesNo(rl, `Existing ${envKey} present (length ${current.length}). Keep it? (Y/n) `, true));
    if (!keep) {
      const value = await rl.question('Enter Anthropic API key: ');
      keyUpdates[envKey] = value.trim();
    }

    const advanced = await yesNo(
      rl,
      'Configure token budgets? (advanced; defaults are fine for most users) (y/N) ',
      false
    );
    if (advanced) {
      for (const key of TOKEN_BUDGET_KEYS) {
        const current = existing[key] ?? TOKEN_BUDGET_DEFAULTS[key];
        const answer = await rl.question(`${key} [${current}]: `);
        const trimmed = answer.trim();
        if (trimmed !== '') keyUpdates[key] = trimmed;
      }
    }

    if (existing.LOG_LEVEL === undefined && keyUpdates.LOG_LEVEL === undefined) {
      keyUpdates.LOG_LEVEL = 'info';
    }
    if (existing.MOCK_LLM === undefined && keyUpdates.MOCK_LLM === undefined) {
      keyUpdates.MOCK_LLM = 'false';
    }

    await writeEnvFile(existingRaw, keyUpdates);

    const existingConfig = await readMaybeJson(path.join(REPO_ROOT, 'library', '_config.json'));
    const cfg = existingConfig !== null ? existingConfig : JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    // A v1 config with provider 'openai' is migrated by the server on the
    // first GET /api/config (one-time notice), so it is not rewritten here.
    await writeConfig(cfg);

    output.write('\n');
    output.write(`Wrote ${path.join(REPO_ROOT, '.env')}\n`);
    output.write(`Wrote ${path.join(REPO_ROOT, 'library', '_config.json')}\n`);
    output.write('\nNext: `npm run build && npm start`\n');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  output.write(`Setup failed: ${err.message}\n`);
  process.exit(1);
});
