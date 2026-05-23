'use client';

import styles from './RegenerateButton.module.css';

interface Props {
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
  label?: string;
}

/**
 * Spec §7.4: "Regenerate button" top-right of the breadcrumb bar. Disabled +
 * spinning while a regeneration job is in flight.
 */
export function RegenerateButton({
  onClick,
  busy,
  disabled,
  label = 'Regenerate'
}: Props): JSX.Element {
  return (
    <button
      type="button"
      className={[styles.btn, busy ? styles.busy : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      data-testid="regenerate-button"
    >
      <span aria-hidden="true" className={styles.glyph}>
        ↻
      </span>
      <span className={styles.text}>{label}</span>
    </button>
  );
}
