/**
 * Stage 3 — Cancel-confirmation modal (spec §7.9 + Wireframe 27).
 *
 * Covers:
 *   - StatusBar `✕` Cancel click opens the modal.
 *   - For AI jobs (resourceKey starts with `reports:` or `file-reviews:`, or
 *     phase === 'ai' / 'retry'), the cost-disclosure copy appears VERBATIM:
 *       "Note: any tokens already consumed by the in-flight LLM call are billed."
 *   - For non-AI jobs the cost-disclosure is suppressed; a deterministic body is
 *     shown instead.
 *   - "Keep running" closes the modal without cancelling.
 *   - "Cancel job" sends DELETE /api/jobs/:jobId and closes the modal.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { StatusBar } from '@/components/StatusBar';
import { CancelConfirmationModal } from '@/components/modals/CancelConfirmationModal';
import type { JobRecord } from '@/lib/api-types';

function aiJob(label = 'Generating analysis…'): JobRecord {
  return {
    jobId: 'job-ai-1',
    slug: 'p',
    resourceKey: 'reports:p:react:18.2.0:19.0.0',
    kind: 'report',
    state: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { current: 0, total: 0, label, phase: 'ai' },
    error: null,
    resultUrl: null
  };
}

function scanJob(): JobRecord {
  return {
    jobId: 'job-scan-1',
    slug: 'p',
    resourceKey: 'scan:p',
    kind: 'scan',
    state: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { current: 12, total: 100, label: 'react-dom', phase: 'scan' },
    error: null,
    resultUrl: null
  };
}

describe('CancelConfirmationModal', () => {
  it('opens when StatusBar Cancel is clicked on an AI job and shows the verbatim cost-disclosure', async () => {
    renderWithProviders(
      <>
        <StatusBar />
        <CancelConfirmationModal />
      </>,
      { backend: { jobs: { jobs: [aiJob('Calling Anthropic…')] } } }
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }));

    // Modal title + cost-disclosure copy (verbatim from spec §7.9).
    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: /Cancel/ })
      ).toBeInTheDocument()
    );
    const disclosure = screen.getByTestId('cancel-cost-disclosure');
    expect(disclosure).toHaveTextContent(
      'Note: any tokens already consumed by the in-flight LLM call are billed.'
    );

    // Both action buttons present.
    expect(screen.getByTestId('cancel-modal-keep')).toHaveTextContent(
      'Keep running'
    );
    expect(screen.getByTestId('cancel-modal-confirm')).toHaveTextContent(
      'Cancel job'
    );
  });

  it('hides the cost-disclosure on non-AI jobs', async () => {
    renderWithProviders(
      <>
        <StatusBar />
        <CancelConfirmationModal />
      </>,
      { backend: { jobs: { jobs: [scanJob()] } } }
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }));

    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: /Cancel/ })
      ).toBeInTheDocument()
    );
    // No cost-disclosure for non-AI jobs.
    expect(screen.queryByTestId('cancel-cost-disclosure')).toBeNull();
    // Deterministic body copy present instead.
    expect(screen.getByTestId('cancel-deterministic-body')).toBeInTheDocument();
  });

  it('Keep running closes the modal without calling cancel', async () => {
    const { fetcher } = renderWithProviders(
      <>
        <StatusBar />
        <CancelConfirmationModal />
      </>,
      { backend: { jobs: { jobs: [aiJob()] } } }
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Cancel/ })).toBeInTheDocument()
    );

    await userEvent.click(screen.getByTestId('cancel-modal-keep'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // No DELETE /api/jobs/:jobId was issued.
    const deleteCalls = (
      fetcher as unknown as { mock: { calls: [string, RequestInit][] } }
    ).mock.calls.filter(
      ([url, init]) => init?.method === 'DELETE' && url.startsWith('/api/jobs/')
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('Cancel job sends DELETE /api/jobs/:jobId and closes the modal', async () => {
    const { fetcher } = renderWithProviders(
      <>
        <StatusBar />
        <CancelConfirmationModal />
      </>,
      { backend: { jobs: { jobs: [aiJob()] } } }
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Cancel/ })).toBeInTheDocument()
    );

    await userEvent.click(screen.getByTestId('cancel-modal-confirm'));

    await waitFor(() => {
      const deleteCalls = (
        fetcher as unknown as { mock: { calls: [string, RequestInit][] } }
      ).mock.calls.filter(
        ([url, init]) =>
          init?.method === 'DELETE' && url === '/api/jobs/job-ai-1'
      );
      expect(deleteCalls).toHaveLength(1);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
