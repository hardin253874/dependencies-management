/**
 * v2 Stage 4a.13 — agent run confirm modal + exploration trace in view [D].
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import { ToastContainer } from '@/components/ToastContainer';
import { CostSettings } from '@/components/modals/settings/CostSettings';
import type { DeepReportEstimateResponse, FileEnvelope, ProjectDetail, UpdateReportDetail } from '@/lib/api-types';

const KEY = 'p::react::18.2.0::19.0.0';

function projectDetail(): ProjectDetail {
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
        badges: { outdatedSeverity: 'major', hasCve: false, deprecated: false, lastScannedAt: '2026-05-23T00:00:00.000Z' }
      }
    ]
  };
}

function withRoute(): void {
  window.localStorage.setItem('dep-agent:ui.detailRoute', JSON.stringify({ kind: 'D', depName: 'react', fromVersion: '18.2.0', toVersion: '19.0.0' }));
}

const project = { slug: 'p', name: 'my-app', path: '/p', packageManager: 'npm' as const, depCount: 1, lastScanAt: null, pathExists: true };

const estimate: DeepReportEstimateResponse = {
  estimatedInputTokens: 120_000,
  estimatedOutputTokens: 4_800,
  estimatedCostUsd: 0.31,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  totalPackages: 1,
  engine: 'agent',
  maxUsd: 0.78,
  budgets: { maxToolCalls: 20, maxInputTokens: 400_000, maxOutputTokens: 16_000, maxWallMs: 180_000, maxUsd: 0.78, perTurnMaxTokens: 8_000 }
};

const report: UpdateReportDetail = {
  fromVersion: '18.2.0',
  toVersion: '19.0.0',
  summary: 'Agent summary.',
  riskLevel: 'medium',
  resolverCheck: { kind: 'disabled', reason: 'kill-switch' },
  coUpgradeDeps: [],
  breakingChanges: [],
  filesToModify: [],
  recommendations: []
};

function envelope(data: UpdateReportDetail): FileEnvelope<UpdateReportDetail> {
  return { schemaVersion: 1, generatedAt: '2026-11-10T00:00:00.000Z', source: 'anthropic:claude-sonnet-5-5', ttlHours: null, data };
}

function render(backend: Record<string, unknown>) {
  withRoute();
  return renderWithProviders(
    <>
      <DetailPanel />
      <ToastContainer />
    </>,
    { backend: { projects: [project], projectDetails: { p: projectDetail() }, reportEstimates: { [KEY]: estimate }, ...backend } }
  );
}

describe('AgentRunConfirmModal in view [D] (4a.13)', () => {
  it('shows expected + max USD, model and budgets from the estimate', async () => {
    render({ reports: {} });
    fireEvent.click(await screen.findByTestId('empty-state-action'));
    expect(await screen.findByTestId('agent-run-expected')).toHaveTextContent('Expected cost: ~$0.31');
    expect(screen.getByTestId('agent-run-max')).toHaveTextContent('Maximum (hard budget): $0.78');
    expect(screen.getByTestId('agent-run-model')).toHaveTextContent('anthropic claude-sonnet-5-5');
    expect(screen.getByTestId('agent-run-budgets')).toHaveTextContent('20 tool calls');
  });

  it('Cancel does not POST; Continue POSTs the refresh', async () => {
    const onRefreshReport = vi.fn();
    render({ reports: {}, onRefreshReport });
    fireEvent.click(await screen.findByTestId('empty-state-action'));
    await screen.findByTestId('agent-run-expected');
    fireEvent.click(screen.getByTestId('agent-run-cancel'));
    await waitFor(() => expect(screen.queryByTestId('agent-run-expected')).not.toBeInTheDocument());
    expect(onRefreshReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('empty-state-action'));
    await screen.findByTestId('agent-run-expected');
    fireEvent.click(screen.getByTestId('agent-run-continue'));
    await waitFor(() => expect(onRefreshReport).toHaveBeenCalledWith('p', 'react', '18.2.0', '19.0.0'));
  });

  it('a failed job surfaces an error toast', async () => {
    render({ reports: {}, jobRecords: { 'job-report-react-18.2.0-19.0.0': { state: 'error', error: { code: 'X', message: 'agent job exploded' } } } });
    fireEvent.click(await screen.findByTestId('empty-state-action'));
    await screen.findByTestId('agent-run-expected');
    fireEvent.click(screen.getByTestId('agent-run-continue'));
    expect(await screen.findByText(/agent job exploded/)).toBeInTheDocument();
  });
});

describe('ExplorationTrace in view [D] (4a.13)', () => {
  it('renders one row per tool call with badges and the run status / cost', async () => {
    const withRun: UpdateReportDetail = {
      ...report,
      agentRun: {
        runId: 'abc123-def',
        status: 'submitted',
        toolCalls: 3,
        costUsd: 0.1234,
        calls: [
          { turn: 1, tool: 'graph_summary', inputSummary: '{}', durationMs: 4, resultBytes: 200, truncated: false, isError: false },
          { turn: 2, tool: 'search_code', inputSummary: '{"query":"render("}', durationMs: 30, resultBytes: 16384, truncated: true, isError: false },
          { turn: 3, tool: 'read_file', inputSummary: '{"path":"../x"}', durationMs: 1, resultBytes: 40, truncated: false, isError: true }
        ]
      }
    };
    render({ reports: { [KEY]: envelope(withRun) } });
    fireEvent.click(await screen.findByTestId('exploration-trace-toggle'));
    const rows = await screen.findAllByTestId('exploration-trace-row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('truncated');
    expect(rows[2]).toHaveTextContent('error');
    expect(screen.getByTestId('exploration-trace-meta')).toHaveTextContent('finished · 3 tool calls · $0.1234');
  });

  it('an old envelope without agentRun renders without the trace (and without crashing)', async () => {
    render({ reports: { [KEY]: envelope(report) } });
    expect(await screen.findByText('Agent summary.')).toBeInTheDocument();
    expect(screen.queryByTestId('exploration-trace-toggle')).not.toBeInTheDocument();
  });

  it('an agentRun without calls (partial older shape) renders with 0 rows', async () => {
    const partial = { ...report, agentRun: { runId: 'abc123-def', status: 'budget-exhausted', toolCalls: 2, costUsd: 0.01 } } as UpdateReportDetail;
    render({ reports: { [KEY]: envelope(partial) } });
    fireEvent.click(await screen.findByTestId('exploration-trace-toggle'));
    expect(await screen.findByText('No tool calls.')).toBeInTheDocument();
    expect(screen.getByTestId('exploration-trace-meta')).toHaveTextContent('stopped: budget reached');
  });
});

describe('Settings → Cost shows agent budgets read-only (4a.12)', () => {
  it('lists both views when the server sends agentBudgets, and nothing otherwise', async () => {
    const budgets = {
      updateReport: { maxToolCalls: 20, maxInputTokens: 400000, maxOutputTokens: 16000, maxWallMs: 180000, maxUsd: null, perTurnMaxTokens: 8000 },
      deepReport: { maxToolCalls: 40, maxInputTokens: 1000000, maxOutputTokens: 40000, maxWallMs: 300000, maxUsd: 2, perTurnMaxTokens: 16000 }
    };
    const config = {
      schemaVersion: 1 as const,
      llm: { provider: 'anthropic' as const, model: 'claude-opus-5-5' },
      ui: { sidebarCollapsed: false, theme: 'light' as const, showDeepAnalyzeWarning: true },
      features: { resolverCheckEnabled: true },
      agentBudgets: budgets,
      apiKeys: { hasAnthropicKey: false }
    };
    const { unmount } = renderWithProviders(<CostSettings />, { backend: { config } });
    const block = await screen.findByTestId('agent-budgets');
    expect(block).toHaveTextContent('Update report: 20 tool calls');
    expect(block).toHaveTextContent('USD cap derived from the token budgets');
    expect(block).toHaveTextContent('Deep report: 40 tool calls');
    expect(block).toHaveTextContent('$2.00 max');
    unmount();
    renderWithProviders(<CostSettings />, {});
    await waitFor(() => expect(screen.queryByText('Loading costs…')).not.toBeInTheDocument());
    expect(screen.queryByTestId('agent-budgets')).not.toBeInTheDocument();
  });
});
