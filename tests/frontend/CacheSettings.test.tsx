/**
 * Stage 4 — Settings → Cache section (spec §7.7, Wireframe 17).
 *
 * Covers:
 *   - Preview → dry-run returns counts only; Delete button enabled only after.
 *   - Delete → non-dry-run actually invokes the BE prune.
 *   - Default olderThanDays is 30.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { CacheSettings } from '@/components/modals/settings/CacheSettings';

describe('CacheSettings (Stage 4)', () => {
  it('Preview runs dry-run and shows the count; Delete button enabled', async () => {
    const onPrune = vi.fn();
    renderWithProviders(<CacheSettings />, {
      backend: {
        projects: [],
        onPrune,
        prune: {
          dryRun: {
            dryRun: true,
            olderThanDays: 30,
            pruned: { files: 12, bytes: 4_500_000 },
            byKind: {
              deps: { files: 0, bytes: 0 },
              versions: { files: 0, bytes: 0 },
              usage: { files: 0, bytes: 0 },
              reports: { files: 8, bytes: 3_000_000 },
              'deep-reports': { files: 4, bytes: 1_500_000 },
              'file-reviews': { files: 0, bytes: 0 }
            }
          },
          commit: {
            dryRun: false,
            olderThanDays: 30,
            pruned: { files: 12, bytes: 4_500_000 },
            byKind: {
              deps: { files: 0, bytes: 0 },
              versions: { files: 0, bytes: 0 },
              usage: { files: 0, bytes: 0 },
              reports: { files: 8, bytes: 3_000_000 },
              'deep-reports': { files: 4, bytes: 1_500_000 },
              'file-reviews': { files: 0, bytes: 0 }
            }
          }
        }
      }
    });

    expect(screen.getByTestId('prune-delete')).toBeDisabled();

    await userEvent.click(screen.getByTestId('prune-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('prune-preview-result')).toHaveTextContent(
        '12 reports would be deleted'
      )
    );
    // The Delete button is now enabled.
    expect(screen.getByTestId('prune-delete')).toBeEnabled();
    // The preview hook was invoked with dryRun=true.
    expect(onPrune).toHaveBeenCalledWith(30, true);
  });

  it('Delete invokes prune with dryRun=false and shows result', async () => {
    const onPrune = vi.fn();
    renderWithProviders(<CacheSettings />, {
      backend: {
        projects: [],
        onPrune,
        prune: {
          dryRun: {
            dryRun: true,
            olderThanDays: 30,
            pruned: { files: 5, bytes: 1000 },
            byKind: {} as never
          },
          commit: {
            dryRun: false,
            olderThanDays: 30,
            pruned: { files: 5, bytes: 1000 },
            byKind: {} as never
          }
        }
      }
    });

    await userEvent.click(screen.getByTestId('prune-preview'));
    await waitFor(() => expect(screen.getByTestId('prune-delete')).toBeEnabled());
    await userEvent.click(screen.getByTestId('prune-delete'));
    await waitFor(() =>
      expect(screen.getByTestId('prune-delete-result')).toHaveTextContent('Removed 5')
    );
    expect(onPrune).toHaveBeenLastCalledWith(30, false);
  });
});
