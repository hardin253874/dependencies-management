/**
 * Locks in the Volta-aware installed-version lookup. Regresses the bug where
 * `VersionMappingView` disabled "Analyze related deps" for `node` because a
 * naive `project.dependencies.find()` couldn't see Volta toolchain entries.
 */
import { describe, it, expect } from 'vitest';
import { findInstalledVersion } from '@/lib/client/findInstalledVersion';
import type { ProjectDetail } from '@/lib/api-types';

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    schemaVersion: 1,
    name: 'demo',
    slug: 'demo',
    path: '/p',
    packageManager: 'npm',
    lockfileHash: 'h',
    lockfileStateHash: 's',
    lastFullScanAt: '2026-05-24T00:00:00.000Z',
    legacyPeerDeps: false,
    volta: null,
    workspacesDetected: false,
    dependencies: [],
    ...overrides
  };
}

describe('findInstalledVersion', () => {
  it('returns null for a null project', () => {
    expect(findInstalledVersion(null, 'react')).toBeNull();
    expect(findInstalledVersion(undefined, 'react')).toBeNull();
  });

  it('finds a direct dep by name', () => {
    const p = project({
      dependencies: [
        {
          name: 'react',
          section: 'dependencies',
          declaredRange: '^18.2.0',
          installedVersion: '18.2.0',
          badges: {
            outdatedSeverity: null,
            hasCve: null,
            deprecated: null,
            lastScannedAt: null
          }
        }
      ]
    });
    expect(findInstalledVersion(p, 'react')).toBe('18.2.0');
  });

  it('returns null when a direct dep has no installed version recorded', () => {
    const p = project({
      dependencies: [
        {
          name: 'flaky',
          section: 'dependencies',
          declaredRange: '*',
          installedVersion: null,
          badges: {
            outdatedSeverity: null,
            hasCve: null,
            deprecated: null,
            lastScannedAt: null
          }
        }
      ]
    });
    expect(findInstalledVersion(p, 'flaky')).toBeNull();
  });

  it('resolves node from project.volta when it is not in dependencies', () => {
    const p = project({ volta: { node: '18.16.0', npm: null, yarn: null } });
    expect(findInstalledVersion(p, 'node')).toBe('18.16.0');
  });

  it('resolves npm and yarn from project.volta', () => {
    const p = project({ volta: { node: '20.0.0', npm: '10.5.0', yarn: '1.22.19' } });
    expect(findInstalledVersion(p, 'npm')).toBe('10.5.0');
    expect(findInstalledVersion(p, 'yarn')).toBe('1.22.19');
  });

  it('returns null for a Volta toolchain name that volta does not pin', () => {
    const p = project({ volta: { node: '18.16.0', npm: null, yarn: null } });
    expect(findInstalledVersion(p, 'npm')).toBeNull();
    expect(findInstalledVersion(p, 'yarn')).toBeNull();
  });

  it('prefers a direct dep match over the Volta toolchain bag', () => {
    // Defensive: if some future scan adds `node` as a real dep, we should
    // surface that rather than the Volta pin (which the project might be
    // overriding deliberately).
    const p = project({
      dependencies: [
        {
          name: 'node',
          section: 'dependencies',
          declaredRange: '*',
          installedVersion: '22.0.0',
          badges: {
            outdatedSeverity: null,
            hasCve: null,
            deprecated: null,
            lastScannedAt: null
          }
        }
      ],
      volta: { node: '18.16.0', npm: null, yarn: null }
    });
    expect(findInstalledVersion(p, 'node')).toBe('22.0.0');
  });

  it('returns null for an unknown name (not a dep, not a toolchain)', () => {
    const p = project({ volta: { node: '20.0.0', npm: null, yarn: null } });
    expect(findInstalledVersion(p, 'nonexistent')).toBeNull();
  });
});
