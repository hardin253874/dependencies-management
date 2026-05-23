'use client';

import styles from './AddProjectButton.module.css';

interface Props {
  collapsed: boolean;
  onClick: () => void;
}

export function AddProjectButton({ collapsed, onClick }: Props): JSX.Element {
  if (collapsed) {
    return (
      <button
        type="button"
        className={[styles.button, styles.collapsed].join(' ')}
        aria-label="Add project"
        onClick={onClick}
        data-testid="add-project-button"
      >
        <span aria-hidden="true">+</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      data-testid="add-project-button"
    >
      <span aria-hidden="true" className={styles.plus}>
        +
      </span>
      <span>Add project</span>
    </button>
  );
}
