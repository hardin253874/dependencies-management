/**
 * v2 Stage 5b.8 / 5b.9 UI: Jev switches round trip (PATCH /api/config),
 * per-project privacy round trip (PATCH /api/projects/:slug), the routing
 * line and J2 badges; old envelopes without the new fields render nothing new.
 */
import { describe, expect, it, vi } from 'vitest';
import { useEffect, type JSX } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { JudgeSettings } from '@/components/modals/settings/JudgeSettings';
import { RoutingLine, SupportBadge } from '@/components/RightPanel/JudgeBadges';
import { useAppContext } from '@/components/AppContext';
import type { ConfigResponse, ProjectSummary } from '@/lib/api-types';

const CONFIG: ConfigResponse = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-5-5' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  apiKeys: { hasAnthropicKey: true, hasTypesafeKey: false },
  judge: { enabled: true, router: false, flags: { J1: false, J2: false, J3: false, J4: false, J5: false, J6: false, J7: false, J8: false } }
};

const PROJECT: ProjectSummary = { slug: 'demo', name: 'demo', path: 'C:/demo', packageManager: 'npm', depCount: 1, lastScanAt: null, pathExists: true };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function SelectDemo({ children }: { children: JSX.Element }): JSX.Element {
  const { selectProject } = useAppContext();
  useEffect(() => selectProject('demo'), [selectProject]);
  return children;
}

describe('JudgeSettings', () => {
  it('toggling the router and a flag PATCHes judge switches; key presence shown', async () => {
    const patches: unknown[] = [];
    renderWithProviders(<JudgeSettings />, {
      backend: {
        config: CONFIG,
        custom: {
          '/api/config': vi.fn(async (init: RequestInit) => {
            if (init.method === 'PATCH') patches.push(JSON.parse(init.body as string));
            return json(CONFIG);
          })
        }
      }
    });
    expect(await screen.findByText(/No TypeSafe key/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('judge-flag-J5')).not.toBeDisabled());
    await userEvent.click(screen.getByTestId('judge-router'));
    await userEvent.click(screen.getByTestId('judge-flag-J5'));
    await waitFor(() => expect(patches).toEqual([{ judge: { router: true } }, { judge: { flags: { J5: true } } }]));
  });

  it('project privacy select PATCHes the project; not-set means treated as private', async () => {
    const patches: unknown[] = [];
    renderWithProviders(
      <SelectDemo>
        <JudgeSettings />
      </SelectDemo>,
      {
        backend: {
          config: CONFIG,
          projects: [PROJECT],
          custom: {
            '/api/projects/demo': vi.fn(async (init: RequestInit) => {
              patches.push({ method: init.method, body: JSON.parse(init.body as string) });
              return json({ ...PROJECT, privacy: 'public' });
            })
          }
        }
      }
    );
    const select = (await screen.findByTestId('project-privacy')) as HTMLSelectElement;
    expect(select.value).toBe('unknown');
    expect(screen.getByText(/treated as private/)).toBeInTheDocument();
    await userEvent.selectOptions(select, 'public');
    await waitFor(() => expect(patches).toEqual([{ method: 'PATCH', body: { privacy: 'public' } }]));
  });
});

describe('RoutingLine / SupportBadge', () => {
  it('renders model, reason and via; nothing for old envelopes', () => {
    const { rerender } = render(<RoutingLine routing={{ model: 'claude-sonnet-5-5', effort: 'medium', via: 'jev', reason: 'Jev: moderate (confidence 0.90) → Sonnet 5.5' }} />);
    expect(screen.getByTestId('routing-line')).toHaveTextContent('Model: Sonnet 5.5 — Jev: moderate (confidence 0.90) → Sonnet 5.5 (Jev)');
    rerender(<RoutingLine routing={undefined} />);
    expect(screen.queryByTestId('routing-line')).toBeNull();
  });

  it('support badges: low / unclear / none', () => {
    const { rerender } = render(<SupportBadge support="low" />);
    expect(screen.getByTestId('support-low')).toHaveTextContent('low support (Jev)');
    rerender(<SupportBadge support="unclear" />);
    expect(screen.getByTestId('support-unclear')).toBeInTheDocument();
    rerender(<SupportBadge support={undefined} />);
    expect(screen.queryByTestId('support-low')).toBeNull();
  });
});
