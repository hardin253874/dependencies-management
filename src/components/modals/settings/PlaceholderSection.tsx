'use client';

import styles from './PlaceholderSection.module.css';

interface Props {
  heading: string;
  description: string;
}

export function PlaceholderSection({ heading, description }: Props): JSX.Element {
  return (
    <div className={styles.pane}>
      <h3 className={styles.heading}>{heading}</h3>
      <p className={styles.description}>{description}</p>
    </div>
  );
}
