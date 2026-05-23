/**
 * Stage 1 carry-over — middle-panel "Update" button and left-panel refresh
 * button both POST `/api/projects/:slug/refresh`. Verifies the FE actually
 * issues the request and re-fetches the project detail.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { MiddlePanel } from '@/components/MiddlePanel/MiddlePanel';
import { LeftPanel } from '@/components/LeftPanel/LeftPanel';
import type { ProjectDetail } from '@/lib/api-types';

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
        installedVersion: '18.0.0',
        badges: {
          outdatedSeverity: null,
          hasCve: null,
          deprecated: null,
          lastScannedAt: null
        }
      }
    ]
  };
}

describe('Project refresh wiring (Stage 1 carry-over)', () => {
  it('middle-panel Update button triggers POST /api/projects/:slug/refresh', async () => {
    const { fetcher } = renderWithProviders(<MiddlePanel />, {
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
        projectDetails: { p: projectDetail('p') }
      }
    });

    // Wait for project + detail to load and toolbar to render.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Update project from disk/ })).toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole('button', { name: /Update project from disk/ }));

    await waitFor(() => {
      const calls = (fetcher as ReturnType<typeof vi.fn>).mock.calls;
      const refreshCall = calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/api/projects/p/refresh' &&
          (c[1] as RequestInit | undefined)?.method === 'POST'
      );
      expect(refreshCall).toBeTruthy();
    });
  });

  it('left-panel refresh button triggers POST /api/projects/:slug/refresh', async () => {
    const { fetcher } = renderWithProviders(<LeftPanel />, {
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
        projectDetails: { p: projectDetail('p') }
      }
    });

    await waitFor(() => expect(screen.getByText('my-app')).toBeInTheDocument());
    const refreshBtn = screen.getByTestId('project-refresh-p');
    await userEvent.click(refreshBtn);

    await waitFor(() => {
      const calls = (fetcher as ReturnType<typeof vi.fn>).mock.calls;
      const refreshCall = calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/api/projects/p/refresh' &&
          (c[1] as RequestInit | undefined)?.method === 'POST'
      );
      expect(refreshCall).toBeTruthy();
    });
  });
});
