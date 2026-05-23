'use client';

import type { ProjectSummary } from '@/lib/api-types';
import styles from './ProjectOrphanBanner.module.css';

interface Props {
  project: ProjectSummary;
  onRelocate: (project: ProjectSummary) => void;
  onRemove: (project: ProjectSummary) => void;
}

/**
 * Inline amber banner shown beneath a project row when the registered absolute
 * path no longer resolves on disk (spec §6.3, Wireframe 26).
 *
 * Two text-style buttons: "Relocate" opens the path Picker pre-seeded for this
 * slug; "Remove" confirms deletion with an optional "also delete library
 * data" checkbox.
 */
export function ProjectOrphanBanner({
  project,
  onRelocate,
  onRemove
}: Props): JSX.Element {
  return (
    <div
      className={styles.banner}
      role="status"
      data-testid={`project-orphan-${project.slug}`}
    >
      <p className={styles.message}>
        <span aria-hidden="true" className={styles.glyph}>
          ⚠
        </span>{' '}
        Folder not found.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={() => onRelocate(project)}
          data-testid={`project-orphan-relocate-${project.slug}`}
        >
          Relocate
        </button>
        <button
          type="button"
          className={[styles.action, styles.destructive].join(' ')}
          onClick={() => onRemove(project)}
          data-testid={`project-orphan-remove-${project.slug}`}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
