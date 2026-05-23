import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Picker } from '@/components/modals/Picker';
import { ApiClient, setApiClient } from '@/lib/client/api-client';

describe('Picker — typed path validation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces typed input then calls GET /api/fs/validate', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('/api/fs/validate')) {
        return new Response(
          JSON.stringify({ ok: true, code: 'OK', message: 'Valid Next.js project (npm)' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.startsWith('/api/fs/list')) {
        return new Response(
          JSON.stringify({ path: '/', parent: null, entries: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });
    setApiClient(new ApiClient({ fetcher: fetcher as unknown as typeof fetch, csrfToken: 't' }));

    const onValidation = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Picker onChange={() => undefined} onValidation={onValidation} />);

    const input = screen.getByTestId('picker-input');
    await user.type(input, 'C:/dev/x');

    // Before debounce fires, no validate call.
    expect(
      fetcher.mock.calls.filter(([url]) => (url as string).startsWith('/api/fs/validate'))
    ).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await waitFor(() => {
      const validateCalls = fetcher.mock.calls.filter(([url]) =>
        (url as string).startsWith('/api/fs/validate')
      );
      expect(validateCalls.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(onValidation).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, code: 'OK' })
      );
    });
  });

  it('renders failure message when validate returns non-ok', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('/api/fs/validate')) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'NO_PACKAGE_JSON',
            message: 'No package.json found'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });
    setApiClient(new ApiClient({ fetcher: fetcher as unknown as typeof fetch, csrfToken: 't' }));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Picker onChange={() => undefined} onValidation={vi.fn()} />);

    await user.type(screen.getByTestId('picker-input'), '/x');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await waitFor(() => {
      expect(screen.getByText('No package.json found')).toBeInTheDocument();
    });
  });
});
