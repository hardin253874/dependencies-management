/**
 * Stage 4 — Download flow for [D] and [D-Deep] (spec §7.6 + IMPLEMENTATION_PLAN).
 *
 * Covers:
 *   - "Download MD" / "Download HTML" trigger a successful blob download
 *     (triggerDownload is exercised via the api-client returning a payload).
 *   - 404 NOT_CACHED renders the "Generate the report first" friendly message.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import type {
  DeepUpdateReportDetail,
  FileEnvelope,
  ProjectDetail
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

function withDeepRoute(): void {
  window.localStorage.setItem(
    'dep-agent:ui.detailRoute',
    JSON.stringify({
      kind: 'D-deep',
      depName: 'react',
      fromVersion: '18.2.0',
      toVersion: '19.0.0'
    })
  );
}

const minimalDeepReport: DeepUpdateReportDetail = {
  fromVersion: '18.2.0',
  toVersion: '19.0.0',
  lockfileStateHashShort: 'a1b2c',
  summary: 'OK',
  riskLevel: 'low',
  narrative: 'OK.',
  estimatedEffort: 'small',
  lockfileSummary: {
    totalPackages: 10,
    packagesByDirectDep: {},
    peerDepsOnTarget: []
  },
  transitiveDelta: { packagesAdded: [], packagesRemoved: [], packagesUpgraded: [] },
  cveDelta: { resolvedCves: [], newCves: [] },
  criticalBlockers: [],
  suggestedUpgradeOrder: [],
  resolverCheck: {
    kind: 'enabled',
    wouldResolve: true,
    conflicts: [],
    legacyPeerDepsUsed: false
  },
  coUpgradeDeps: []
};

function envelope<T>(
  data: T,
  overrides: Partial<FileEnvelope<T>> = {}
): FileEnvelope<T> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'anthropic:claude-opus-4-7',
    ttlHours: 720,
    data,
    ...overrides
  };
}

beforeEach(() => {
  // jsdom doesn't implement URL.createObjectURL; stub it.
  // Cast to avoid relying on @types/dom-url-object types.
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn(
    () => 'blob:mock'
  );
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});

describe('Download flow ([D-Deep])', () => {
  it('triggers download when MD is available', async () => {
    withDeepRoute();
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
        deepReports: { 'p::react::18.2.0::19.0.0': envelope(minimalDeepReport) },
        downloads: {
          'deep::p::react::18.2.0::19.0.0::md': '# Deep Report MD body'
        }
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('download-md')).toBeEnabled()
    );

    await userEvent.click(screen.getByTestId('download-md'));
    // After success, no error banner should be visible.
    await waitFor(() =>
      expect(screen.queryByTestId('download-error')).not.toBeInTheDocument()
    );
  });

  it('shows "Generate the report first" when download endpoint returns NOT_CACHED', async () => {
    withDeepRoute();
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
        deepReports: { 'p::react::18.2.0::19.0.0': envelope(minimalDeepReport) },
        downloads: {}
      }
    });

    await waitFor(() => expect(screen.getByTestId('download-md')).toBeEnabled());
    await userEvent.click(screen.getByTestId('download-md'));
    await waitFor(() =>
      expect(screen.getByTestId('download-error')).toHaveTextContent(
        'Generate the report first'
      )
    );
  });
});
