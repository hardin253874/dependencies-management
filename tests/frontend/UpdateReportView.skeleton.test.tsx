/**
 * Stage 3 carry-over M1 — When the AI-down deterministic-partial skeleton
 * has an empty `suggestedVersion`, the [D] view should not render the
 * dangling-arrow `currentVersion → ` artifact. The arrow + suggested span are
 * hidden until a non-empty suggestion is present.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import type { FileEnvelope, ProjectDetail, UpdateReportDetail } from '@/lib/api-types';

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
        installedVersion: '18.2.0',
        badges: {
          outdatedSeverity: 'major',
          hasCve: false,
          deprecated: false,
          lastScannedAt: null
        }
      }
    ]
  };
}

function withRoute(): void {
  window.localStorage.setItem(
    'dep-agent:ui.detailRoute',
    JSON.stringify({
      kind: 'D',
      depName: 'react',
      fromVersion: '18.2.0',
      toVersion: '19.0.0'
    })
  );
}

const skeletonWithEmptySuggested: UpdateReportDetail = {
  fromVersion: '18.2.0',
  toVersion: '19.0.0',
  summary: '',
  riskLevel: 'medium',
  resolverCheck: {
    kind: 'enabled',
    wouldResolve: true,
    conflicts: [],
    legacyPeerDepsUsed: false
  },
  coUpgradeDeps: [
    {
      name: 'react-dom',
      currentVersion: '18.2.0',
      suggestedVersion: '', // Skeleton — BE could not suggest.
      required: false,
      reason: 'peer-dep',
      explanation: 'react-dom is peer-pinned to React major.'
    }
  ],
  breakingChanges: [],
  filesToModify: [],
  recommendations: []
};

describe('UpdateReportView CoUpgradeRow — M1 skeleton handling', () => {
  it('does not render a dangling arrow when suggestedVersion is empty', async () => {
    withRoute();
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
        reports: {
          'p::react::18.2.0::19.0.0': {
            schemaVersion: 1,
            generatedAt: '2026-05-23T00:00:00.000Z',
            source: 'deterministic-partial',
            ttlHours: 720,
            data: skeletonWithEmptySuggested
          } as FileEnvelope<UpdateReportDetail>
        }
      }
    });

    const row = await screen.findByTestId('co-upgrade-react-dom');
    expect(row).toBeInTheDocument();
    // No "→" arrow in the rendered text.
    expect(row.textContent).not.toContain('→');
    expect(row).toHaveTextContent('18.2.0');
  });
});
