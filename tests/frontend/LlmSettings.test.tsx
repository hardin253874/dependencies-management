/**
 * Stage 3 — Settings → LLM model selector (spec §7.7).
 *
 * The model selector PATCHes `_config.json.llm.model` via PATCH /api/config.
 * Provider radios PATCH `_config.json.llm.provider` and default the model to
 * the first entry in that provider's list.
 *
 * Stage 1 LlmSettings already covered key save + test; this file focuses on
 * the model dropdown that lands as part of Stage 3.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { LlmSettings } from '@/components/modals/settings/LlmSettings';
import type { ConfigResponse } from '@/lib/api-types';

const DEFAULT_CONFIG: ConfigResponse = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-5-5' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  apiKeys: { hasAnthropicKey: true }
};

function captureConfigPatches(): {
  patches: Array<unknown>;
  patcher: (init: RequestInit) => Response;
} {
  const patches: Array<unknown> = [];
  return {
    patches,
    patcher: (init) => {
      patches.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify(DEFAULT_CONFIG), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
}

describe('LlmSettings — model selector', () => {
  it('renders the configured model and lists available options for the active provider', async () => {
    renderWithProviders(<LlmSettings />, {
      backend: { config: DEFAULT_CONFIG }
    });
    const select = (await screen.findByTestId('model-select')) as HTMLSelectElement;
    // The select mounts with the catalog default and adopts the configured
    // model once /api/config resolves — wait for that, don't assert on mount.
    await waitFor(() => expect(select.value).toBe('claude-opus-5-5'));
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('claude-opus-5-5');
    expect(options).toContain('claude-sonnet-5-5');
    // OpenAI options are NOT visible when provider is anthropic.
    expect(options).not.toContain('gpt-5');
  });

  it('PATCHes /api/config with the new model when the selector changes', async () => {
    const { patches, patcher } = captureConfigPatches();
    renderWithProviders(<LlmSettings />, {
      backend: {
        config: DEFAULT_CONFIG,
        custom: {
          '/api/config': vi.fn(async (init: RequestInit) => {
            if (init.method === 'GET' || !init.method) {
              return new Response(JSON.stringify(DEFAULT_CONFIG), {
                status: 200,
                headers: { 'content-type': 'application/json' }
              });
            }
            return patcher(init);
          })
        }
      }
    });
    const select = (await screen.findByTestId('model-select')) as HTMLSelectElement;
    await userEvent.selectOptions(select, 'claude-sonnet-5-5');

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      llm: { provider: 'anthropic', model: 'claude-sonnet-5-5' }
    });
  });

  it('D32: a separate agent report model picker shows llm.agentModel (Sonnet 5.5 when the server omits it)', async () => {
    renderWithProviders(<LlmSettings />, {
      backend: { config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, agentModel: 'claude-haiku-5-5' } } }
    });
    const select = (await screen.findByTestId('agent-model-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('claude-haiku-5-5'));
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
    expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('claude-opus-5-5');
  });

  it('D32: agent model picker falls back to Sonnet 5.5 for an older server', async () => {
    renderWithProviders(<LlmSettings />, { backend: { config: DEFAULT_CONFIG } });
    const select = (await screen.findByTestId('agent-model-select')) as HTMLSelectElement;
    await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('claude-opus-5-5'));
    expect(select.value).toBe('claude-sonnet-5-5');
  });

  it('D32: changing the agent model PATCHes only llm.agentModel', async () => {
    const { patches, patcher } = captureConfigPatches();
    renderWithProviders(<LlmSettings />, {
      backend: {
        config: DEFAULT_CONFIG,
        custom: {
          '/api/config': vi.fn(async (init: RequestInit) => {
            if (init.method === 'GET' || !init.method) {
              return new Response(JSON.stringify(DEFAULT_CONFIG), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return patcher(init);
          })
        }
      }
    });
    const select = (await screen.findByTestId('agent-model-select')) as HTMLSelectElement;
    await userEvent.selectOptions(select, 'claude-opus-5-5');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ llm: { agentModel: 'claude-opus-5-5' } });
  });

  it('v2: shows Anthropic as static text and renders no provider radio group', async () => {
    renderWithProviders(<LlmSettings />, { backend: { config: DEFAULT_CONFIG } });
    expect(await screen.findByTestId('provider-name')).toHaveTextContent('Anthropic');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByTestId('provider-openai')).toBeNull();
  });
});
