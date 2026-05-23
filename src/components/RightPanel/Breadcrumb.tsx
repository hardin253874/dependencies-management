'use client';

import type { BreadcrumbSegment, DetailRoute } from '@/lib/client/routes';
import styles from './Breadcrumb.module.css';

interface Props {
  segments: BreadcrumbSegment[];
  onNavigate: (route: DetailRoute) => void;
}

/**
 * Spec §7.4 breadcrumb. Each clickable segment navigates to a prior route;
 * the final segment (current) is non-clickable per spec.
 */
export function Breadcrumb({ segments, onNavigate }: Props): JSX.Element {
  return (
    <nav aria-label="Breadcrumb" className={styles.crumb}>
      <ol className={styles.list}>
        {segments.map((segment, i) => {
          const isLast = i === segments.length - 1;
          return (
            <li key={i} className={styles.item}>
              {isLast || segment.route === null ? (
                <span
                  className={styles.current}
                  aria-current="page"
                  data-testid={`crumb-segment-${i}`}
                >
                  {segment.label}
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => segment.route && onNavigate(segment.route)}
                  data-testid={`crumb-segment-${i}`}
                >
                  {segment.label}
                </button>
              )}
              {!isLast && (
                <span aria-hidden="true" className={styles.sep}>
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
