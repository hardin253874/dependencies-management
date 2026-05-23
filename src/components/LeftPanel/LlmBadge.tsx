'use client';

import type { LlmProvider } from '@/lib/api-types';
import styles from './LlmBadge.module.css';

interface LlmBadgeProps {
  provider: LlmProvider | null;
  model: string | null;
  hasKey: boolean;
  collapsed: boolean;
  onClick: () => void;
}

function providerDisplayName(provider: LlmProvider | null): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai') return 'OpenAI';
  return 'LLM';
}

function providerInitial(provider: LlmProvider | null): string {
  if (provider === 'anthropic') return 'A';
  if (provider === 'openai') return 'O';
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
