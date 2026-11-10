import { describe, it, expect } from 'vitest';
import { createToolRegistry, toAnthropicTools, truncateToolResult, TRUNCATION_MARKER, checkTerminalTools } from '@/core/agent/registry';
import { ToolError, ToolRegistrationError, type AgentToolDef, type ToolContext } from '@/core/agent/types';
import type { GraphDriver } from '@/core/graph/store';
import { UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';
import { createReadToolRegistry } from '@/core/agent/tools';
import { UPDATE_REPORT_TERMINAL } from '@/lib/llm/agentReportService';
import { DEEP_REPORT_TERMINAL } from '@/lib/llm/agentDeepReportService';

function def(over: Partial<AgentToolDef> = {}): AgentToolDef {
  return {
    name: 'echo_tool',
    description: 'Echo.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pkg'],
      properties: {
        pkg: { type: 'string' },
        mode: { type: 'string', enum: ['a', 'b'] },
        depth: { type: 'integer', minimum: 0, maximum: 5 },
        files: { type: 'array', items: { type: 'string' }, maxItems: 2 }
      }
    },
    handler: (_ctx, input) => ({ got: input }),
    ...over
  };
}

const ctx: ToolContext = {
  workspaceRoot: 'C:\\work\\proj',
  graph: {} as GraphDriver,
  intel: {},
  limits: { maxResultBytes: 16 * 1024 }
};

describe('createToolRegistry — registration guard (4a.1)', () => {
  it.each(['write', 'execute'] as const)('refuses a %s tool', (capability) => {
    expect(() => createToolRegistry([def({ capability })])).toThrow(ToolRegistrationError);
    expect(() => createToolRegistry([def({ capability })])).toThrow(/echo_tool/);
  });

  it('refuses a duplicate name and a non-snake_case name', () => {
    expect(() => createToolRegistry([def(), def()])).toThrow(/duplicate/);
    expect(() => createToolRegistry([def({ name: 'EchoTool' })])).toThrow(/snake_case/);
  });

  it('refuses schemas outside the strict subset', () => {
    const noAdditional = def({ inputSchema: { type: 'object', properties: { a: { type: 'string' } } } });
    expect(() => createToolRegistry([noAdditional])).toThrow(/additionalProperties/);
    const badRequired = def({ inputSchema: { type: 'object', additionalProperties: false, required: ['x'], properties: {} } });
    expect(() => createToolRegistry([badRequired])).toThrow(/required "x"/);
    const nested = def({
      inputSchema: { type: 'object', additionalProperties: false, properties: { o: { type: 'object', properties: {} } } }
    });
    expect(() => createToolRegistry([nested])).toThrow(/input\.o: additionalProperties/);
  });

  it('accepts the v1 terminal schema', () => {
    expect(() => checkTerminalTools([UPDATE_REPORT_TOOL_SCHEMA])).not.toThrow();
  });
});

