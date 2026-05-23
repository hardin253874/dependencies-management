/**
 * Stage 3 — View [E] File-Level AI Review (happy path).
 *
 * Covers (spec §7.6, Appendix A.2, WIREFRAMES.md #14):
 *   - File path + last-reviewed timestamp header.
 *   - Summary section + quality verdict pill.
 *   - Findings list with kind pill, severity pill, line number, message.
 *   - Empty findings: friendly "No findings — usage looks correct and modern."
 *   - Expanding a finding reveals suggestion + confidence.
 *   - Empty-state CTA on 404 NOT_CACHED.
 *
 * The file-hash stale banner has a dedicated sibling test file.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import type { FileEnvelope, FileReviewDetail, ProjectDetail } from '@/lib/api-types';

const PATH_HASH = 'a3f9c1aa1234';
const FILE_PATH = 'src/components/App.tsx';

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

function withRoute(): void {
  window.localStorage.setItem(
    'dep-agent:ui.detailRoute',
    JSON.stringify({
      kind: 'E',
      depName: 'react',
      pathHash: PATH_HASH,
      filePath: FILE_PATH
    })
  );
}

function envelope(data: FileReviewDetail): FileEnvelope<FileReviewDetail> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-23T00:00:00.000Z',
    source: 'anthropic:claude-opus-4-7',
    ttlHours: 720,
    data
  };
}

const projectStub = {
  slug: 'p',
  name: 'my-app',
  path: '/p',
  packageManager: 'npm' as const,
  depCount: 0,
  lastScanAt: null,
  pathExists: true
};

const sampleReview: FileReviewDetail = {
  filePath: FILE_PATH,
  pathHash: PATH_HASH,
  fileHashAtReview: 'sha256-aaaa',
  lastReviewedAt: '2026-05-22T00:00:00.000Z',
  stale: false,
  summary: 'File uses React hooks idiomatically; one deprecated callback.',
  depUsageQuality: 'outdated',
  findings: [
    {
      kind: 'outdated-pattern',
      severity: 'medium',
      message: 'React.useCallback dependency missing.',
      line: 42,
      suggestion: 'Add `searchTerm` to the dependency array.',
      confidence: 'high'
    },
    {
      kind: 'deprecation-warning',
      severity: 'low',
      message: 'componentWillMount is deprecated.',
      line: 88,
      confidence: 'medium'
    }
  ]
};

describe('FileReviewView (View [E])', () => {
  it('renders file path, last-reviewed timestamp, summary, quality pill, and findings', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub],
        projectDetails: { p: projectDetail('p') },
        fileReviews: { [`p::react::${PATH_HASH}`]: envelope(sampleReview) }
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('file-review-path')).toHaveTextContent(FILE_PATH)
    );
    expect(screen.getByTestId('last-reviewed')).toHaveTextContent('Last reviewed');
    expect(
      screen.getByText(/File uses React hooks idiomatically/)
    ).toBeInTheDocument();

    // Quality pill renders the "outdated" variant.
    expect(screen.getByTestId('quality-pill-outdated')).toHaveTextContent(
      'outdated'
    );

    // Both findings render with their kind + severity pills + line numbers.
    expect(screen.getByTestId('finding-0')).toBeInTheDocument();
    expect(screen.getByTestId('finding-sev-medium')).toBeInTheDocument();
    expect(screen.getByTestId('finding-kind-outdated-pattern')).toBeInTheDocument();
    expect(screen.getByTestId('finding-0-line')).toHaveTextContent('line 42');
    expect(
      screen.getByText('React.useCallback dependency missing.')
    ).toBeInTheDocument();

    expect(screen.getByTestId('finding-1')).toBeInTheDocument();
    expect(screen.getByTestId('finding-sev-low')).toBeInTheDocument();
    expect(
      screen.getByTestId('finding-kind-deprecation-warning')
    ).toBeInTheDocument();
  });

  it('expanding a finding row reveals the suggestion + confidence', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub],
        projectDetails: { p: projectDetail('p') },
        fileReviews: { [`p::react::${PATH_HASH}`]: envelope(sampleReview) }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('finding-0')).toBeInTheDocument()
    );
    // Click the row to expand.
    const header = screen.getByTestId('finding-0').querySelector('button')!;
    await userEvent.click(header);
    const details = screen.getByTestId('finding-0-details');
    expect(details).toHaveTextContent('Add `searchTerm` to the dependency array.');
    expect(details).toHaveTextContent('high');
  });

  it('renders the friendly empty-findings copy when findings list is empty', async () => {
    withRoute();
    const review: FileReviewDetail = {
      ...sampleReview,
      depUsageQuality: 'good',
      findings: []
    };
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub],
        projectDetails: { p: projectDetail('p') },
        fileReviews: { [`p::react::${PATH_HASH}`]: envelope(review) }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('findings-empty')).toBeInTheDocument()
    );
    expect(screen.getByTestId('findings-empty')).toHaveTextContent(
      'No findings — usage looks correct and modern.'
    );
    expect(screen.getByTestId('quality-pill-good')).toHaveTextContent('good');
  });

  it('renders the empty-state CTA when GET returns 404 NOT_CACHED', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub],
        projectDetails: { p: projectDetail('p') },
        fileReviews: {}
      }
    });
    await waitFor(() =>
      expect(screen.getByText('No review yet.')).toBeInTheDocument()
    );
    expect(screen.getByTestId('empty-state-action')).toHaveTextContent('Run review');
  });

  it('all quality-pill variants render their label', async () => {
    const qualities = ['good', 'outdated', 'incorrect', 'risky', 'unknown'] as const;
    for (const q of qualities) {
      window.localStorage.clear();
      withRoute();
      const { unmount } = renderWithProviders(<DetailPanel />, {
        backend: {
          projects: [projectStub],
          projectDetails: { p: projectDetail('p') },
          fileReviews: {
            [`p::react::${PATH_HASH}`]: envelope({
              ...sampleReview,
              depUsageQuality: q,
              findings: []
            })
          }
        }
      });
      await waitFor(() =>
        expect(screen.getByTestId(`quality-pill-${q}`)).toHaveTextContent(q)
      );
      unmount();
    }
  });
});
