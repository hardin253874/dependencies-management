'use client';

import type { JSX } from 'react';
import styles from './LlmBadge.module.css';

interface LlmBadgeProps {
  /**
   * Typed as a plain string on purpose: the badge must render (generic label)
   * for any provider it does not know, e.g. a future provider or stale data.
   */
  provider: string | null;
  model: string | null;
  hasKey: boolean;
  collapsed: boolean;
  onClick: () => void;
}

function providerDisplayName(provider: string | null): string {
  if (provider === 'anthropic') return 'Anthropic';
  return 'LLM';
}

function providerInitial(provider: string | null): string {
  if (provider === 'anthropic') return 'A';
  return '?';
}

export function LlmBadge({
  provider,
  model,
  hasKey,
  collapsed,
  onClick
}: LlmBadgeProps): JSX.Element {
  const noKey = !hasKey;
  const label = noKey
    ? 'Set up LLM. Click to open settings.'
    : `Active LLM: ${providerDisplayName(provider)} ${model ?? ''}. Click to open settings.`;

  if (collapsed) {
    return (
      <button
        type="button"
        className={[styles.badge, styles.collapsed].join(' ')}
        aria-label={label}
        onClick={onClick}
      >
        <span className={styles.initial} aria-hidden="true">
          {providerInitial(provider)}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={styles.badge}
      aria-label={label}
      onClick={onClick}
      data-testid="llm-badge"
    >
      {noKey ? (
        <span className={styles.cta}>Set up LLM →</span>
      ) : (
        <>
          <span className={styles.providerName}>{providerDisplayName(provider)}</span>
          <span className={styles.modelName}>{model ?? ''}</span>
        </>
      )}
      <span className={styles.chevron} aria-hidden="true">
        ›
      </span>
    </button>
  );
}
