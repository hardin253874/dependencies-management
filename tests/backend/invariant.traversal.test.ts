import { describe, it, expect, afterEach } from 'vitest';
import { listDirectory } from '@/lib/fs/picker';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { isValidParam, isValidPackageName } from '@/lib/http/validate';
import path from 'node:path';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('invariant: path traversal rejected in /api/fs/list (spec §9.4 / §16.3)', () => {
  it('rejects relative paths', async () => {
    const result = await listDirectory('relative/foo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_ABSOLUTE');
  });

  it('rejects absolute paths containing ..', async () => {
    sandbox = await createSandbox('list-traverse');
    // Build the path via string concatenation, not path.join — path.join
    // collapses `..` segments before we ever see them, so it would defeat the
    // point of the test. We want to verify that the picker rejects a literal
    // `..` in the *input* before any normalization runs.
    const naughty = `${sandbox.scratchRoot}${path.sep}..${path.sep}naughty`;
    const result = await listDirectory(naughty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PATH_TRAVERSAL');
  });

  it('rejects paths that decode-into traversal via embedded dot-dot', async () => {
    const naughty = '/var/tmp/../../etc';
    const result = await listDirectory(naughty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PATH_TRAVERSAL');
  });
});

describe('invariant: allowlist validation on URL params (spec §9.2)', () => {
  it('accepts simple alphanumerics', () => {
    expect(isValidParam('abcd1234')).toBe(true);
    expect(isValidParam('react')).toBe(true);
    expect(isValidParam('18.2.0')).toBe(true);
    expect(isValidParam('a3f9c1e283b9')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidParam('')).toBe(false);
  });

  it('rejects path-traversal characters', () => {
    expect(isValidParam('..')).toBe(false);
    expect(isValidParam('../etc')).toBe(false);
    expect(isValidParam('foo/bar')).toBe(false);
    expect(isValidParam('foo\\bar')).toBe(false);
    expect(isValidParam('foo bar')).toBe(false);
    expect(isValidParam('a..b')).toBe(false);
  });

  it('accepts scoped package names after URL decoding', () => {
    expect(isValidPackageName('react')).toBe(true);
    expect(isValidPackageName('@types/react')).toBe(true);
    expect(isValidPackageName('@scope/pkg-name')).toBe(true);
  });

  it('rejects malformed package names', () => {
    expect(isValidPackageName('')).toBe(false);
    expect(isValidPackageName('../etc')).toBe(false);
    expect(isValidPackageName('FOO')).toBe(false); // uppercase not allowed
    expect(isValidPackageName('foo bar')).toBe(false);
  });
});
