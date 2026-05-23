/**
 * Stage 3 — StatusBar behavior for AI jobs (spec §7.9 + §11.8).
 *
 *   - When the active job's progress phase is `ai`, the status bar renders the
 *     status text only (no progress bar, no JSON).
 *   - Defensive guard: if the BE ever forwards a JSON-shaped label, the UI
 *     substitutes the generic "Generating analysis…" copy.
 *   - When the phase is `retry` (rate-limit), the amber retry message renders.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers/renderWithProviders';
import { StatusBar } from '@/components/StatusBar';
import type { JobRecord } from '@/lib/api-types';

function aiJob(label: string, jobId = 'job-ai-1'): JobRecord {
  return {
    jobId,
    slug: 'p',
    resourceKey: 'reports:p:react:18.2.0:19.0.0',
    kind: 'report',
    state: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: {
      current: 0,
      total: 0,
      label,
      phase: 'ai'
    },
    error: null,
    resultUrl: null
  };
}

function retryJob(label: string): JobRecord {
  return {
    jobId: 'job-retry-1',
    slug: 'p',
    resourceKey: 'reports:p:react:18.2.0:19.0.0',
    kind: 'report',
    state: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: {
      current: 0,
      total: 0,
      label,
      phase: 'retry',
      attempt: 1,
      maxAttempts: 3
    },
    error: null,
    resultUrl: null
  };
}

describe('StatusBar AI phase', () => {
  it('renders the AI status text only — no progress bar, no JSON', async () => {
    renderWithProviders(<StatusBar />, {
      backend: { jobs: { jobs: [aiJob('Calling Anthropic…')] } }
    });
    await waitFor(() =>
      expect(screen.getByTestId('status-ai-text')).toHaveTextContent(
        'Calling Anthropic…'
      )
    );
    // No progress bar.
    expect(screen.queryByRole('progressbar')).toBeNull();
    // No raw JSON visible.
    expect(screen.queryByText(/[{[]/)).toBeNull();
    // Cancel button still present.
    expect(
      screen.getByRole('button', { name: 'Cancel job' })
    ).toBeInTheDocument();
  });

  it('switches the label as the AI phase advances', async () => {
    renderWithProviders(<StatusBar />, {
      backend: {
        jobs: { jobs: [aiJob('Finalizing structured output…')] }
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId('status-ai-text')).toHaveTextContent(
        'Finalizing structured output…'
      )
    );
  });

  it('substitutes generic copy when the label looks like JSON (defensive)', async () => {
    // Simulate a malformed BE push that leaked tool-use JSON into the label.
    renderWithProviders(<StatusBar />, {
      backend: { jobs: { jobs: [aiJob('{"partial": "tool-use"}')] } }
    });
    await waitFor(() =>
      expect(screen.getByTestId('status-ai-text')).toHaveTextContent(
        'Generating analysis…'
      )
    );
    // No JSON characters visible.
    expect(screen.queryByText(/"partial"/)).toBeNull();
  });

  it('renders the amber rate-limit copy when phase is retry', async () => {
    renderWithProviders(<StatusBar />, {
      backend: { jobs: { jobs: [retryJob('attempt 2/3')] } }
    });
    await waitFor(() =>
      expect(screen.getByText(/Rate limited, retrying/)).toBeInTheDocument()
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
