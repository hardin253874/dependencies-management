/**
 * Stage 4 — Settings → Cost section (spec §7.7 + §11.11, Wireframe 18).
 *
 * Covers:
 *   - Per-project totals populate from `GET /api/projects/:slug/cost`.
 *   - Expand → renders the per-provider breakdown.
 *   - Grand total sums across projects.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { CostSettings } from '@/components/modals/settings/CostSettings';
import type { CostSummaryResponse } from '@/lib/api-types';

const summaryP1: CostSummaryResponse = {
  slug: 'p1',
  totalUsd: 2.41,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  count: 5,
  byProvider: {
    anthropic: [
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        count: 4,
        inputTokens: 80,
        outputTokens: 40,
        costUsd: 1.83
      }
    ],
    openai: [
      {
        provider: 'openai',
        model: 'gpt-5.5',
        count: 1,
        inputTokens: 20,
        outputTokens: 10,
        costUsd: 0.58
      }
    ]
  },
  byKind: {
    reports: { count: 3, costUsd: 1.41 },
    'deep-reports': { count: 1, costUsd: 0.6 },
    'file-reviews': { count: 1, costUsd: 0.4 }
  }
};

const summaryP2: CostSummaryResponse = {
  slug: 'p2',
  totalUsd: 7.92,
  totalInputTokens: 500,
  totalOutputTokens: 200,
  count: 12,
  byProvider: {
    anthropic: [],
    openai: [
      {
        provider: 'openai',
        model: 'gpt-5.5',
        count: 12,
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 7.92
      }
    ]
  },
  byKind: { reports: { count: 12, costUsd: 7.92 } }
};

describe('CostSettings (Stage 4)', () => {
  it('renders per-project totals and grand total', async () => {
    renderWithProviders(<CostSettings />, {
      backend: {
        projects: [
          {
            slug: 'p1',
            name: 'my-app',
            path: '/p1',
            packageManager: 'npm',
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          },
          {
            slug: 'p2',
            name: 'legacy-shop',
            path: '/p2',
            packageManager: 'npm',
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          }
        ],
        costSummaries: { p1: summaryP1, p2: summaryP2 }
      }
    });

    await waitFor(() => expect(screen.getByTestId('cost-row-p1')).toBeInTheDocument());
    expect(screen.getByTestId('cost-row-p1')).toHaveTextContent('my-app');
    expect(screen.getByTestId('cost-row-p1')).toHaveTextContent('$2.41');
    expect(screen.getByTestId('cost-row-p2')).toHaveTextContent('legacy-shop');
    expect(screen.getByTestId('cost-row-p2')).toHaveTextContent('$7.92');
    expect(screen.getByTestId('cost-grand-total')).toHaveTextContent('Total: $10.33');
  });

  it('clicking a row expands the provider breakdown', async () => {
    renderWithProviders(<CostSettings />, {
      backend: {
        projects: [
          {
            slug: 'p1',
            name: 'my-app',
            path: '/p1',
            packageManager: 'npm',
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          }
        ],
        costSummaries: { p1: summaryP1 }
      }
    });

    await waitFor(() => expect(screen.getByTestId('cost-row-p1')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('cost-row-p1').querySelector('button')!);
    await waitFor(() =>
      expect(screen.getByTestId('cost-provider-anthropic')).toHaveTextContent('$1.83')
    );
    expect(screen.getByTestId('cost-provider-openai')).toHaveTextContent('$0.58');
  });
});
