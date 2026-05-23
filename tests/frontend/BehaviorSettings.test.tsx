/**
 * Stage 3 — Settings → Behavior (spec §7.7 + Wireframe 19).
 *
 * Two persistent toggles:
 *   1. "Show Deep Analyze cost warning" — patches `ui.showDeepAnalyzeWarning`.
 *   2. "Enable resolver check" (kill-switch) — patches
 *      `features.resolverCheckEnabled`. Per spec §7.7 the change takes effect
 *      without restart (the BE re-reads _config.json on every request).
 *
 * Tests assert each toggle issues the correct PATCH /api/config body.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { BehaviorSettings } from '@/components/modals/settings/BehaviorSettings';
import type { ConfigResponse } from '@/lib/api-types';

const CONFIG_ON: ConfigResponse = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  apiKeys: { hasAnthropicKey: true, hasOpenAIKey: false }
};

function configRoute(
  config: ConfigResponse,
  patches: Array<unknown>
): (init: RequestInit) => Response {
  return (init) => {
    if (init.method === 'GET' || !init.method) {
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    patches.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify(config), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

describe('BehaviorSettings', () => {
  it('renders both toggles with the configured initial values', async () => {
    renderWithProviders(<BehaviorSettings />, { backend: { config: CONFIG_ON } });
    const showWarning = await screen.findByTestId('toggle-show-deep-warning');
    const resolver = await screen.findByTestId('toggle-resolver-enabled');
    await waitFor(() => expect(showWarning).toBeChecked());
    expect(resolver).toBeChecked();
  });

  it('toggling "Enable resolver check" PATCHes features.resolverCheckEnabled', async () => {
    const patches: Array<unknown> = [];
    renderWithProviders(<BehaviorSettings />, {
      backend: {
        config: CONFIG_ON,
        custom: { '/api/config': vi.fn(configRoute(CONFIG_ON, patches)) }
      }
    });

    const toggle = await screen.findByTestId('toggle-resolver-enabled');
    await waitFor(() => expect(toggle).toBeChecked());

    await userEvent.click(toggle);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ features: { resolverCheckEnabled: false } });
  });

  it('toggling "Show Deep Analyze cost warning" PATCHes ui.showDeepAnalyzeWarning', async () => {
    const patches: Array<unknown> = [];
    renderWithProviders(<BehaviorSettings />, {
      backend: {
        config: CONFIG_ON,
        custom: { '/api/config': vi.fn(configRoute(CONFIG_ON, patches)) }
      }
    });

    const toggle = await screen.findByTestId('toggle-show-deep-warning');
    await waitFor(() => expect(toggle).toBeChecked());

    await userEvent.click(toggle);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ ui: { showDeepAnalyzeWarning: false } });
  });

  it('reflects the disabled state when resolverCheckEnabled is false in config', async () => {
    const off: ConfigResponse = {
      ...CONFIG_ON,
      features: { resolverCheckEnabled: false }
    };
    renderWithProviders(<BehaviorSettings />, { backend: { config: off } });
    const toggle = await screen.findByTestId('toggle-resolver-enabled');
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});
