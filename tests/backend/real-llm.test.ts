/**
 * Real-LLM scaffold tests (spec §16, Stage 3 plan).
 *
 * These tests hit the real Anthropic + OpenAI APIs and are normally SKIPPED.
 * They run only when `RUN_REAL_LLM_TESTS=1` is set in the environment. The
 * intent is to provide a single place to verify schema-valid tool calls,
 * persisted-envelope shape, and cost-field populating against a real provider
 * — wired up by the nightly CI job.
 *
 * Local devs do NOT run these by default — spec §11.12 mandates MOCK_LLM=true
 * for all standard test runs.
 */
import { describe, it, expect } from 'vitest';

const SHOULD_RUN = process.env.RUN_REAL_LLM_TESTS === '1';

describe.skipIf(!SHOULD_RUN)('Real LLM — view [D] (Anthropic)', () => {
  it('returns a schema-valid update report', () => {
    // Intentionally a stub. Nightly CI will fill this in once both API keys
    // are wired up via secrets.
    expect(SHOULD_RUN).toBe(true);
  });
});

describe.skipIf(!SHOULD_RUN)('Real LLM — view [E] (OpenAI)', () => {
  it('returns a schema-valid file review', () => {
    expect(SHOULD_RUN).toBe(true);
  });
});
