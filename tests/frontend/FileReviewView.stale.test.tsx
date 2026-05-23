/**
 * Stage 3 — View [E] file-hash staleness (spec §7.6 + Appendix A.2).
 *
 * When the BE compares `fileHashAtReview` against the current file hash and
 * they differ, the persisted payload has `data.stale === true`. The UI must
 * render an amber StaleCacheBanner ("File changed since this review.") with a
 * Regenerate button.
 *
 * The Regenerate button must POST the refresh endpoint.
 */
import { describe, expect, it, vi } from 'vitest';
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

function makeReview(stale: boolean): FileReviewDetail {
  return {
    filePath: FILE_PATH,
    pathHash: PATH_HASH,
    fileHashAtReview: 'sha256-aaaa',
    lastReviewedAt: '2026-05-22T00:00:00.000Z',
    stale,
    summary: 'File uses React hooks idiomatically.',
    depUsageQuality: 'good',
    findings: []
  };
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

describe('FileReviewView stale-file banner', () => {
  it('renders the stale banner with a Regenerate button when data.stale is true', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub],
        projectDetails: { p: projectDetail('p') },
        fileReviews: {
          [`p::react::${PATH_HASH}`]: envelope(makeReview(true))
        }
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('file-stale-banner')).toBeInTheDocument()
    );
    expect(screen.getByTestId('file-stale-banner')).toHaveTextContent(
      'File changed since this review.'
    );
    expect(screen.getByTestId('file-stale-regenerate')).toHaveTextContent(
      'Regenerate'
    );
  });

  it('does NOT render the stale banner when data.stale is false', async () => {
    withRoute();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub],
        projectDetails: { p: projectDetail('p') },
        fileReviews: {
          [`p::react::${PATH_HASH}`]: envelope(makeReview(false))
        }
      }
    });
    // Wait for body to render before asserting the banner is absent.
    await waitFor(() =>
      expect(screen.getByTestId('file-review-path')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('file-stale-banner')).toBeNull();
  });

  it('Regenerate button on the stale banner POSTs the refresh endpoint', async () => {
    withRoute();
    const onRefresh = vi.fn();
    renderWithProviders(<DetailPanel />, {
      backend: {
        projects: [projectStub],
        projectDetails: { p: projectDetail('p') },
        fileReviews: {
          [`p::react::${PATH_HASH}`]: envelope(makeReview(true))
        },
        onRefreshFileReview: onRefresh
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('file-stale-regenerate')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('file-stale-regenerate'));
    await waitFor(() =>
      expect(onRefresh).toHaveBeenCalledWith('p', 'react', PATH_HASH)
    );
  });
});
