import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers/renderWithProviders';
import { StatusBar } from '@/components/StatusBar';
import type { JobRecord } from '@/lib/api-types';

describe('StatusBar', () => {
  it('renders Idle when no active jobs', async () => {
    renderWithProviders(<StatusBar />);
    await waitFor(() => {
      expect(screen.getByText('Idle')).toBeInTheDocument();
    });
  });

  it('renders bounded progress when a running job has current/total', async () => {
    const job: JobRecord = {
      jobId: 'j1',
      slug: 'demo',
      resourceKey: 'demo:scan',
      kind: 'scan',
      state: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: {
        current: 423,
        total: 2143,
        label: 'react-dom',
        phase: 'scan'
      },
      error: null,
      resultUrl: null
    };
    renderWithProviders(<StatusBar />, {
      backend: {
        jobs: { jobs: [job] }
      }
    });

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
    expect(screen.getByText(/423 \/ 2,143 — react-dom/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument();
  });
});
