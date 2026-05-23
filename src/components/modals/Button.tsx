'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Tone = 'primary' | 'secondary' | 'destructive';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  children: ReactNode;
}

export function Button({
  tone = 'secondary',
  className,
  children,
  ...rest
}: Props): JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={[styles.btn, styles[tone], className].filter(Boolean).join(' ')}
    >
      {children}
    </button>
  );
}
