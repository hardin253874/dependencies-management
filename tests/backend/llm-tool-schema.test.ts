/**
 * LLM tool-schema adapter unit test (spec §11.2, plan Stage 3).
 *
 * Asserts the same provider-agnostic `ToolSchema` renders to a valid
 * Anthropic `input_schema` AND a valid OpenAI `parameters` payload.
 */
import { describe, it, expect } from 'vitest';
import { translateTool as translateAnthropic } from '@/lib/llm/anthropic';
import { translateTool as translateOpenAI } from '@/lib/llm/openai';
import { FILE_REVIEW_TOOL_SCHEMA } from '@/lib/llm/prompts/file-review';
import { UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';
import type { ToolSchema } from '@/lib/llm/client';

function assertObjectSchema(value: unknown): asserts value is { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  expect(value).toBeTypeOf('object');
  const obj = value as Record<string, unknown>;
  expect(obj.type).toBe('object');
  expect(obj.properties).toBeTypeOf('object');
}

describe('ToolSchema adapter — Anthropic shape', () => {
  it('FILE_REVIEW_TOOL_SCHEMA produces a valid Anthropic input_schema', () => {
    const out = translateAnthropic(FILE_REVIEW_TOOL_SCHEMA);
    expect(out.name).toBe(FILE_REVIEW_TOOL_SCHEMA.name);
    expect(out.description).toBe(FILE_REVIEW_TOOL_SCHEMA.description);
    assertObjectSchema(out.input_schema);
    const props = (out.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.summary).toBeDefined();
    expect(props.findings).toBeDefined();
  });

  it('UPDATE_REPORT_TOOL_SCHEMA produces a valid Anthropic input_schema', () => {
    const out = translateAnthropic(UPDATE_REPORT_TOOL_SCHEMA);
    assertObjectSchema(out.input_schema);
  });
});

describe('ToolSchema adapter — OpenAI shape', () => {
  it('FILE_REVIEW_TOOL_SCHEMA produces a valid OpenAI parameters payload', () => {
    const out = translateOpenAI(FILE_REVIEW_TOOL_SCHEMA);
    expect(out.type).toBe('function');
    expect(out.function.name).toBe(FILE_REVIEW_TOOL_SCHEMA.name);
    expect(out.function.description).toBe(FILE_REVIEW_TOOL_SCHEMA.description);
    assertObjectSchema(out.function.parameters);
  });

  it('UPDATE_REPORT_TOOL_SCHEMA produces a valid OpenAI parameters payload', () => {
    const out = translateOpenAI(UPDATE_REPORT_TOOL_SCHEMA);
    expect(out.type).toBe('function');
    assertObjectSchema(out.function.parameters);
  });
});

describe('ToolSchema cross-provider parity', () => {
  it('preserves the same property keys between Anthropic and OpenAI', () => {
    const schemas: ToolSchema[] = [FILE_REVIEW_TOOL_SCHEMA, UPDATE_REPORT_TOOL_SCHEMA];
    for (const tool of schemas) {
      const a = translateAnthropic(tool).input_schema as { properties: Record<string, unknown> };
      const o = translateOpenAI(tool).function.parameters as { properties: Record<string, unknown> };
      expect(Object.keys(a.properties).sort()).toEqual(Object.keys(o.properties).sort());
    }
  });
});