describe('registry.call — input validation and errors (4a.1)', () => {
  const reg = createToolRegistry([
    def(),
    def({ name: 'boom', handler: () => { throw new Error('ENOENT: no such file C:\\work\\proj\\src\\x.ts and C:\\Users\\me\\secret.txt'); } }),
    def({ name: 'tool_err', handler: () => { throw new ToolError('package not found'); } })
  ]);

  it.each([
    ['nope', { pkg: 'x' }, 'Unknown tool "nope".'],
    ['echo_tool', {}, 'Invalid input for echo_tool: input.pkg is required'],
    ['echo_tool', { pkg: 1 }, 'Invalid input for echo_tool: input.pkg must be a string'],
    ['echo_tool', { pkg: 'x', mode: 'c' }, 'Invalid input for echo_tool: input.mode must be one of: a, b'],
    ['echo_tool', { pkg: 'x', depth: 9 }, 'Invalid input for echo_tool: input.depth must be <= 5'],
    ['echo_tool', { pkg: 'x', depth: 1.5 }, 'Invalid input for echo_tool: input.depth must be an integer'],
    ['echo_tool', { pkg: 'x', files: ['a', 'b', 'c'] }, 'Invalid input for echo_tool: input.files must have at most 2 items'],
    ['echo_tool', { pkg: 'x', extra: 1 }, 'Invalid input for echo_tool: input.extra is not allowed'],
    ['echo_tool', 'not-an-object', 'Invalid input for echo_tool: input must be an object']
  ])('%s %j → stable isError text', async (name, input, message) => {
    expect(await reg.call(name, input, ctx)).toEqual({ content: message, truncated: false, isError: true });
  });

  it('valid input reaches the handler and is JSON-encoded', async () => {
    const r = await reg.call('echo_tool', { pkg: 'react', depth: 2 }, ctx);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({ got: { pkg: 'react', depth: 2 } });
  });

  it('a handler throw becomes isError with no stack and no absolute paths', async () => {
    const r = await reg.call('boom', { pkg: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toBe('boom failed: ENOENT: no such file .\\src\\x.ts and <path>');
    expect(r.content).not.toMatch(/at .*\(/);
    const t = await reg.call('tool_err', { pkg: 'x' }, ctx);
    expect(t.content).toBe('tool_err failed: package not found');
  });
});

describe('truncateToolResult (4a.1)', () => {
  it('keeps small results, caps big ones with the marker and stays within the cap', () => {
    expect(truncateToolResult('abc', 10)).toEqual({ content: 'abc', truncated: false });
    const big = 'é'.repeat(20_000);
    const r = truncateToolResult(big, 16 * 1024);
    expect(r.truncated).toBe(true);
    expect(r.content.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(r.content).not.toContain('\uFFFD');
  });

  it('registry results never exceed limits.maxResultBytes', async () => {
    const reg = createToolRegistry([def({ handler: () => ({ blob: 'x'.repeat(100_000) }) })]);
    const r = await reg.call('echo_tool', { pkg: 'x' }, { ...ctx, limits: { maxResultBytes: 2048 } });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(2048);
  });
});

describe('toAnthropicTools (4a.1)', () => {
  it('marks only terminal tools strict, sorted by name with terminal last, deterministic, and strips local-only bounds', () => {
    const build = () =>
      toAnthropicTools(createToolRegistry([def({ name: 'zeta' }), def({ name: 'alpha' })]), [UPDATE_REPORT_TOOL_SCHEMA]);
    const a = build();
    expect(a.map((t) => t.name)).toEqual(['alpha', 'zeta', 'submit_update_report']);
    expect(a.map((t) => t.strict === true)).toEqual([false, false, true]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(build()));
    const depth = (a[0]!.input_schema.properties as Record<string, Record<string, unknown>>).depth!;
    expect(depth).toEqual({ type: 'integer', description: '(min 0, max 5)' });
    expect(JSON.stringify(a)).not.toMatch(/"minimum"|"maximum"|"maxItems"/);
  });

  // Stage 4c, real API: "Schemas contains too many optional parameters (29) … (limit: 24)".
  // Documented limits (structured-outputs docs) are per request, across ALL strict schemas:
  // ≤ 20 strict tools, ≤ 24 optional params, ≤ 16 union-typed params.
  it('the real tool list stays inside the strict-schema limits of one request', () => {
    const tools = toAnthropicTools(createReadToolRegistry(), [UPDATE_REPORT_TERMINAL, DEEP_REPORT_TERMINAL]);
    const strict = tools.filter((t) => t.strict === true);
    const optionals = (s: unknown): number => {
      if (s === null || typeof s !== 'object') return 0;
      const o = s as { type?: unknown; properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: unknown[] };
      let n = 0;
      if (o.properties !== undefined) {
        const req = new Set(o.required ?? []);
        for (const [k, v] of Object.entries(o.properties)) n += (req.has(k) ? 0 : 1) + optionals(v);
      }
      n += optionals(o.items);
      for (const x of o.anyOf ?? []) n += optionals(x);
      return n;
    };
    const unions = (s: unknown): number => {
      const json = JSON.stringify(s);
      return (json.match(/"anyOf":/g) ?? []).length + (json.match(/"type":\[/g) ?? []).length;
    };
    expect(strict.length).toBeLessThanOrEqual(20);
    expect(strict.reduce((n, t) => n + optionals(t.input_schema), 0)).toBeLessThanOrEqual(24);
    expect(strict.reduce((n, t) => n + unions(t.input_schema), 0)).toBeLessThanOrEqual(16);
    expect(strict.map((t) => t.name).sort()).toEqual([UPDATE_REPORT_TERMINAL.name, DEEP_REPORT_TERMINAL.name].sort());
  });
});
