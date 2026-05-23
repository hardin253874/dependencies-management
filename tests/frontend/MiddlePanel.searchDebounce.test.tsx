/**
 * Stage 4 — Search input debouncing (spec §13, IMPLEMENTATION_PLAN.md Stage 4).
 *
 * The middle panel filters/sorts on the debounced search term, not the raw
 * keystroke. This protects 300+ dep projects from re-running the
 * O(N log N) sort + filter pipeline on every character.
 *
 * The input itself remains controlled by the raw `search` state so keystrokes
 * don't lag visually; only the heavy `useMemo` waits.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { MiddlePanel } from '@/components/MiddlePanel/MiddlePanel';
import type { ProjectDetail } from '@/lib/api-types';

function project(): ProjectDetail {
  return {
    schemaVersion: 1,
    name: 'my-app',
    slug: 'p',
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
        installedVersion: '18.2.0',
        badges: {
          outdatedSeverity: null,
          hasCve: false,
          deprecated: false,
          lastScannedAt: null
        }
      },
      {
        name: 'react-dom',
        section: 'dependencies',
        declaredRange: '^18.0.0',
        installedVersion: '18.2.0',
        badges: {
          outdatedSeverity: null,
          hasCve: false,
          deprecated: false,
          lastScannedAt: null
        }
      },
      {
        name: 'lodash',
        section: 'dependencies',
        declaredRange: '^4.17.0',
        installedVersion: '4.17.21',
        badges: {
          outdatedSeverity: null,
          hasCve: false,
          deprecated: false,
          lastScannedAt: null
        }
      }
    ]
  };
}

describe('MiddlePanel search debounce', () => {
  it('debounces filter application — list updates only after the debounce window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderWithProviders(<MiddlePanel />, {
        backend: {
          projects: [
            {
              slug: 'p',
              name: 'my-app',
              path: '/p',
              packageManager: 'npm',
              depCount: 3,
              lastScanAt: null,
              pathExists: true
            }
          ],
          projectDetails: { p: project() }
        }
      });

      await waitFor(() => expect(screen.getByText('react-dom')).toBeInTheDocument());
      expect(screen.getByText('lodash')).toBeInTheDocument();

      // Type "lod" — input value should be visible immediately.
      await userEvent.type(screen.getByTestId('dep-search'), 'lod');
      expect((screen.getByTestId('dep-search') as HTMLInputElement).value).toBe('lod');

      // Before the debounce fires, all three rows are still in the DOM.
      expect(screen.getByText('react')).toBeInTheDocument();
      expect(screen.getByText('react-dom')).toBeInTheDocument();
      expect(screen.getByText('lodash')).toBeInTheDocument();

      // Advance timers past the debounce window (200ms).
      await act(async () => {
        vi.advanceTimersByTime(250);
      });

      await waitFor(() =>
        expect(screen.queryByText('react-dom')).not.toBeInTheDocument()
      );
      expect(screen.getByText('lodash')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearing the search applies immediately (no debounce on empty)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderWithProviders(<MiddlePanel />, {
        backend: {
          projects: [
            {
              slug: 'p',
              name: 'my-app',
              path: '/p',
              packageManager: 'npm',
              depCount: 3,
              lastScanAt: null,
              pathExists: true
            }
          ],
          projectDetails: { p: project() }
        }
      });

      await waitFor(() => expect(screen.getByText('lodash')).toBeInTheDocument());

      // Type "lod", flush debounce.
      await userEvent.type(screen.getByTestId('dep-search'), 'lod');
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      await waitFor(() =>
        expect(screen.queryByText('react-dom')).not.toBeInTheDocument()
      );

      // Clear the input — empty term is felt immediately.
      await userEvent.clear(screen.getByTestId('dep-search'));
      await waitFor(() =>
        expect(screen.getByText('react-dom')).toBeInTheDocument()
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
