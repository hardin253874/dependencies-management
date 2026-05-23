/**
 * Stage 4 — Settings → Library section (spec §7.7, Wireframe 16).
 *
 * Covers:
 *   - Total library size populates from `GET /api/library/size`.
 *   - Per-category breakdown rows render.
 *   - "Open in file explorer" calls the BE; falls back to friendly message
 *     when BE returns 501 (not yet implemented).
 *   - "Clear all logs" calls `POST /api/logs/clear`, displays count + size.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { LibrarySettings } from '@/components/modals/settings/LibrarySettings';

describe('LibrarySettings (Stage 4)', () => {
  it('renders total size + per-category breakdown from GET /api/library/size', async () => {
    renderWithProviders(<LibrarySettings />, {
      backend: {
        projects: [],
        librarySize: {
          totalBytes: 12_500_000,
          byKind: {
            deps: 4_000_000,
            versions: 2_000_000,
            usage: 1_000_000,
            reports: 3_000_000,
            'deep-reports': 1_500_000,
            'file-reviews': 800_000,
            logs: 200_000,
            config: 0
          }
        }
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('library-total-size')).toHaveTextContent('12.5 MB')
    );
    expect(screen.getByTestId('library-byKind-deps')).toHaveTextContent('4.0 MB');
    expect(screen.getByTestId('library-byKind-deep-reports')).toHaveTextContent(
      '1.5 MB'
    );
  });

  it('Open in file explorer surfaces a friendly message when BE responds 501', async () => {
    renderWithProviders(<LibrarySettings />, {
      backend: {
        projects: [],
        librarySize: { totalBytes: 0, byKind: {} }
        // openInExplorer not set → 501 from the fake fetcher.
      }
    });

    await waitFor(() => expect(screen.getByTestId('open-in-explorer')).toBeEnabled());
    await userEvent.click(screen.getByTestId('open-in-explorer'));
    await waitFor(() =>
      expect(screen.getByTestId('open-message')).toHaveTextContent(
        'Open the library folder manually'
      )
    );
  });

  it('Clear all logs calls POST /api/logs/clear and shows the result', async () => {
    renderWithProviders(<LibrarySettings />, {
      backend: {
        projects: [],
        librarySize: { totalBytes: 0, byKind: {} },
        logsClear: { filesRemoved: 3, bytesRemoved: 256_000 }
      }
    });

    await waitFor(() => expect(screen.getByTestId('clear-logs')).toBeEnabled());
    await userEvent.click(screen.getByTestId('clear-logs'));
    await waitFor(() =>
      expect(screen.getByTestId('clear-logs-result')).toHaveTextContent('Removed 3')
    );
    expect(screen.getByTestId('clear-logs-result')).toHaveTextContent('256.0 KB');
  });
});
