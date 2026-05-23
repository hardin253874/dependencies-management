'use client';

import type { PackageManager, VoltaInfo } from '@/lib/api-types';
import styles from './VoltaInfoCard.module.css';

interface Props {
  volta: VoltaInfo;
  packageManager: PackageManager;
}

export function VoltaInfoCard({ volta, packageManager }: Props): JSX.Element {
  const pmLabel = packageManager === 'npm' ? 'npm' : 'yarn';
  const pmVersion = volta.npm ?? volta.yarn ?? null;
  return (
    <section
      className={styles.card}
      aria-label="Volta toolchain"
      data-testid="volta-info-card"
    >
      <span className={styles.label}>Volta toolchain</span>
      <span className={styles.values}>
        Node {volta.node ?? '—'}
        {pmVersion ? ` · ${pmLabel} ${pmVersion}` : ''}
      </span>
    </section>
  );
}
