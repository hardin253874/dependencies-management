'use client';

import type { ProjectSummary } from '@/lib/api-types';
import { formatCompactAge } from '@/lib/client/format';
import { ProjectOrphanBanner } from './ProjectOrphanBanner';
import styles from './ProjectList.module.css';

interface ProjectListProps {
  projects: ProjectSummary[];
  loading: boolean;
  activeSlug: string | null;
  collapsed: boolean;
  onSelect: (slug: string) => void;
  onRefresh: (slug: string) => void;
  onRelocate: (project: ProjectSummary) => void;
  onRemove: (project: ProjectSummary) => void;
  refreshing: boolean;
}

function initials(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function ProjectList({
  projects,
  loading,
  activeSlug,
  collapsed,
  onSelect,
  onRefresh,
  onRelocate,
  onRemove,
  refreshing
}: ProjectListProps): JSX.Element {
  if (loading) {
    return (
      <div className={styles.placeholder} role="status">
        Loading projects…
      </div>
    );
  }

  if (projects.length === 0) {
    if (collapsed) {
      return <div className={styles.placeholderCollapsed} aria-hidden="true" />;
    }
    return (
      <div className={styles.empty} role="status">
        <p className={styles.emptyTitle}>No projects yet</p>
        <p className={styles.emptyHint} aria-hidden="true">
          ↓ Add one below
        </p>
      </div>
    );
  }

  return (
    <ul role="list" className={collapsed ? styles.listCollapsed : styles.list}>
      {projects.map((p) => {
        const isActive = p.slug === activeSlug;
        return (
          <li role="listitem" key={p.slug} className={styles.itemWrap}>
            <button
              type="button"
              aria-current={isActive ? 'page' : undefined}
              className={[
                collapsed ? styles.rowCollapsed : styles.row,
                isActive ? styles.active : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(p.slug)}
              data-testid={`project-row-${p.slug}`}
            >
              {collapsed ? (
                <span className={styles.initials} aria-label={p.name}>
                  {initials(p.name)}
                </span>
              ) : (
                <>
                  <span className={styles.name}>{p.name}</span>
                  <span className={styles.meta}>
                    {p.depCount} deps
                    {p.lastScanAt ? ` · ${formatCompactAge(p.lastScanAt)}` : ''}
                  </span>
                </>
              )}
            </button>
            {!collapsed && isActive && p.pathExists !== false && (
              <button
                type="button"
                className={[
                  styles.refreshBtn,
                  refreshing ? styles.refreshBtnBusy : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-label={`Refresh ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRefresh(p.slug);
                }}
                disabled={refreshing}
                data-testid={`project-refresh-${p.slug}`}
              >
                <span aria-hidden="true">↻</span>
              </button>
            )}
            {!collapsed && p.pathExists === false && (
              <ProjectOrphanBanner
                project={p}
                onRelocate={onRelocate}
                onRemove={onRemove}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
