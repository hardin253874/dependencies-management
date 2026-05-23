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
  llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  apiKeys: { hasAnthropicKey: true, hasOpenAIKey: false }
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
    expect(select.value).toBe('claude-opus-4-7');
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('claude-opus-4-7');
    expect(options).toContain('claude-sonnet-4-5');
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
    await userEvent.selectOptions(select, 'claude-sonnet-4-5');

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-5' }
    });
  });

  it('switching provider PATCHes provider + defaults model to the first entry of that providers list', async () => {
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
    await userEvent.click(await screen.findByTestId('provider-openai'));

    await waitFor(() => expect(patches).toHaveLength(1));
    // Implementation defaults to the first OpenAI entry.
    const patch = patches[0] as { llm: { provider: string; model: string } };
    expect(patch.llm.provider).toBe('openai');
    expect(patch.llm.model.startsWith('gpt-')).toBe(true);
  });
});
