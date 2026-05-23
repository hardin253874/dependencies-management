/**
 * Stage 2 — View [C] Usage View.
 *
 * Covers:
 *   - File list grouped by category renders.
 *   - "Show test files" toggle hides/shows the Test group.
 *   - Dynamic-imports section appears when present.
 *   - "Declared but unused" indicator surfaces.
 *   - Click file → Stage-3 placeholder toast.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import { ToastContainer } from '@/components/ToastContainer';
import type { FileEnvelope, ProjectDetail, UsageDetail } from '@/lib/api-types';

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
    dependencies: []
  };
}

function withRoute(name = 'react'): void {
  window.localStorage.setItem(
    'dep-agent:ui.detailRoute',
    JSON.stringify({ kind: 'C', depName: name })
  );
}

function envelope(data: UsageDetail): FileEnvelope<UsageDetail> {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'deterministic',
    ttlHours: null,
    data
  };
}

const sampleUsage: UsageDetail = {
  files: [
    {
      path: 'src/components/App.tsx',
      pathHash: 'a3f9c1',
      category: 'prod',
      importStatements: ["import React from 'react'"],
      importCount: 1
    },
    {
      path: 'src/__tests__/App.test.tsx',
      pathHash: 'b1a2c3',
      category: 'test',
      importStatements: ["import { render } from 'react'"],
      importCount: 1
    },
    {
      path: 'src/components/App.stories.tsx',
      pathHash: 'c1b2d3',
      category: 'story',
      importStatements: ["import React from 'react'"],
      importCount: 1
    }
  ],
  dynamicImports: [
    {
      file: 'src/lib/lazy-loader.ts',
      line: 42,
      snippet: 'require(modName)'
    }
  ],
  totalFiles: 3,
  declaredButUnused: false,
  oversizedSkipped: []
};

describe('UsageView (View [C])', () => {
  it('renders files grouped by category', async () => {
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
        usage: { 'p::react': envelope(sampleUsage) }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('usage-group-prod')).toBeInTheDocument()
    );
    expect(screen.getByTestId('usage-group-test')).toBeInTheDocument();
    expect(screen.getByTestId('usage-group-story')).toBeInTheDocument();
    expect(screen.getByText('src/components/App.tsx')).toBeInTheDocument();
  });

  it('"Show test files" toggle hides the Test group when off', async () => {
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
        usage: { 'p::react': envelope(sampleUsage) }
      }
    });
    const toggle = await screen.findByTestId('show-test-files-toggle');
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.queryByTestId('usage-group-test')).toBeNull();
    expect(screen.getByTestId('usage-group-prod')).toBeInTheDocument();
  });

  it('renders the Dynamic imports section when present', async () => {
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
        usage: { 'p::react': envelope(sampleUsage) }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('dynamic-imports-section')).toBeInTheDocument()
    );
    expect(screen.getByText('src/lib/lazy-loader.ts:42')).toBeInTheDocument();
  });

  it('renders the "Declared but unused" callout when payload sets the flag', async () => {
    withRoute();
    const usage: UsageDetail = {
      files: [],
      dynamicImports: [],
      totalFiles: 0,
      declaredButUnused: true,
      oversizedSkipped: []
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
        usage: { 'p::react': envelope(usage) }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('declared-but-unused')).toBeInTheDocument()
    );
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
        usage: {}
      }
    });
    await waitFor(() =>
      expect(screen.getByText('No usage scan yet.')).toBeInTheDocument()
    );
    expect(screen.getByTestId('empty-state-action')).toHaveTextContent('Scan usage');
  });

  it('click on a file navigates to view [E] (Stage 3)', async () => {
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
              depCount: 0,
              lastScanAt: null,
              pathExists: true
            }
          ],
          projectDetails: { p: projectDetail('p') },
          usage: { 'p::react': envelope(sampleUsage) }
          // file-reviews cache empty → [E] will render empty-state CTA
        }
      }
    );
    await userEvent.click(await screen.findByTestId('usage-file-a3f9c1'));
    // Navigated to [E]; empty-state appears because file-reviews cache is empty.
    await waitFor(() =>
      expect(screen.getByText('No review yet.')).toBeInTheDocument()
    );
  });
});
