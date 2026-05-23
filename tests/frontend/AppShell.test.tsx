import { describe, expect, it, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { AppShell } from '@/components/AppShell';
import { PersistenceKeys, readLocal, writeLocal } from '@/lib/client/persistence';

describe('AppShell — boot path', () => {
  it('renders three panels + status bar when key + project exist', async () => {
    renderWithProviders(<AppShell />, {
      backend: {
        projects: [
          {
            slug: 'demo',
            name: 'demo',
            path: '/x',
            packageManager: 'npm',
            depCount: 0,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: {
          demo: {
            schemaVersion: 1,
            name: 'demo',
            slug: 'demo',
            path: '/x',
            packageManager: 'npm',
            lockfileHash: '',
            lockfileStateHash: '',
            lastFullScanAt: new Date().toISOString(),
            legacyPeerDeps: false,
            volta: null,
            workspacesDetected: false,
            dependencies: []
          }
        }
      }
    });

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Projects' })).toBeInTheDocument();
    });
    expect(
      screen.getByRole('complementary', { name: 'Dependencies' })
    ).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Detail view' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('enters onboarding when no key is configured', async () => {
    renderWithProviders(<AppShell />, {
      backend: {
        config: {
          schemaVersion: 1,
          llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
          ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
          features: { resolverCheckEnabled: true },
          apiKeys: { hasAnthropicKey: false, hasOpenAIKey: false }
        }
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-flow')).toBeInTheDocument();
    });
    expect(screen.getByText('Welcome to Dependencies Agent')).toBeInTheDocument();
  });

  it('enters onboarding when no projects exist (even if key is set)', async () => {
    renderWithProviders(<AppShell />, {
      backend: {
        projects: []
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-flow')).toBeInTheDocument();
    });
  });
});

describe('LLM badge → Settings modal', () => {
  it('clicking the LLM badge opens Settings at the LLM section', async () => {
    renderWithProviders(<AppShell />, {
      backend: {
        projects: [
          {
            slug: 'demo',
            name: 'demo',
            path: '/x',
            packageManager: 'npm',
            depCount: 0,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: {
          demo: {
            schemaVersion: 1,
            name: 'demo',
            slug: 'demo',
            path: '/x',
            packageManager: 'npm',
            lockfileHash: '',
            lockfileStateHash: '',
            lastFullScanAt: new Date().toISOString(),
            legacyPeerDeps: false,
            volta: null,
            workspacesDetected: false,
            dependencies: []
          }
        }
      }
    });

    await waitFor(() => screen.getByTestId('llm-badge'));
    await userEvent.click(screen.getByTestId('llm-badge'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Settings')).toBeInTheDocument();
    const llmSectionButton = screen.getByTestId('settings-section-llm');
    expect(llmSectionButton).toHaveAttribute('aria-current', 'true');
  });
});

describe('Sidebar collapse persistence', () => {
  it('reads initial state from localStorage and persists subsequent flips', async () => {
    writeLocal(PersistenceKeys.sidebarCollapsed, true);
    renderWithProviders(<AppShell />, {
      backend: {
        projects: [
          {
            slug: 'demo',
            name: 'demo',
            path: '/x',
            packageManager: 'npm',
            depCount: 0,
            lastScanAt: null,
            pathExists: true
          }
        ],
        projectDetails: {
          demo: {
            schemaVersion: 1,
            name: 'demo',
            slug: 'demo',
            path: '/x',
            packageManager: 'npm',
            lockfileHash: '',
            lockfileStateHash: '',
            lastFullScanAt: new Date().toISOString(),
            legacyPeerDeps: false,
            volta: null,
            workspacesDetected: false,
            dependencies: []
          }
        }
      }
    });

    const toggle = await screen.findByRole('button', { name: /Expand sidebar/ });
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(readLocal<boolean>(PersistenceKeys.sidebarCollapsed, true)).toBe(false);
    });
  });
});
