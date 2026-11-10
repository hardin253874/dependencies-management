/**
 * Eval CLI argument parser (v2 Stage 0.1).
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../../../eval/lib/args';

describe('parseArgs', () => {
  it('returns help for no args, --help and help', () => {
    expect(parseArgs([])).toEqual({ command: 'help' });
    expect(parseArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseArgs(['help'])).toEqual({ command: 'help' });
  });

  it('parses run with --label and a --cases list', () => {
    expect(parseArgs(['run', '--label', 'v1-baseline', '--cases', 'a-case,b-case'])).toEqual({
      command: 'run',
      label: 'v1-baseline',
      cases: ['a-case', 'b-case'],
      offline: false,
      predictor: 'v1-code-scan'
    });
  });

  it('accepts --flag=value and ignores a -- separator', () => {
    const cmd = parseArgs(['--', 'run', '--label=x1', '--cache-dir=C:/tmp/c']);
    expect(cmd).toMatchObject({ command: 'run', label: 'x1', cacheDir: 'C:/tmp/c' });
  });

  it('treats --offline as a flag with no value', () => {
    expect(parseArgs(['truth', '--case', 'abc', '--offline'])).toEqual({
      command: 'truth',
      caseId: 'abc',
      offline: true
    });
  });

  it('rejects a value-taking flag with no value', () => {
    expect(() => parseArgs(['run', '--label'])).toThrow(UsageError);
    expect(() => parseArgs(['run', '--label', '--offline'])).toThrow(/--label needs a value/);
  });

  it('rejects a missing required flag', () => {
    expect(() => parseArgs(['run'])).toThrow(/needs --label/);
    expect(() => parseArgs(['truth'])).toThrow(/needs --case/);
  });

  it('rejects an invalid label', () => {
    expect(() => parseArgs(['run', '--label', 'Bad_Label'])).toThrow(/invalid --label/);
    expect(() => parseArgs(['run', '--label', '-leading'])).toThrow(UsageError);
    expect(() => parseArgs(['run', '--label', 'a'.repeat(42)])).toThrow(UsageError);
  });

  it('rejects an unknown command, unknown option and unknown predictor', () => {
    expect(() => parseArgs(['bogus'])).toThrow(/unknown command/);
    expect(() => parseArgs(['run', '--label', 'x', '--mock'])).toThrow(/unknown option --mock/);
    expect(() => parseArgs(['run', '--label', 'x', '--predictor', 'llm'])).toThrow(/unknown --predictor/);
  });

  it('parses compare and score-findings positionals', () => {
    expect(parseArgs(['compare', 'a.json', 'b.json'])).toEqual({ command: 'compare', a: 'a.json', b: 'b.json' });
    expect(() => parseArgs(['compare', 'a.json'])).toThrow(/exactly two/);
    expect(parseArgs(['score-findings', 'r.json'])).toEqual({ command: 'score-findings', resultsPath: 'r.json' });
  });

  it('accepts --predictor v2-graph for run', () => {
    expect(parseArgs(['run', '--label', 'g1', '--predictor', 'v2-graph'])).toMatchObject({ command: 'run', predictor: 'v2-graph' });
  });

  it('parses graph with defaults and every option', () => {
    expect(parseArgs(['graph', '--label', 'v2-stage3'])).toEqual({
      command: 'graph',
      label: 'v2-stage3',
      offline: false,
      packages: 'declared',
      refreshTruth: false
    });
    expect(
      parseArgs(['graph', '--label', 'g', '--cases', 'a-case,b-case', '--packages', 'phase', '--offline', '--refresh-truth', '--cache-dir', 'C:/c'])
    ).toEqual({
      command: 'graph',
      label: 'g',
      cases: ['a-case', 'b-case'],
      offline: true,
      packages: 'phase',
      refreshTruth: true,
      cacheDir: 'C:/c'
    });
  });

  it('rejects a bad graph invocation', () => {
    expect(() => parseArgs(['graph'])).toThrow(/needs --label/);
    expect(() => parseArgs(['graph', '--label', 'g', '--packages', 'all'])).toThrow(/unknown --packages/);
    expect(() => parseArgs(['graph', '--label', 'g', '--predictor', 'v2-graph'])).toThrow(/unknown option --predictor/);
    expect(() => parseArgs(['graph', '--label', 'g', 'extra'])).toThrow(/unexpected argument/);
  });

  it('rejects a flag given twice', () => {
    expect(() => parseArgs(['run', '--label', 'a1', '--label', 'b1'])).toThrow(/more than once/);
  });
});

describe('parseArgs — AI predictors (v2 Stage 4a.14 / 4a.15)', () => {
  it('accepts --predictor v2-agent with its options (defaults: sonnet 5.5, medium, update, playbooks off)', () => {
    expect(parseArgs(['run', '--label', 'a1', '--predictor', 'v2-agent', '--mock-script', 's.json'])).toMatchObject({
      predictor: 'v2-agent',
      ai: { model: 'claude-sonnet-5-5', effort: 'medium', budget: 'update', playbooks: 'off', mockScript: 's.json', mock: false }
    });
    expect(
      parseArgs(['run', '--label', 'a1', '--predictor', 'v2-agent', '--mock-script', 's.json', '--model', 'claude-haiku-5-5', '--effort', 'high', '--budget', 'deep', '--playbooks', 'on'])
    ).toMatchObject({ ai: { model: 'claude-haiku-5-5', effort: 'high', budget: 'deep', playbooks: 'on' } });
  });

  it('accepts --predictor v1-ai with --mock-llm', () => {
    expect(parseArgs(['run', '--label', 'a1', '--predictor', 'v1-ai', '--mock-llm'])).toMatchObject({ predictor: 'v1-ai', ai: { mock: true } });
  });

  it('refuses AI predictors without a mock in 4a, bad option values, and AI flags on deterministic predictors', () => {
    expect(() => parseArgs(['run', '--label', 'a1', '--predictor', 'v2-agent'])).toThrow(/needs --mock-script/);
    expect(() => parseArgs(['run', '--label', 'a1', '--predictor', 'v1-ai'])).toThrow(/needs --mock-llm/);
    expect(() => parseArgs(['run', '--label', 'a1', '--predictor', 'v2-agent', '--mock-script', 's', '--effort', 'turbo'])).toThrow(/unknown --effort/);
    expect(() => parseArgs(['run', '--label', 'a1', '--predictor', 'v2-agent', '--mock-script', 's', '--budget', 'huge'])).toThrow(/unknown --budget/);
    expect(() => parseArgs(['run', '--label', 'a1', '--predictor', 'v2-agent', '--mock-script', 's', '--model', 'BAD MODEL'])).toThrow(/invalid --model/);
    expect(() => parseArgs(['run', '--label', 'a1', '--model', 'claude-sonnet-5-5'])).toThrow(/only applies to --predictor/);
    expect(() => parseArgs(['run', '--label', 'a1', '--predictor', 'v1-ai', '--mock-llm', '--mock-script', 's'])).toThrow(/only applies to --predictor v2-agent/);
  });
});
