'use client';

import { useState } from 'react';
import type { ProjectSummary } from '@/lib/api-types';
import { useAppContext } from '../AppContext';
import { LlmBadge } from './LlmBadge';
import { ProjectList } from './ProjectList';
import { AddProjectButton } from './AddProjectButton';
import { OrphanBanner } from './OrphanBanner';
import { RelocateProjectModal } from '../modals/RelocateProjectModal';
import { RemoveProjectModal } from '../modals/RemoveProjectModal';
import styles from './LeftPanel.module.css';

export function LeftPanel(): JSX.Element {
  const {
    sidebarCollapsed,
    toggleSidebar,
    config,
    projects,
    projectsLoading,
    activeProjectSlug,
    activeProjectRefreshing,
    orphans,
    selectProject,
    refreshActiveProjectFromDisk,
    openAddProject,
    openSettings
  } = useAppContext();

  const [relocateTarget, setRelocateTarget] = useState<ProjectSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProjectSummary | null>(null);

  // Only surface orphans for slugs the user has actually registered. Avoids
  // showing banners for projects that were removed but left journal residue.
  const registeredSlugs = new Set(projects.map((p) => p.slug));
  const visibleOrphans = orphans.filter((o) => registeredSlugs.has(o.slug));

  return (
    <nav
      role="navigation"
      aria-label="Projects"
      className={[
        styles.left,
        sidebarCollapsed ? styles.collapsed : styles.expanded
      ].join(' ')}
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.collapseToggle}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={sidebarCollapsed}
          onClick={toggleSidebar}
        >
          <span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span>
        </button>
      </div>
      <div className={styles.llmRow}>
        <LlmBadge
          collapsed={sidebarCollapsed}
          provider={config?.llm.provider ?? null}
          model={config?.llm.model ?? null}
          hasKey={Boolean(
            config &&
              ((config.llm.provider === 'anthropic' && config.apiKeys.hasAnthropicKey) ||
                (config.llm.provider === 'openai' && config.apiKeys.hasOpenAIKey))
          )}
          onClick={() => openSettings('llm')}
        />
      </div>
      {!sidebarCollapsed && (
        <div className={styles.sectionLabel} aria-hidden="true">
          Projects
        </div>
      )}
      <div className={styles.listWrap}>
        <ProjectList
          projects={projects}
          loading={projectsLoading}
          activeSlug={activeProjectSlug}
          collapsed={sidebarCollapsed}
          onSelect={selectProject}
          onRefresh={(slug) => {
            if (slug === activeProjectSlug) {
              void refreshActiveProjectFromDisk();
            } else {
              // Refreshing a non-active project: switch to it and then refresh.
              selectProject(slug);
              setTimeout(() => void refreshActiveProjectFromDisk(), 0);
            }
          }}
          onRelocate={setRelocateTarget}
          onRemove={setRemoveTarget}
          refreshing={activeProjectRefreshing}
        />
        {!sidebarCollapsed && visibleOrphans.length > 0 && (
          <div className={styles.orphans} data-testid="orphan-banners">
            {visibleOrphans.map((o) => (
              <OrphanBanner key={`${o.slug}:${o.jobId}`} orphan={o} />
            ))}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <AddProjectButton collapsed={sidebarCollapsed} onClick={openAddProject} />
      </div>
      {relocateTarget && (
        <RelocateProjectModal
          open
          slug={relocateTarget.slug}
          projectName={relocateTarget.name}
          oldPath={relocateTarget.path}
          onClose={() => setRelocateTarget(null)}
          onRelocated={() => setRelocateTarget(null)}
        />
      )}
      {removeTarget && (
        <RemoveProjectModal
          open
          slug={removeTarget.slug}
          projectName={removeTarget.name}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => setRemoveTarget(null)}
        />
      )}
    </nav>
  );
}
