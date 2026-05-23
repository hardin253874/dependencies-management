/**
 * Stage 3 — View [D] Update Report (happy path / fully enabled).
 *
 * Covers (spec §7.6, Appendix A.3, WIREFRAMES.md #11):
 *   - Summary + risk pill render.
 *   - Resolver-check (enabled, clean) renders "Would resolve cleanly".
 *   - Co-upgrade list renders with Required vs Optional pills.
 *   - Breaking changes render with the "Affects this project" pill when set.
 *   - Files-to-modify render with the path + brief + change-size pill.
 *   - Recommendations list renders.
 *   - Deep Analyze + Download buttons are present but disabled (Stage 4 placeholders).
 *   - Empty-state CTA renders when GET returns 404 NOT_CACHED.
 *
 * Note: the AI-down banner, file-stale banner, and resolver-disabled variants
 * have dedicated sibling test files so each behavior reads independently.
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
          lastScannedAt: '2026-05-23T00:00:00.000Z'
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

function envelope(
  data: UpdateReportDetail,
  overrides: Partial<FileEnvelope<UpdateReportDetail>> = {}
): FileEnvelope<UpdateReportDetail> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'anthropic:claude-opus-4-7',
    ttlHours: 720,
    data,
    ...overrides
  };
}

const fullReport: UpdateReportDetail = {
  fromVersion: '18.2.0',
  toVersion: '19.0.0',
  summary: 'Upgrade introduces new JSX transform and removes legacy APIs.',
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
      suggestedVersion: '19.0.0',
      required: true,
      reason: 'peer-dep',
      explanation: 'react-dom is peer-pinned to the React major.'
    },
    {
      name: '@types/react',
      currentVersion: '18.2.45',
      suggestedVersion: '19.0.0',
      required: false,
      reason: 'common-pairing',
      explanation: 'Type definitions should track React major.'
    }
  ],
  breakingChanges: [
    {
      title: 'Removed defaultProps for function components',
      description: 'Use default parameters instead.',
      affectsFilesInProject: true
    },
    {
      title: 'Stricter Strict Mode double-render in dev',
      description: 'Should not affect production.',
      affectsFilesInProject: false
    }
  ],
  filesToModify: [
    {
      path: 'src/App.tsx',
      brief: 'Drop defaultProps in two function components.',
      estimatedChangeSize: 'small'
    },
    {
      path: 'src/forms/SignupForm.tsx',
      brief: 'Migrate ref forwarding.',
      estimatedChangeSize: 'medium'
    }
  ],
  recommendations: [
    'Run unit tests before deploying.',
    'Update Storybook to match the new render behavior.'
  ],
  cost: {
    inputTokens: 1200,
    outputTokens: 800,
    model: 'claude-opus-4-7',
    costEstimateUsd: 0.024
  }
};

describe('UpdateReportView (View [D])', () => {
  it('renders summary, risk pill, resolver clean, co-upgrades, breaking changes, files, and recommendations', async () => {
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
        reports: { 'p::react::18.2.0::19.0.0': envelope(fullReport) }
      }
    });

    // Summary
    await waitFor(() =>
      expect(
        screen.getByText(/Upgrade introduces new JSX transform/)
      ).toBeInTheDocument()
    );
    // Risk pill
    expect(screen.getByTestId('risk-pill-medium')).toHaveTextContent('medium');

    // Resolver clean
    expect(screen.getByTestId('resolver-clean')).toHaveTextContent(
      'Would resolve cleanly.'
    );

    // Co-upgrade list
    expect(screen.getByTestId('co-upgrade-react-dom')).toBeInTheDocument();
    expect(screen.getByTestId('co-upgrade-react-dom-pill')).toHaveTextContent(
      'Required'
    );
    expect(screen.getByTestId('co-upgrade-@types/react-pill')).toHaveTextContent(
      'Optional'
    );

    // Breaking changes with affects pill on the first
    expect(screen.getByTestId('breaking-change-0')).toHaveTextContent(
      'Removed defaultProps for function components'
    );
    expect(screen.getByTestId('breaking-change-0')).toHaveTextContent(
      'Affects this project'
    );
    expect(screen.getByTestId('breaking-change-1')).not.toHaveTextContent(
      'Affects this project'
    );

    // Files to modify with brief + change-size pill
    expect(
      screen.getByTestId('file-to-modify-src/App.tsx')
    ).toHaveTextContent('Drop defaultProps');
    expect(
      screen.getByTestId('file-to-modify-src/forms/SignupForm.tsx')
    ).toHaveTextContent('medium');

    // Recommendations
    expect(
      screen.getByText('Run unit tests before deploying.')
    ).toBeInTheDocument();

    // Stage 4: Deep Analyze + Download buttons are wired (no longer placeholders).
    expect(screen.getByTestId('deep-analyze')).toBeEnabled();
    expect(screen.getByTestId('download-md')).toBeEnabled();
    expect(screen.getByTestId('download-html')).toBeEnabled();
  });

  it('renders the empty-state CTA when GET returns 404 NOT_CACHED', async () => {
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
        reports: {}
      }
    });

    await waitFor(() =>
      expect(screen.getByText('No analysis yet.')).toBeInTheDocument()
    );
    expect(screen.getByTestId('empty-state-action')).toHaveTextContent(
      'Generate report'
    );
  });

  it('renders all three risk-pill variants', async () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      window.localStorage.clear();
      withRoute();
      const { unmount } = renderWithProviders(<DetailPanel />, {
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
            'p::react::18.2.0::19.0.0': envelope({ ...fullReport, riskLevel: level })
          }
        }
      });
      await waitFor(() =>
        expect(screen.getByTestId(`risk-pill-${level}`)).toBeInTheDocument()
      );
      unmount();
    }
  });
});
