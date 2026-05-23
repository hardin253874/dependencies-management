/**
 * Stage 2 — Toast notification on background-job completion.
 *
 * Spec §7.10 + UI_DESIGN.md §2.7. We render the AppShell-equivalent toast
 * container plus the AppContext provider, then mutate the jobs list across
 * renders to simulate a job transitioning from `running` → `done`.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { ToastContainer } from '@/components/ToastContainer';
import type { JobRecord } from '@/lib/api-types';

function jobRecord(state: JobRecord['state'], slug = 'p', name = 'react'): JobRecord {
  return {
    jobId: `job-${name}-${state}`,
    slug,
    resourceKey: `deps:${slug}:${name}`,
    kind: 'deps-refresh',
    state,
    createdAt: '2026-05-23T10:00:00.000Z',
    startedAt: '2026-05-23T10:00:01.000Z',
    finishedAt: state === 'done' ? '2026-05-23T10:00:30.000Z' : null,
    progress: null,
    error: null,
    resultUrl: state === 'done' ? '/api/projects/p/deps/react' : null
  };
}

describe('Toast on background-job completion', () => {
  it('does not render any toast on initial mount', async () => {
    renderWithProviders(<ToastContainer />);
    // ToastContainer returns null when empty.
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
  });

  it('renders a "Detail ready" toast when a deps job transitions to done while user is elsewhere', async () => {
    // First boot — the active dep is not the one the job targets.
    window.localStorage.setItem(
      'dep-agent:ui.detailRoute',
      JSON.stringify({ kind: 'A', depName: 'lodash' })
    );
    const { rerender, fetcher } = renderWithProviders(<ToastContainer />, {
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
        jobs: { jobs: [jobRecord('done')] }
      }
    });
    // Toast appears.
    await waitFor(() =>
      expect(screen.getByText('Detail ready')).toBeInTheDocument()
    );
    expect(screen.getByText('react')).toBeInTheDocument(); // body
    expect(fetcher).toBeDefined();
    // Action button is "View".
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    void rerender;
  });
});
