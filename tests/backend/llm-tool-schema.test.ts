/**
 * LLM tool-schema adapter unit test (spec §11.2, plan Stage 3).
 *
 * Asserts the provider-agnostic `ToolSchema` renders to a valid Anthropic
 * `input_schema` (v2: OpenAI removed, its shape tests were deleted).
 */
import { describe, it, expect } from 'vitest';
import { translateTool as translateAnthropic } from '@/lib/llm/anthropic';
import { FILE_REVIEW_TOOL_SCHEMA } from '@/lib/llm/prompts/file-review';
import { UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';

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
