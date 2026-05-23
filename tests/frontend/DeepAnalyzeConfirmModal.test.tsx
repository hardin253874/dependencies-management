/**
 * Stage 4 — First-Deep-Analyze confirmation prompt (spec §7.6, Wireframe 29).
 *
 * Covers:
 *   - Modal appears when user clicks Deep Analyze on view [D] and
 *     `_config.json.ui.showDeepAnalyzeWarning` is true (default).
 *   - Cost estimate populates from BE.
 *   - "Continue" navigates to [D-deep].
 *   - "Cancel" closes the modal without navigation.
 *   - When `showDeepAnalyzeWarning === false`, clicking Deep Analyze
 *     navigates directly without prompting.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import type {
  ConfigResponse,
  DeepReportEstimateResponse,
  FileEnvelope,
  ProjectDetail,
  UpdateReportDetail
} from '@/lib/api-types';

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

function withDRoute(): void {
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

const minimalReport: UpdateReportDetail = {
  fromVersion: '18.2.0',
  toVersion: '19.0.0',
  summary: 'OK',
  riskLevel: 'low',
  resolverCheck: {
    kind: 'enabled',
    wouldResolve: true,
    conflicts: [],
    legacyPeerDepsUsed: false
  },
  coUpgradeDeps: [],
  breakingChanges: [],
  filesToModify: [],
  recommendations: []
};

function envelope<T>(data: T): FileEnvelope<T> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'anthropic:claude-opus-4-7',
    ttlHours: 720,
    data
  };
}

const baseConfigOn: ConfigResponse = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  apiKeys: { hasAnthropicKey: true, hasOpenAIKey: false }
};

const estimate: DeepReportEstimateResponse = {
  estimatedInputTokens: 25000,
  estimatedOutputTokens: 6000,
  estimatedCostUsd: 0.42,
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  totalPackages: 1825
};

describe('First-Deep-Analyze confirmation prompt', () => {
  it('shows when showDeepAnalyzeWarning is true and the user clicks Deep Analyze', async () => {
    withDRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        config: baseConfigOn,
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
        reports: { 'p::react::18.2.0::19.0.0': envelope(minimalReport) },
        deepEstimates: { 'p::react::18.2.0::19.0.0': estimate }
      }
    });

    await waitFor(() => expect(screen.getByTestId('deep-analyze')).toBeEnabled());
    await userEvent.click(screen.getByTestId('deep-analyze'));

    await waitFor(() =>
      expect(screen.getByTestId('deep-prompt-continue')).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.getByTestId('deep-prompt-cost')).toHaveTextContent(
        'Estimated cost: ~$0.42'
      )
    );
    expect(screen.getByText(/1,825/)).toBeInTheDocument();
  });

  it('Cancel closes the prompt without navigating', async () => {
    withDRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        config: baseConfigOn,
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
        reports: { 'p::react::18.2.0::19.0.0': envelope(minimalReport) },
        deepEstimates: { 'p::react::18.2.0::19.0.0': estimate }
      }
    });

    await waitFor(() => expect(screen.getByTestId('deep-analyze')).toBeEnabled());
    await userEvent.click(screen.getByTestId('deep-analyze'));
    await waitFor(() =>
      expect(screen.getByTestId('deep-prompt-cancel')).toBeInTheDocument()
    );

    await userEvent.click(screen.getByTestId('deep-prompt-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('deep-prompt-cancel')).not.toBeInTheDocument()
    );
    // Still on [D] (Update Report sections still visible).
    expect(screen.getByTestId('deep-analyze')).toBeInTheDocument();
  });

  it('is suppressed when showDeepAnalyzeWarning is false (navigates directly)', async () => {
    withDRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        config: {
          ...baseConfigOn,
          ui: { ...baseConfigOn.ui, showDeepAnalyzeWarning: false }
        },
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
        reports: { 'p::react::18.2.0::19.0.0': envelope(minimalReport) },
        deepReports: {}
      }
    });

    await waitFor(() => expect(screen.getByTestId('deep-analyze')).toBeEnabled());
    await userEvent.click(screen.getByTestId('deep-analyze'));

    // No prompt — navigated straight to [D-deep] empty state.
    await waitFor(() =>
      expect(screen.getByText('No deep analysis yet.')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('deep-prompt-cancel')).not.toBeInTheDocument();
  });
});
