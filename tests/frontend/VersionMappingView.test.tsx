/**
 * Stage 2 — View [B] Version-Mapping View.
 *
 * Covers:
 *   - "Vulnerabilities in v<version>" labeled correctly (distinct from [A]'s
 *     "Current vulnerabilities").
 *   - "Analyze report" placeholder toast appears (Stage 3 not shipped yet).
 *   - Empty-state CTA renders when GET returns 404 NOT_CACHED.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import { ToastContainer } from '@/components/ToastContainer';
import type { FileEnvelope, ProjectDetail, VersionDetail } from '@/lib/api-types';

function projectDetail(slug: string, installedReact = '18.2.0'): ProjectDetail {
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
        installedVersion: installedReact,
        badges: {
          outdatedSeverity: 'major',
          hasCve: false,
          deprecated: false,
          lastScannedAt: '2026-05-23T00:00:00.000Z'
        }
      }
    ]
  };
}

function envelope(data: VersionDetail): FileEnvelope<VersionDetail> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'registry',
    ttlHours: 168,
    data
  };
}

function withRoute(): void {
  window.localStorage.setItem(
    'dep-agent:ui.detailRoute',
    JSON.stringify({ kind: 'B', depName: 'react', version: '19.0.0' })
  );
}

describe('VersionMappingView (View [B])', () => {
  it('renders "Vulnerabilities in v<version>" label', async () => {
    withRoute();
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
        versions: {
          'p::react::19.0.0': envelope({
            version: '19.0.0',
            publishedAt: '2024-12-05T00:00:00Z',
            cves: [],
            changelogUrl: 'https://example.com/changelog',
            notes: 'React 19 introduces…'
          })
        }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('cve-section-title').textContent).toBe(
        'Vulnerabilities in v19.0.0'
      )
    );
    expect(screen.getByText('No known CVEs in this version.')).toBeInTheDocument();
  });

  it('shows the empty-state CTA when no version mapping is cached', async () => {
    withRoute();
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
        versions: {}
      }
    });
    await waitFor(() =>
      expect(screen.getByText('No version mapping yet.')).toBeInTheDocument()
    );
    expect(screen.getByTestId('empty-state-action')).toHaveTextContent('Run version mapping');
  });

  it('Analyze report navigates to view [D] with installed → target versions', async () => {
    withRoute();
    renderWithProviders(
      <>
        <DetailPanel />
        <ToastContainer />
      </>,
      {
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
          projectDetails: { p: projectDetail('p', '18.2.0') },
          versions: {
            'p::react::19.0.0': envelope({
              version: '19.0.0',
              publishedAt: null,
              cves: [],
              changelogUrl: null,
              notes: null
            })
          }
          // reports cache empty → [D] will show empty-state CTA
        }
      }
    );
    await waitFor(() => expect(screen.getByTestId('analyze-report-button')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('analyze-report-button'));
    // Navigated to [D] — empty-state appears since report cache is empty.
    await waitFor(() =>
      expect(screen.getByText(/Generate an update report for react v18\.2\.0 → v19\.0\.0/)).toBeInTheDocument()
    );
  });
});
