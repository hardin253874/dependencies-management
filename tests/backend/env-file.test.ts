import { describe, it, expect } from 'vitest';
import { parseEnv, serializeEnv } from '@/lib/storage/envFile';

describe('env file parse/serialize', () => {
  it('parses simple key=value pairs', () => {
    const text = 'A=1\nB=two\n';
    expect(parseEnv(text)).toEqual({ A: '1', B: 'two' });
  });

  it('ignores comments and blanks', () => {
    const text = '# header\n\nKEY=value\n# trailing\n';
    expect(parseEnv(text)).toEqual({ KEY: 'value' });
  });

  it('strips surrounding quotes', () => {
    expect(parseEnv('A="quoted"\n')).toEqual({ A: 'quoted' });
    expect(parseEnv("B='single'\n")).toEqual({ B: 'single' });
  });

  it('preserves order and unknown keys when serializing patches', () => {
    const original = '# header\nA=1\nB=2\n# section\nC=3\n';
    const out = serializeEnv({ A: '1', B: 'NEW', D: 'added' }, original);
    expect(out).toContain('# header');
    expect(out).toContain('A=1');
    expect(out).toContain('B=NEW');
    expect(out).toContain('# section');
    expect(out).toContain('C=3');
    expect(out).toContain('D=added');
    expect(out.indexOf('B=NEW')).toBeGreaterThan(out.indexOf('A=1'));
  });
});
