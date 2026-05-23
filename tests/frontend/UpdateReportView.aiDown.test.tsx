/**
 * Stage 3 — View [D] AI-down fallback rendering (spec §11.9).
 *
 * When the BE persisted a `source: "deterministic-partial"` envelope (LLM
 * failed after retries), the UI must:
 *   - Render the deterministic portions (resolver-check + co-upgrade list +
 *     files-to-modify + recommendations) verbatim.
 *   - Render an amber `AiUnavailableBanner` with a Retry button.
 *   - Substitute "Awaiting AI analysis" for narrative-only sections that the
 *     LLM would normally fill (summary, breaking changes).
 *   - The Retry button must POST the refresh endpoint.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/**
 * Spec §11.9: when the LLM is down, the BE writes the deterministic portions
 * (resolverCheck + coUpgradeDeps + filesToModify + recommendations) and leaves
 * the AI-narrative fields blank.
 */
const deterministicPartialPayload: UpdateReportDetail = {
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
      suggestedVersion: '19.0.0',
      required: true,
      reason: 'peer-dep',
      explanation: 'react-dom is peer-pinned to the React major.'
    }
  ],
  breakingChanges: [],
  filesToModify: [
    {
      path: 'src/App.tsx',
      brief: 'Detected import sites of react.',
      estimatedChangeSize: 'small'
    }
  ],
  recommendations: ['Retry with AI when the provider is available.']
};

function envelope(data: UpdateReportDetail): FileEnvelope<UpdateReportDetail> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'deterministic-partial',
    ttlHours: 720,
    data
  };
}

describe('UpdateReportView AI-down fallback', () => {
  it('renders the deterministic portion + amber AI-unavailable banner with a Retry button', async () => {
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
          'p::react::18.2.0::19.0.0': envelope(deterministicPartialPayload)
        }
      }
    });

    // Amber banner appears.
    await waitFor(() =>
      expect(screen.getByTestId('ai-unavailable-banner')).toBeInTheDocument()
    );
    expect(screen.getByTestId('ai-unavailable-banner')).toHaveTextContent(
      /AI narrative unavailable/i
    );
    expect(screen.getByTestId('ai-unavailable-retry')).toHaveTextContent(/Retry/);

    // Deterministic portion still renders.
    expect(screen.getByTestId('resolver-clean')).toBeInTheDocument();
    expect(screen.getByTestId('co-upgrade-react-dom')).toBeInTheDocument();
    expect(screen.getByTestId('file-to-modify-src/App.tsx')).toBeInTheDocument();
    expect(
      screen.getByText('Retry with AI when the provider is available.')
    ).toBeInTheDocument();

    // AI-narrative-only sections show the placeholder copy.
    // Summary empty → "Awaiting AI analysis"; breakingChanges empty → "Awaiting AI analysis"
    const placeholders = screen.getAllByText(/Awaiting AI analysis/);
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('Retry button POSTs the refresh endpoint', async () => {
    withRoute();
    const onRefresh = vi.fn();
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
          'p::react::18.2.0::19.0.0': envelope(deterministicPartialPayload)
        },
        onRefreshReport: onRefresh
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('ai-unavailable-retry')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('ai-unavailable-retry'));
    await waitFor(() =>
      expect(onRefresh).toHaveBeenCalledWith('p', 'react', '18.2.0', '19.0.0')
    );
  });
});
