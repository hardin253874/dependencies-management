'use client';

import { useAppContext } from '../../AppContext';
import styles from './AboutSettings.module.css';

export function AboutSettings(): JSX.Element {
  const { config } = useAppContext();
  return (
    <div className={styles.pane}>
      <h3 className={styles.heading}>About</h3>
      <p className={styles.appName}>Dependencies Agent</p>
      <p className={styles.version}>v0.1.0</p>
      <div className={styles.field}>
        <span className={styles.label}>Project</span>
        <span className={styles.value}>
          <a
            href="https://github.com/anthropics/claude-code"
            target="_blank"
            rel="noreferrer noopener"
          >
            Repository
          </a>
        </span>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Config schema version</span>
        <span className={styles.value}>{config?.schemaVersion ?? '—'}</span>
      </div>
      <p className={styles.tag}>Local-only · Zero telemetry</p>
    </div>
  );
}
