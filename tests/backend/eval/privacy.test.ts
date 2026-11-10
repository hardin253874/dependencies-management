/**
 * Privacy guard (v2 Stage 0.1): private corpus and private results must be
 * gitignored before any private file exists. Read-only git only.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

const TOOL_ROOT = path.resolve(__dirname, '../../..');

function isGitWorkTree(): boolean {
  try {
    return (
      execFileSync('git', ['--no-optional-locks', 'rev-parse', '--is-inside-work-tree'], {
        cwd: TOOL_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/** Paths git reports as ignored (exit 1 = none ignored). */
function checkIgnore(paths: string[]): string[] {
  try {
    return execFileSync('git', ['--no-optional-locks', 'check-ignore', ...paths], {
      cwd: TOOL_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

describe.skipIf(!isGitWorkTree())('eval privacy gitignore', () => {
  it('ignores the private corpus and private results', () => {
    const paths = ['eval/corpus.local.json', 'eval/results/private/x.json', 'eval/results/private/x.findings.md'];
    expect(checkIgnore(paths).sort()).toEqual([...paths].sort());
  });

  it('does not ignore the public corpus or public results', () => {
    expect(checkIgnore(['eval/corpus/cases/x-case.json', 'eval/results/x.json', 'eval/corpus/README.md'])).toEqual([]);
  });
});
