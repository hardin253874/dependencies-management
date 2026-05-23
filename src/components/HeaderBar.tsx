'use client';

import { useAppContext } from './AppContext';
import styles from './HeaderBar.module.css';

export function HeaderBar({ minimal = false }: { minimal?: boolean }): JSX.Element {
  const { openSettings } = useAppContext();
  return (
    <header role="banner" className={styles.header}>
      <span className={styles.title}>Dependencies Agent</span>
      {!minimal && (
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Settings"
          onClick={() => openSettings()}
        >
          <span aria-hidden="true" className={styles.gear}>
            {/* gear glyph */}
            ⚙
          </span>
        </button>
      )}
    </header>
  );
}
