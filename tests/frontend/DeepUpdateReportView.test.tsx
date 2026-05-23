/**
 * Stage 4 — View [D-Deep] Deep Update Report (happy path).
 *
 * Covers (spec §7.6, §11.6, Appendix A.4, WIREFRAMES.md #13):
 *   - Summary + risk pill + effort pill render.
 *   - Transitive impact tiles (Added / Removed / Upgraded).
 *   - CVE delta (resolved + new) with severity pills.
 *   - Peer-dep conflicts list with satisfied / not-satisfied pills.
 *   - Critical blockers render with title / description / package.
 *   - AI narrative renders, paragraph count carries through.
 *   - Suggested upgrade order is numbered + sorted.
 *   - Empty-state CTA renders when GET returns 404 NOT_CACHED.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
      kind: 'D-deep',
      depName: 'react',
      fromVersion: '18.2.0',
      toVersion: '19.0.0'
    })
  );
}

function envelope(
  data: DeepUpdateReportDetail,
  overrides: Partial<FileEnvelope<DeepUpdateReportDetail>> = {}
): FileEnvelope<DeepUpdateReportDetail> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'anthropic:claude-opus-4-7',
    ttlHours: 720,
    data,
    ...overrides
  };
}

const fullDeepReport: DeepUpdateReportDetail = {
  fromVersion: '18.2.0',
  toVersion: '19.0.0',
  lockfileStateHashShort: 'a1b2c',
  summary: 'Major upgrade. React 19 introduces concurrent feature defaults.',
  riskLevel: 'high',
  narrative:
    'Paragraph one. Discusses headline risks.\n\nParagraph two. Discusses migration steps.\n\nParagraph three. Discusses rollback plan.',
  estimatedEffort: 'large',
  lockfileSummary: {
    totalPackages: 1825,
    packagesByDirectDep: { react: 12, 'react-dom': 3 },
    peerDepsOnTarget: [
      {
        package: '@apollo/client',
        version: '3.8.0',
        peerRange: '^17 || ^18',
        satisfiedByCandidate: false
      },
      {
        package: 'styled-components',
        version: '6.1.0',
        peerRange: '^16-19',
        satisfiedByCandidate: true
      }
    ]
  },
  transitiveDelta: {
    packagesAdded: [
      { name: 'foo', version: '1.0.0' },
      { name: 'bar', version: '2.0.0' }
    ],
    packagesRemoved: [{ name: 'baz', version: '0.5.0' }],
    packagesUpgraded: [{ name: 'qux', from: '1.0.0', to: '2.0.0' }]
  },
  cveDelta: {
    resolvedCves: [
      {
        id: 'CVE-2024-1234',
        package: 'css-tools',
        severity: 'medium',
        summary: 'XSS in css parser'
      }
    ],
    newCves: [
      {
        id: 'CVE-2025-0099',
        package: 'postcss',
        severity: 'medium',
        summary: 'Prototype pollution'
      }
    ]
  },
  criticalBlockers: [
    {
      title: '@apollo/client peer mismatch',
      description: 'Must update to v3.9+ for React 19 support.',
      package: '@apollo/client'
    }
  ],
  suggestedUpgradeOrder: [
    {
      step: 2,
      action: 'Bump react, react-dom, @types/react together',
      rationale: 'atomic commit'
    },
    {
      step: 1,
      action: 'Upgrade @apollo/client to 3.9.x',
      rationale: 'unblocks peer'
    }
  ],
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
      explanation: 'react-dom peer-pinned to React major.'
    }
  ],
  cost: {
    inputTokens: 2400,
    outputTokens: 1600,
    model: 'claude-opus-4-7',
    costEstimateUsd: 0.048
  }
};

describe('DeepUpdateReportView (View [D-Deep])', () => {
  it('renders summary, risk + effort pills, transitive tiles, CVE delta, peer-deps, blockers, narrative, upgrade order', async () => {
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
        deepReports: { 'p::react::18.2.0::19.0.0': envelope(fullDeepReport) }
      }
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Major upgrade. React 19/)
      ).toBeInTheDocument()
    );
    // Pills
    expect(screen.getByTestId('risk-pill-high')).toHaveTextContent('high');
    expect(screen.getByTestId('effort-pill-large')).toHaveTextContent('large');

    // Transitive tiles
    expect(screen.getByTestId('tile-added')).toHaveTextContent('2');
    expect(screen.getByTestId('tile-removed')).toHaveTextContent('1');
    expect(screen.getByTestId('tile-upgraded')).toHaveTextContent('1');
    expect(screen.getByText(/1,825 transitive packages total\./)).toBeInTheDocument();

    // CVE delta
    expect(screen.getByTestId('cve-resolved-head')).toHaveTextContent(
      'Resolved by upgrade (1)'
    );
    expect(screen.getByTestId('cve-new-head')).toHaveTextContent(
      'New CVEs introduced (1)'
    );
    expect(screen.getByTestId('cve-resolved-CVE-2024-1234')).toHaveTextContent(
      'in css-tools'
    );
    expect(screen.getByTestId('cve-new-CVE-2025-0099')).toHaveTextContent(
      'Prototype pollution'
    );

    // Peer-deps
    expect(screen.getByTestId('peer-@apollo/client')).toHaveTextContent('Conflict');
    expect(screen.getByTestId('peer-styled-components')).toHaveTextContent('OK');

    // Critical blockers
    expect(screen.getByTestId('blocker-@apollo/client')).toHaveTextContent(
      'peer mismatch'
    );

    // Narrative — 3 paragraphs
    const narrative = screen.getByTestId('narrative-body');
    expect(narrative.getAttribute('data-paragraph-count')).toBe('3');

    // Upgrade order — sorted by step ascending
    const list = screen.getByTestId('upgrade-order-list');
    const items = list.querySelectorAll('[data-testid^="upgrade-step-"]');
    expect(items[0]).toHaveAttribute('data-testid', 'upgrade-step-1');
    expect(items[1]).toHaveAttribute('data-testid', 'upgrade-step-2');

    // Download buttons present + enabled
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
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: { p: projectDetail('p') },
        deepReports: {}
      }
    });

    await waitFor(() =>
      expect(screen.getByText('No deep analysis yet.')).toBeInTheDocument()
    );
    expect(screen.getByTestId('empty-state-action')).toHaveTextContent(
      'Generate deep report'
    );
  });

  it('narrative paragraph count adapts to risk level (low: 1, high: many)', async () => {
    for (const variant of [
      { risk: 'low' as const, narrative: 'Single paragraph for low risk.', expected: '1' },
      {
        risk: 'high' as const,
        narrative: 'Para one.\n\nPara two.\n\nPara three.\n\nPara four.',
        expected: '4'
      }
    ]) {
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
          deepReports: {
            'p::react::18.2.0::19.0.0': envelope({
              ...fullDeepReport,
              riskLevel: variant.risk,
              narrative: variant.narrative
            })
          }
        }
      });
      await waitFor(() => {
        const n = screen.getByTestId('narrative-body');
        expect(n.getAttribute('data-paragraph-count')).toBe(variant.expected);
      });
      unmount();
    }
  });
});
