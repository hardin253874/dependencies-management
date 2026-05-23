/**
 * Cache-key unit test (spec §11.10, plan Stage 3).
 *
 *  - Same input → same hash (deterministic).
 *  - Prompt change → different hash.
 *  - Model change → different hash.
 *  - Tool change → different hash.
 *  - Sort-order of schema keys does NOT matter (canonical JSON).
 */
import { describe, it, expect } from 'vitest';
import { computeCacheKey, canonicalJsonStringify } from '@/lib/llm/cacheKey';
import type { ToolSchema } from '@/lib/llm/client';

const BASE_TOOL: ToolSchema = {
  name: 'submit_test',
  description: 'Test tool',
  inputSchema: {
    type: 'object',
    properties: {
      foo: { type: 'string' },
      bar: { type: 'integer' }
    },
    required: ['foo']
  }
};

describe('computeCacheKey', () => {
  it('returns the same hash for identical inputs', () => {
    const a = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'user', tool: BASE_TOOL, model: 'm1' });
    const b = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'user', tool: BASE_TOOL, model: 'm1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different hash when the user prompt changes', () => {
    const a = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'A', tool: BASE_TOOL, model: 'm1' });
    const b = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'B', tool: BASE_TOOL, model: 'm1' });
    expect(a).not.toBe(b);
  });

  it('produces a different hash when the system prompt changes', () => {
    const a = computeCacheKey({ systemPrompt: 'sysA', userPrompt: 'u', tool: BASE_TOOL, model: 'm1' });
    const b = computeCacheKey({ systemPrompt: 'sysB', userPrompt: 'u', tool: BASE_TOOL, model: 'm1' });
    expect(a).not.toBe(b);
  });

  it('produces a different hash when the model changes', () => {
    const a = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'u', tool: BASE_TOOL, model: 'm1' });
    const b = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'u', tool: BASE_TOOL, model: 'm2' });
    expect(a).not.toBe(b);
  });

  it('produces a different hash when the tool schema changes', () => {
    const altered: ToolSchema = {
      ...BASE_TOOL,
      inputSchema: {
        type: 'object',
        properties: { foo: { type: 'string' }, bar: { type: 'string' } }
      }
    };
    const a = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'u', tool: BASE_TOOL, model: 'm1' });
    const b = computeCacheKey({ systemPrompt: 'sys', userPrompt: 'u', tool: altered, model: 'm1' });
    expect(a).not.toBe(b);
  });
});

describe('canonicalJsonStringify', () => {
  it('sorts keys deterministically across the whole tree', () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJsonStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });
});
