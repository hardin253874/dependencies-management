/**
 * Stage 4 — Project orphan flow (spec §6.3, Wireframe 26).
 *
 * Covers:
 *   - Project rows with `pathExists === false` render an inline amber banner
 *     with Relocate / Remove buttons.
 *   - Clicking Relocate opens the RelocateProjectModal (Picker reused from
 *     Add Project).
 *   - Submitting a new valid path PATCHes /api/projects/:slug/relocate; slug
 *     is preserved.
 *   - Clicking Remove opens the RemoveProjectModal; confirming DELETEs the
 *     project from /api/projects.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { LeftPanel } from '@/components/LeftPanel/LeftPanel';

describe('Project orphan flow', () => {
  it('renders an orphan banner under a project whose pathExists is false', async () => {
    renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [
          {
            slug: 'broken',
            name: 'legacy-shop',
            path: '/old/location',
            packageManager: 'npm',
            depCount: 12,
            lastScanAt: null,
            pathExists: false
          },
          {
            slug: 'ok',
            name: 'my-app',
            path: '/here',
            packageManager: 'npm',
            depCount: 4,
            lastScanAt: null,
            pathExists: true
          }
        ]
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('project-orphan-broken')).toBeInTheDocument()
    );
    // 'ok' project does not get a banner.
    expect(screen.queryByTestId('project-orphan-ok')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-orphan-relocate-broken')).toBeInTheDocument();
    expect(screen.getByTestId('project-orphan-remove-broken')).toBeInTheDocument();
  });

  it('Relocate opens the modal with the old path; submitting PATCHes /relocate', async () => {
    const { fetcher } = renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [
          {
            slug: 'broken',
            name: 'legacy-shop',
            path: '/old/location',
            packageManager: 'npm',
            depCount: 12,
            lastScanAt: null,
            pathExists: false
          }
        ]
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('project-orphan-relocate-broken')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('project-orphan-relocate-broken'));

    // Modal opens.
    await waitFor(() =>
      expect(screen.getByText(/Relocate legacy-shop/)).toBeInTheDocument()
    );
    expect(screen.getByText('/old/location')).toBeInTheDocument();

    // Type a new path; validation is stubbed in the fake fetcher to return ok.
    const pickerInput = screen.getByTestId('picker-input');
    await userEvent.type(pickerInput, '/new/path');

    // Wait for validation to enable submit.
    await waitFor(
      () => expect(screen.getByTestId('relocate-submit')).toBeEnabled(),
      { timeout: 2000 }
    );

    await userEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => {
      const calls = (fetcher as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      const found = calls.some(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).endsWith('/api/projects/broken/relocate') &&
          (c[1] as RequestInit)?.method === 'PATCH'
      );
      expect(found).toBe(true);
    });
  });

  it('Remove opens the confirmation; confirm DELETEs the project', async () => {
    const { fetcher } = renderWithProviders(<LeftPanel />, {
      backend: {
        projects: [
          {
            slug: 'broken',
            name: 'legacy-shop',
            path: '/old/location',
            packageManager: 'npm',
            depCount: 12,
            lastScanAt: null,
            pathExists: false
          }
        ]
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('project-orphan-remove-broken')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('project-orphan-remove-broken'));

    await waitFor(() =>
      expect(screen.getByTestId('remove-confirm')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('remove-confirm'));

    await waitFor(() => {
      const calls = (fetcher as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      const found = calls.some(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).startsWith('/api/projects/broken') &&
          (c[1] as RequestInit)?.method === 'DELETE'
      );
      expect(found).toBe(true);
    });
  });
});
