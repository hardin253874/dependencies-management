/**
 * Agent model factory (V2_STAGE4_SPEC 4a.6 / 4a.12).
 *
 * - `MOCK_LLM=true` → a `ScriptedAgentModel` loaded from
 *   `test-fixtures/agent/<scenario>.json`. The scenario id is
 *   `MOCK_AGENT_SCENARIO` when set, else the view (`update-report` /
 *   `deep-report`). Keyed by scenario, not prompt hash: multi-turn hashes are
 *   brittle (see test-fixtures/agent/README.md). A missing file throws
 *   `MOCK_LLM_NO_FIXTURE` naming the expected path.
 * - otherwise → `AnthropicAgentModel` with the configured key. No key → a
 *   model whose first turn throws `LLM_NO_API_KEY`, so the service takes its
 *   normal deterministic-partial path (same as v1).
 *
 * Tests can pin a model with `setAgentModelOverride` (on `globalThis`, CLAUDE.md
 * invariant #4) and MUST reset it with `setAgentModelOverride(null)`.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { ScriptedAgentModel, type AgentModel, type AgentScriptFile } from '@/core/agent/model';
import { LLMError } from '../llm/client';
import { AnthropicAgentModel } from '../llm/agentAnthropic';
import { loadEnv } from '../config';
import type { RunView } from './runStore';

declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_AGENT_MODEL_OVERRIDE__: AgentModel | undefined;
}

export function setAgentModelOverride(model: AgentModel | null): void {
  globalThis.__DEP_AGENT_AGENT_MODEL_OVERRIDE__ = model ?? undefined;
}

export function agentFixtureDir(): string {
  return path.resolve(process.cwd(), 'test-fixtures', 'agent');
}

const SCENARIO_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function loadAgentScript(scenario: string, dir: string = agentFixtureDir()): Promise<AgentScriptFile> {
  if (!SCENARIO_RE.test(scenario)) throw new LLMError('MOCK_LLM_NO_FIXTURE', `Invalid agent scenario id "${scenario}".`);
  const file = path.join(dir, `${scenario}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new LLMError('MOCK_LLM_NO_FIXTURE', `MOCK_LLM agent script missing for scenario "${scenario}". Add ${file} (see test-fixtures/agent/README.md).`);
  }
  const parsed = JSON.parse(raw) as AgentScriptFile;
  if (!Array.isArray(parsed.turns)) throw new LLMError('LLM_INVALID_RESPONSE', `Agent script ${file} has no "turns" array.`);
  return parsed;
}

class FailingAgentModel implements AgentModel {
  constructor(private readonly error: LLMError) {}
  async turn(): Promise<never> {
    throw this.error;
  }
}

export async function getAgentModel(view: RunView, opts: { maxRetries?: number } = {}): Promise<AgentModel> {
  const override = globalThis.__DEP_AGENT_AGENT_MODEL_OVERRIDE__;
  if (override !== undefined) return override;
  const env = loadEnv();
  if (env.mockLlm) {
    const scenario = process.env.MOCK_AGENT_SCENARIO?.trim() || view;
    try {
      return new ScriptedAgentModel((await loadAgentScript(scenario)).turns);
    } catch (err) {
      return new FailingAgentModel(err instanceof LLMError ? err : new LLMError('MOCK_LLM_NO_FIXTURE', (err as Error).message));
    }
  }
  if (env.anthropicApiKey === null) return new FailingAgentModel(new LLMError('LLM_NO_API_KEY', 'Anthropic API key not configured.'));
  return new AnthropicAgentModel({ apiKey: env.anthropicApiKey, maxRetries: opts.maxRetries });
}
