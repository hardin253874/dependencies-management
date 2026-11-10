/**
 * v2 Stage 5a.6 — [D] impacted files: agent-ranked, graph-only (collapsed,
 * first 50 + show all), excluded with evidence. Old envelopes without
 * `impactedFiles` render exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers/renderWithProviders';
import { DetailPanel } from '@/components/RightPanel/DetailPanel';
import { ImpactedFilesList, GRAPH_ROWS_PREVIEW } from '@/components/RightPanel/ImpactedFilesList';
import type { FileEnvelope, ImpactedFile, ProjectDetail, UpdateReportDetail } from '@/lib/api-types';

function graphRow(path: string, over: Partial<ImpactedFile> = {}): ImpactedFile {
  return { path, origin: 'graph', via: 'direct', kind: 'js', confidence: 'high', agent: null, rank: null, evidence: null, brief: null, estimatedChangeSize: null, ...over };
}

const rows: ImpactedFile[] = [
  graphRow('src/b.ts', { agent: 'confirmed', rank: 2, brief: 'Second.', estimatedChangeSize: 'medium' }),
  { path: 'src/styles.scss', origin: 'agent', kind: 'style', agent: 'added', rank: 3, evidence: null, brief: 'Imports the theme.', estimatedChangeSize: 'small' },
  graphRow('src/a.ts', { agent: 'confirmed', rank: 1, brief: 'First.', estimatedChangeSize: 'large' }),
  ...Array.from({ length: GRAPH_ROWS_PREVIEW + 5 }, (_, i) => graphRow(`src/g/${String(i).padStart(3, '0')}.ts`, i === 0 ? { via: 'wrapper', confidence: 'low' } : {})),
  graphRow('src/types.ts', { agent: 'excluded', evidence: 'Type-only import of an unchanged API.' })
];

describe('ImpactedFilesList (5a.6)', () => {
  it('three sections with counts; agent-ranked = confirmed by rank, then added with an agent badge', () => {
    render(<ImpactedFilesList files={rows} packageLabel="react" />);
    const ranked = screen.getByRole('region', { name: 'Agent-ranked' });
    const items = within(ranked).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual(['impacted-src/a.ts', 'impacted-src/b.ts', 'impacted-src/styles.scss']);
    expect(within(items[2]!).getByText('agent')).toBeInTheDocument();
    expect(within(items[2]!).getByText('style')).toBeInTheDocument();
    expect(screen.getByTestId('impacted-ranked-count')).toHaveTextContent('3');
    expect(screen.getByTestId('impacted-graph-toggle')).toHaveTextContent(`Also uses react (graph) (${GRAPH_ROWS_PREVIEW + 5})`);
    const excluded = screen.getByRole('region', { name: 'Excluded by agent' });
    expect(within(excluded).getByText('Type-only import of an unchanged API.')).toBeInTheDocument();
    expect(within(excluded).getByTestId('impacted-src/types.ts')).toBeInTheDocument();
  });

  it('graph section is collapsed; expand shows the first 50, "show all" the rest; via / low-confidence badges', async () => {
    render(<ImpactedFilesList files={rows} packageLabel="react" />);
    expect(screen.queryByTestId('impacted-src/g/000.ts')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('impacted-graph-toggle'));
    const first = screen.getByTestId('impacted-src/g/000.ts');
    expect(within(first).getByText('wrapper')).toBeInTheDocument();
    expect(within(first).getByText('low confidence')).toBeInTheDocument();
    expect(screen.getByTestId(`impacted-src/g/${String(GRAPH_ROWS_PREVIEW - 1).padStart(3, '0')}.ts`)).toBeInTheDocument();
    expect(screen.queryByTestId(`impacted-src/g/${String(GRAPH_ROWS_PREVIEW).padStart(3, '0')}.ts`)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('impacted-graph-show-all'));
    expect(screen.getByTestId(`impacted-src/g/${String(GRAPH_ROWS_PREVIEW + 4).padStart(3, '0')}.ts`)).toBeInTheDocument();
    expect(screen.queryByTestId('impacted-graph-show-all')).not.toBeInTheDocument();
  });

  it('empty list renders nothing', () => {
    const { container } = render(<ImpactedFilesList files={[]} packageLabel="react" />);
    expect(container).toBeEmptyDOMElement();
  });
});

function projectDetail(slug: string): ProjectDetail {
  return {
    schemaVersion: 1,
    name: 'my-app',
    slug,
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

const baseDetail: UpdateReportDetail = {
  fromVersion: '18.2.0',
  toVersion: '19.0.0',
  summary: 'React 19.',
  riskLevel: 'medium',
  resolverCheck: { kind: 'enabled', wouldResolve: true, conflicts: [], legacyPeerDepsUsed: false },
  coUpgradeDeps: [],
  breakingChanges: [],
  filesToModify: [{ path: 'src/App.tsx', brief: 'Uses createRoot.', estimatedChangeSize: 'small' }],
  recommendations: []
};

function renderReport(source: FileEnvelope<UpdateReportDetail>['source'], data: UpdateReportDetail): void {
  window.localStorage.setItem('dep-agent:ui.detailRoute', JSON.stringify({ kind: 'D', depName: 'react', fromVersion: '18.2.0', toVersion: '19.0.0' }));
  renderWithProviders(<DetailPanel />, {
    backend: {
      projects: [{ slug: 'p', name: 'my-app', path: '/p', packageManager: 'npm', depCount: 1, lastScanAt: null, pathExists: true }],
      projectDetails: { p: projectDetail('p') },
      reports: { 'p::react::18.2.0::19.0.0': { schemaVersion: 1, generatedAt: '2026-05-23T00:00:00.000Z', source, ttlHours: 720, data } }
    }
  });
}

describe('UpdateReportView + impactedFiles (5a.6)', () => {
  it('an old envelope without impactedFiles renders as before, without the new sections', async () => {
    renderReport('anthropic:claude-sonnet-5-5', baseDetail);
    await waitFor(() => expect(screen.getByTestId('file-to-modify-src/App.tsx')).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Impacted files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agent-ranked' })).not.toBeInTheDocument();
  });

  it('deterministic-partial: the amber banner and the graph base list are shown together', async () => {
    renderReport('deterministic-partial', {
      ...baseDetail,
      summary: '',
      impactedFiles: [graphRow('src/App.tsx'), graphRow('src/index.tsx', { via: 'reexport' })],
      impactSummary: { base: 2, confirmed: 0, added: 0, excluded: 0, rejectedExclusions: 0 }
    });
    await waitFor(() => expect(screen.getByTestId('ai-unavailable-banner')).toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Impacted files' })).toBeInTheDocument();
    expect(screen.getByTestId('impacted-graph-toggle')).toHaveTextContent('Also uses react (graph) (2)');
    expect(screen.queryByRole('region', { name: 'Agent-ranked' })).not.toBeInTheDocument();
  });
});
