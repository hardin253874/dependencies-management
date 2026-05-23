import { describe, expect, it, beforeEach } from 'vitest';
import { PersistenceKeys, readLocal, writeLocal } from '@/lib/client/persistence';

describe('persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns fallback when key is unset', () => {
    expect(readLocal(PersistenceKeys.sidebarCollapsed, false)).toBe(false);
  });

  it('round-trips boolean values', () => {
    writeLocal(PersistenceKeys.sidebarCollapsed, true);
    expect(readLocal(PersistenceKeys.sidebarCollapsed, false)).toBe(true);
  });

  it('round-trips object values', () => {
    writeLocal(PersistenceKeys.panelWidths, { left: 320, middle: 440 });
    expect(readLocal(PersistenceKeys.panelWidths, { left: 0, middle: 0 })).toEqual({
      left: 320,
      middle: 440
    });
  });

  it('returns fallback when value is malformed', () => {
    window.localStorage.setItem('dep-agent:' + PersistenceKeys.sidebarCollapsed, 'not-json{{{');
    expect(readLocal(PersistenceKeys.sidebarCollapsed, false)).toBe(false);
  });
});
