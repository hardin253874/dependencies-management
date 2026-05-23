/**
 * Stage 3 — View [D] Update Report: resolver-check disabled variants.
 *
 * Spec §7.6 + Appendix A.3: the resolver-check block must show one of three
 * disabled banners depending on `reason`:
 *   - `yarn` — "Yarn not supported in v1"
 *   - `kill-switch` — "Resolver check is turned off in Settings → Behavior"
 *   - `failure` — "Resolver check failed: <message>" + Retry button
 *
 * Spec §7.6 + §7.7: the kill-switch banner offers an "Open Settings" link
 * that opens Settings → Behavior. The failure variant offers a "Retry" button
 * that triggers regeneration.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import { SettingsModal } from '@/components/modals/SettingsModal';
import { useAppContext } from '@/components/AppContext';
import type {
  FileEnvelope,
  ProjectDetail,
  ResolverCheckBlock,
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

function makeReport(resolverCheck: ResolverCheckBlock): UpdateReportDetail {
  return {
    fromVersion: '18.2.0',
    toVersion: '19.0.0',
    summary: 'Test summary.',
    riskLevel: 'low',
    resolverCheck,
    coUpgradeDeps: [],
    breakingChanges: [],
    filesToModify: [],
    recommendations: []
  };
}

function envelope(data: UpdateReportDetail): FileEnvelope<UpdateReportDetail> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'anthropic:claude-opus-4-7',
    ttlHours: 720,
    data
  };
}

function projectStub() {
  return {
    slug: 'p',
    name: 'my-app',
    path: '/p',
    packageManager: 'npm' as const,
    depCount: 1,
    lastScanAt: null,
    pathExists: true
  };
}

/**
 * The SettingsModal is normally rendered inside AppShell. Tests for the
 * "Open Settings" affordance render a tiny harness that wires the modal
 * open-state from context so we can verify the click actually opens
 * Settings → Behavior.
 */
function SettingsHarness(): JSX.Element {
  const { settingsOpen, settingsSection } = useAppContext();
  return (
    <>
      <DetailPanel />
      <SettingsModal open={settingsOpen} />
      <span data-testid="settings-section-tracker">{settingsSection}</span>
      <span data-testid="settings-open-tracker">{String(settingsOpen)}</span>
    </>
  );
}

describe('UpdateReportView resolver-disabled variants', () => {
  it('renders the yarn-disabled banner with the reason copy', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub()],
        projectDetails: { p: projectDetail('p') },
        reports: {
          'p::react::18.2.0::19.0.0': envelope(
            makeReport({ kind: 'disabled', reason: 'yarn' })
          )
        }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('resolver-disabled-yarn')).toBeInTheDocument()
    );
    expect(screen.getByTestId('resolver-disabled-yarn')).toHaveTextContent(
      /not available for yarn projects in v1/i
    );
  });

  it('renders the kill-switch banner with an Open Settings affordance that opens Behavior', async () => {
    withRoute();
    renderWithProviders(<SettingsHarness />, {
      backend: {
        projects: [projectStub()],
        projectDetails: { p: projectDetail('p') },
        reports: {
          'p::react::18.2.0::19.0.0': envelope(
            makeReport({ kind: 'disabled', reason: 'kill-switch' })
          )
        }
      }
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('resolver-disabled-kill-switch')
      ).toBeInTheDocument()
    );
    expect(
      screen.getByTestId('resolver-disabled-kill-switch')
    ).toHaveTextContent(/turned off in Settings.*Behavior/i);

    // Settings closed initially.
    expect(screen.getByTestId('settings-open-tracker')).toHaveTextContent('false');

    await userEvent.click(screen.getByTestId('resolver-open-settings'));

    // Settings opens at the Behavior section.
    await waitFor(() =>
      expect(screen.getByTestId('settings-open-tracker')).toHaveTextContent('true')
    );
    expect(screen.getByTestId('settings-section-tracker')).toHaveTextContent(
      'behavior'
    );
  });

  it('renders the failure banner with the message and a Retry button', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub()],
        projectDetails: { p: projectDetail('p') },
        reports: {
          'p::react::18.2.0::19.0.0': envelope(
            makeReport({
              kind: 'disabled',
              reason: 'failure',
              failureMessage: 'npm install --dry-run exited 1'
            })
          )
        }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('resolver-disabled-failure')).toBeInTheDocument()
    );
    expect(screen.getByTestId('resolver-disabled-failure')).toHaveTextContent(
      'npm install --dry-run exited 1'
    );
    expect(screen.getByTestId('resolver-retry')).toBeInTheDocument();
  });

  it('renders resolver-conflicts list when wouldResolve is false', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub()],
        projectDetails: { p: projectDetail('p') },
        reports: {
          'p::react::18.2.0::19.0.0': envelope(
            makeReport({
              kind: 'enabled',
              wouldResolve: false,
              conflicts: [
                {
                  package: 'react-router@5',
                  reason: 'peer-dep react@^17 not satisfied'
                }
              ],
              legacyPeerDepsUsed: true
            })
          )
        }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('resolver-conflicts')).toBeInTheDocument()
    );
    expect(screen.getByText('react-router@5')).toBeInTheDocument();
    expect(
      screen.getByText(/peer-dep react.* not satisfied/)
    ).toBeInTheDocument();
    expect(
      screen.getByText('Resolved with --legacy-peer-deps: yes')
    ).toBeInTheDocument();
  });
});
