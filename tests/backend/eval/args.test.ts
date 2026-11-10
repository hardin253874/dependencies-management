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
