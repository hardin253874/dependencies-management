/**
 * Stage 3 — Orphan banner (Stage 2 carry-over M3 verification, spec §10.10).
 *
 * When `GET /api/jobs` returns an `orphans[]` entry whose slug matches a
 * registered project, the LeftPanel renders an `OrphanBanner` with:
 *   - "Previous job interrupted" copy.
 *   - A subtitle derived from the orphan's `resourceKey` (kind + name).
 *   - **Re-run** action — POSTs the matching refresh endpoint inferred from
 *     the resourceKey kind (`reports`, `file-reviews`, `usage`, etc.).
 *   - **Discard** action — DELETE /api/jobs/orphans/:slug/:jobId only.
 *
 * Banners for orphans whose slug is NOT registered must be suppressed.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { LeftPanel } from '@/components/LeftPanel/LeftPanel';
import type { JobOrphan, ProjectSummary } from '@/lib/api-types';

const projectStub: ProjectSummary = {
  slug: 'p',
  name: 'my-app',
  path: '/p',
  packageManager: 'npm',
  depCount: 0,
  lastScanAt: null,
  pathExists: true
};

function orphan(
  resourceKey: string,
  jobId = 'job-1',
  slug = 'p'
): JobOrphan {
  return {
    slug,
    jobId,
    kind: resourceKey.split(':')[0]!,
    resourceKey,
    createdAt: '2026-05-22T00:00:00.000Z',
    detectedAt: '2026-05-23T00:00:00.000Z'
  };
}

function getDeleteCalls(fetcher: typeof fetch): Array<string> {
  const f = fetcher as unknown as { mock: { calls: [string, RequestInit][] } };
  return f.mock.calls
    .filter(([, init]) => init?.method === 'DELETE')
    .map(([url]) => url);
}

function getPostCalls(fetcher: typeof fetch): Array<string> {
  const f = fetcher as unknown as { mock: { calls: [string, RequestInit][] } };
  return f.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url]) => url);
}

describe('OrphanBanner', () => {
  it('renders the banner when GET /api/jobs returns an orphan with a registered slug', async () => {
    renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [projectStub],
        jobs: { orphans: [orphan('reports:p:react:18.2.0:19.0.0')] }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('orphan-banner-job-1')).toBeInTheDocument()
    );
    const banner = screen.getByTestId('orphan-banner-job-1');
    expect(banner).toHaveTextContent('Previous job interrupted');
    expect(banner).toHaveTextContent(/Update report.*react/);
    expect(screen.getByTestId('orphan-rerun-job-1')).toBeInTheDocument();
    expect(screen.getByTestId('orphan-discard-job-1')).toBeInTheDocument();
  });

  it('hides the banner when the orphan slug is not registered', async () => {
    renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [projectStub],
        jobs: {
          orphans: [orphan('reports:other:react:18:19', 'job-x', 'other')]
        }
      }
    });
    // Wait for the project row to appear so the boot sequence ran.
    await waitFor(() =>
      expect(screen.getByText('my-app')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('orphan-banner-job-x')).toBeNull();
  });

  it('Re-run on a reports: orphan POSTs the report refresh endpoint and then DELETEs the journal', async () => {
    const { fetcher } = renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [projectStub],
        jobs: { orphans: [orphan('reports:p:react:18.2.0:19.0.0')] }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('orphan-rerun-job-1')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('orphan-rerun-job-1'));

    await waitFor(() => {
      const posts = getPostCalls(fetcher);
      const matched = posts.find((u) =>
        u.endsWith(
          '/api/projects/p/reports/react/18.2.0/19.0.0/refresh'
        )
      );
      expect(matched).toBeDefined();
    });

    await waitFor(() => {
      const deletes = getDeleteCalls(fetcher);
      expect(deletes).toContain('/api/jobs/orphans/p/job-1');
    });
  });

  it('Re-run on a file-reviews: orphan POSTs the file-review refresh endpoint', async () => {
    const { fetcher } = renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [projectStub],
        jobs: {
          orphans: [orphan('file-reviews:p:react:a3f9c1aa1234', 'job-2')]
        }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('orphan-rerun-job-2')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('orphan-rerun-job-2'));

    await waitFor(() => {
      const posts = getPostCalls(fetcher);
      expect(
        posts.find((u) =>
          u.endsWith('/api/projects/p/file-reviews/react/a3f9c1aa1234/refresh')
        )
      ).toBeDefined();
    });
  });

  it('Discard sends DELETE /api/jobs/orphans/:slug/:jobId and removes the banner', async () => {
    const { fetcher } = renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [projectStub],
        jobs: { orphans: [orphan('reports:p:react:18.2.0:19.0.0')] }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('orphan-discard-job-1')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('orphan-discard-job-1'));

    await waitFor(() => {
      const deletes = getDeleteCalls(fetcher);
      expect(deletes).toContain('/api/jobs/orphans/p/job-1');
    });

    // Banner disappears optimistically after the discard succeeds.
    await waitFor(() =>
      expect(screen.queryByTestId('orphan-banner-job-1')).toBeNull()
    );
  });
});
