'use client';

import { Button } from '../modals/Button';
import styles from './EmptyStateCTA.module.css';

interface Props {
  title: string;
  description?: string;
  actionLabel: string;
  onAction: () => void;
  busy?: boolean;
}

/**
 * Spec §7.4 + UI_DESIGN.md §2.4 `EmptyStateCTA`. Rendered when a per-view GET
 * returns `404 NOT_CACHED`. The button triggers the matching POST refresh.
 */
export function EmptyStateCTA({
  title,
  description,
  actionLabel,
  onAction,
  busy = false
}: Props): JSX.Element {
  return (
    <div className={styles.wrap} role="status">
      <div className={styles.card}>
        <h2 className={styles.title}>{title}</h2>
        {description && <p className={styles.body}>{description}</p>}
        <div className={styles.actions}>
          <Button
            tone="primary"
            onClick={onAction}
            disabled={busy}
            data-testid="empty-state-action"
          >
            {busy ? 'Working…' : actionLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
