'use client';

import { DetailPanel } from './DetailPanel';
import styles from './RightPanel.module.css';

export function RightPanel(): JSX.Element {
  return (
    <main
      id="right-panel"
      role="main"
      aria-label="Detail view"
      className={styles.right}
    >
      <DetailPanel />
    </main>
  );
}
