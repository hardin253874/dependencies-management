import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isLoopbackHost, getBoundHost, assertLoopbackBind } from '@/lib/bindCheck';

describe('invariant: server binds 127.0.0.1 only (spec §3.3 / §16.3)', () => {
  it('isLoopbackHost permits 127.0.0.1, localhost, ::1', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost(null)).toBe(true);
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost('')).toBe(true);
  });

  it('isLoopbackHost rejects external addresses', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('assertLoopbackBind throws when HOSTNAME is non-loopback', () => {
    const prevScript = process.env.npm_lifecycle_script;
    const prevHost = process.env.HOSTNAME;
    try {
      delete process.env.npm_lifecycle_script;
      process.env.HOSTNAME = '0.0.0.0';
      expect(() => assertLoopbackBind()).toThrow(/local-only/);
    } finally {
      if (prevScript === undefined) delete process.env.npm_lifecycle_script;
      else process.env.npm_lifecycle_script = prevScript;
      if (prevHost === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = prevHost;
    }
  });

  it('npm scripts dev/start pass -H 127.0.0.1', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toContain('-H 127.0.0.1');
    expect(pkg.scripts.start).toContain('-H 127.0.0.1');
    expect(pkg.scripts.dev).not.toContain('0.0.0.0');
    expect(pkg.scripts.start).not.toContain('0.0.0.0');
  });

  it('getBoundHost reads the -H flag from npm_lifecycle_script', () => {
    const prev = process.env.npm_lifecycle_script;
    try {
      process.env.npm_lifecycle_script = 'next dev -H 127.0.0.1 -p 3000';
      expect(getBoundHost()).toBe('127.0.0.1');
    } finally {
      if (prev === undefined) delete process.env.npm_lifecycle_script;
      else process.env.npm_lifecycle_script = prev;
    }
  });
});
