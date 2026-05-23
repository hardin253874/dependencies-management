'use client';

import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type { CostSummaryEntry, CostSummaryResponse, LlmProvider } from '@/lib/api-types';
import { useAppContext } from '../../AppContext';
import styles from './CostSettings.module.css';

interface ProjectRow {
  slug: string;
  name: string;
  summary: CostSummaryResponse | null;
  error: string | null;
}

/**
 * Settings → Cost section (spec §7.7 + §11.11, Wireframe 18).
 *
 * Cumulative LLM token spend per project, with provider breakdown computed
 * from cached AI envelopes by the BE (`GET /api/projects/:slug/cost`). The
 * Settings pane fetches summaries for all registered projects in parallel
 * and renders an expandable per-project list.
 *
 * No daily cap (spec §7.7). The footnote calls out that figures are
 * estimates based on baked-in pricing tables (§11.11).
 */
export function CostSettings(): JSX.Element {
  const { projects } = useAppContext();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const next: ProjectRow[] = await Promise.all(
        projects.map(async (p) => {
          try {
            const summary = await getApiClient().getCostSummaryForProject(p.slug);
            return { slug: p.slug, name: p.name, summary, error: null };
          } catch (err) {
            return {
              slug: p.slug,
              name: p.name,
              summary: null,
              error: err instanceof Error ? err.message : 'Failed to load cost.'
            };
          }
        })
      );
      if (cancelled) return;
      setRows(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const toggle = (slug: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const grandTotal = rows.reduce(
    (acc, r) => acc + (r.summary?.totalUsd ?? 0),
    0
  );

  return (
    <div className={styles.pane}>
      <h3 className={styles.heading}>Cost</h3>
      <p className={styles.lead}>Cumulative LLM token spend per project.</p>

      {loading && (
        <p className={styles.statusInfo} role="status">
          Loading costs…
        </p>
      )}

      {!loading && rows.length === 0 && (
        <p className={styles.statusInfo} role="status">
          No projects registered yet.
        </p>
      )}

      {!loading && rows.length > 0 && (
        <>
          <ul role="list" className={styles.list} data-testid="cost-list">
            {rows.map((row) => {
              const total = row.summary?.totalUsd ?? 0;
              const isExpanded = expanded.has(row.slug);
              return (
                <li
                  role="listitem"
                  key={row.slug}
                  className={styles.row}
                  data-testid={`cost-row-${row.slug}`}
                >
                  <button
                    type="button"
                    className={styles.summaryButton}
                    aria-expanded={isExpanded}
                    aria-controls={`cost-detail-${row.slug}`}
                    onClick={() => toggle(row.slug)}
                  >
                    <span aria-hidden="true" className={styles.chevron}>
                      {isExpanded ? '▾' : '▸'}
                    </span>
                    <span className={styles.projectName}>{row.name}</span>
                    {row.error ? (
                      <span className={styles.errorBadge}>error</span>
                    ) : (
                      <span className={styles.usd}>${total.toFixed(2)}</span>
                    )}
                  </button>
                  {isExpanded && (
                    <div
                      id={`cost-detail-${row.slug}`}
                      className={styles.detail}
                      data-testid={`cost-detail-${row.slug}`}
                    >
                      {row.error && (
                        <p className={styles.errorMessage}>{row.error}</p>
                      )}
                      {row.summary && <ProviderBreakdown summary={row.summary} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <p className={styles.grandTotal} data-testid="cost-grand-total">
            Total: ${grandTotal.toFixed(2)}
          </p>
        </>
      )}

      <p className={styles.footnote}>
        Computed from baked-in pricing tables and cached AI envelopes. Estimates only.
      </p>
    </div>
  );
}

function ProviderBreakdown({ summary }: { summary: CostSummaryResponse }): JSX.Element {
  const providers = Object.entries(summary.byProvider) as Array<
    [LlmProvider, CostSummaryEntry[]]
  >;
  if (providers.every(([, entries]) => entries.length === 0)) {
    return <p className={styles.muted}>No AI reports yet.</p>;
  }
  return (
    <ul className={styles.providerList}>
      {providers.map(([provider, entries]) => {
        if (entries.length === 0) return null;
        const sub = entries.reduce((acc, e) => acc + e.costUsd, 0);
        return (
          <li
            key={provider}
            className={styles.providerRow}
            data-testid={`cost-provider-${provider}`}
          >
            <span className={styles.providerName}>{provider}</span>
            <span className={styles.providerCost}>${sub.toFixed(2)}</span>
          </li>
        );
      })}
    </ul>
  );
}
