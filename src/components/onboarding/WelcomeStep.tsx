'use client';

import { Button } from '../modals/Button';
import styles from './Card.module.css';

interface Props {
  onContinue: () => void;
}

export function WelcomeStep({ onContinue }: Props): JSX.Element {
  return (
    <section className={styles.card} aria-labelledby="welcome-title">
      <h1 id="welcome-title" className={styles.title}>
        Welcome to Dependencies Agent
      </h1>
      <p className={styles.subtitle}>
        A local agent for analyzing legacy JavaScript / TypeScript dependencies.
      </p>
      <ul className={styles.bullets}>
        <li>Local-only — your keys never leave your machine.</li>
        <li>Cache-first — AI runs only when you ask for it.</li>
      </ul>
      <div className={styles.actions}>
        <Button tone="primary" onClick={onContinue} data-testid="welcome-continue">
          Get started
        </Button>
      </div>
    </section>
  );
}
