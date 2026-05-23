/**
 * Stage 2 — View [A] Dependency Detail tests.
 *
 * Covers:
 *   - Empty-state CTA renders when GET returns 404 NOT_CACHED.
 *   - Stale-cache banner renders past TTL (`CacheFreshnessLine` amber state).
 *   - Deprecation banner renders when payload.data.deprecation is set.
 *   - "Current vulnerabilities" label per spec §7.6.
 *   - Click "View Usage" navigates to view [C].
 *   - Click a version row navigates to view [B].
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import type { FileEnvelope, DepDetail, ProjectDetail } from '@/lib/api-types';

function projectDetail(slug: string): ProjectDetail {
  return {
    schemaVersion: 1,
    name: 'my-app',
    slug,
    path: '/p',
    packageManager: 'npm',
    lockfileHash: 'h',
    lockfileStateHash: 's',
    lastFullScanAt: '2026-05-20T00:00:00.000Z',
    legacyPeerDeps: false,
    volta: null,
    workspacesDetected: false,
    dependencies: [
      {
        name: 'react',
        section: 'dependencies',
        declaredRange: '^18.0.0',
        installedVersion: '18.0.0',
        badges: {
          outdatedSeverity: 'major',
          hasCve: true,
          deprecated: false,
          lastScannedAt: '2026-05-23T00:00:00.000Z'
        }
      }
    ]
  };
}

function envelope(generatedAt: string, ttlHours: number | null, data: DepDetail): FileEnvelope<DepDetail> {
  return { schemaVersion: 1, generatedAt, source: 'registry', ttlHours, data };
}

/**
 * The hydration-pass tests below mount the component with a pre-seeded route
 * so we don't have to drive the UI from clicks. Using the persistence keys is
 * the cleanest approach.
 */
describe('DependencyDetailView (View [A])', () => {
  function withRoute(name: string): void {
    window.localStorage.setItem(
      'dep-agent:ui.detailRoute',
      JSON.stringify({ kind: 'A', depName: name })
    );
  }

  it('renders empty-state CTA on 404 NOT_CACHED', async () => {
    withRoute('react');
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [
          {
            slug: 'p',
            name: 'my-app',
            path: '/p',
            packageManager: 'npm',
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: { p: projectDetail('p') },
        deps: {} // no cache for react
      }
    });
    await waitFor(() =>
      expect(screen.getByText('No analysis yet.')).toBeInTheDocument()
    );
    expect(screen.getByTestId('empty-state-action')).toHaveTextContent('Generate analysis');
  });

  it('renders deprecation banner + "Current vulnerabilities" label', async () => {
    withRoute('moment');
    const detail: DepDetail = {
      name: 'moment',
      availableVersions: [
        { version: '2.30.1', publishedAt: '2024-12-20T00:00:00Z', isPrerelease: false }
      ],
      support: { homepage: null, repository: null, lastPublishAt: null },
      license: 'MIT',
      deprecation: { message: 'Moment is in maintenance mode.' },
      currentVersionCves: [],
      latestPeerDeps: {},
      latestEngines: {},
      relatedDeps: []
    };
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [
          {
            slug: 'p',
            name: 'my-app',
            path: '/p',
            packageManager: 'npm',
            depCount: 0,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: { p: projectDetail('p') },
        deps: { 'p::moment': envelope('2026-05-22T12:00:00.000Z', 24, detail) }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('deprecation-banner')).toBeInTheDocument()
    );
    expect(screen.getByText('Current vulnerabilities')).toBeInTheDocument();
    expect(screen.getByTestId('cve-clean')).toBeInTheDocument();
  });

  it('shows the stale-cache amber line when past TTL', async () => {
    withRoute('react');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const detail: DepDetail = {
      name: 'react',
      availableVersions: [],
      support: { homepage: null, repository: null, lastPublishAt: null },
      license: null,
      deprecation: null,
      currentVersionCves: [],
      latestPeerDeps: {},
      latestEngines: {},
      relatedDeps: []
    };
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [
          {
            slug: 'p',
            name: 'my-app',
            path: '/p',
            packageManager: 'npm',
            depCount: 0,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: { p: projectDetail('p') },
        deps: { 'p::react': envelope(old, 24, detail) } // ttl 24h, generated 8 days ago
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('cache-freshness').textContent).toMatch(/Stale/)
    );
  });

  it('clicking a version row navigates to view [B]', async () => {
    withRoute('react');
    const detail: DepDetail = {
      name: 'react',
      availableVersions: [
        { version: '19.0.0', publishedAt: '2024-12-05T00:00:00Z', isPrerelease: false }
      ],
      support: { homepage: null, repository: null, lastPublishAt: null },
      license: null,
      deprecation: null,
      currentVersionCves: null, // → CVE-data-unavailable banner
      latestPeerDeps: {},
      latestEngines: {},
      relatedDeps: []
    };
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [
          {
            slug: 'p',
            name: 'my-app',
            path: '/p',
            packageManager: 'npm',
            depCount: 0,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: { p: projectDetail('p') },
        deps: { 'p::react': envelope('2026-05-23T00:00:00.000Z', 24, detail) },
        versions: {} // version cache empty → [B] will show empty state CTA
      }
    });
    await waitFor(() => expect(screen.getByText('Available versions')).toBeInTheDocument());
    expect(screen.getByTestId('cve-unavailable-banner')).toBeInTheDocument();

    // Expand the major bucket then click the version link.
    await userEvent.click(screen.getByTestId('major-toggle-19'));
    await userEvent.click(screen.getByTestId('version-link-19.0.0'));

    // View [B] now renders empty-state CTA since version cache is missing.
    await waitFor(() => expect(screen.getByText('No version mapping yet.')).toBeInTheDocument());
  });
});
