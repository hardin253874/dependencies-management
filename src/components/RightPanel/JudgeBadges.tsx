'use client';

/**
 * v2 Stage 5b UI bits for Jev / the model router:
 * - `RoutingLine`: "Model: Sonnet 5.5 — <reason> (rule | Jev | default)" on
 *   the routed views ([D], [D-Deep], [E]); renders nothing for envelopes
 *   without `routing` (older caches, router off).
 * - `SupportBadge`: J2 flag on a claim ("low support (Jev)" / "unclear
 *   support (Jev)"); the claim itself stays.
 * - `JevLabel`: a small "estimated (Jev)" / "suggested (Jev)" tag.
 */
import type { JSX } from 'react';
import type { ClaimSupport, RouterDecisionDto } from '@/lib/api-types';
import styles from './JudgeBadges.module.css';

const MODEL_LABEL: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1'
};

const VIA_LABEL: Record<RouterDecisionDto['via'], string> = { rule: 'rule', jev: 'Jev', default: 'default' };

export function RoutingLine({ routing }: { routing: RouterDecisionDto | null | undefined }): JSX.Element | null {
  if (routing === null || routing === undefined) return null;
  return (
    <p className={styles.routing} data-testid="routing-line">
      Model: <strong>{MODEL_LABEL[routing.model] ?? routing.model}</strong> — {routing.reason} ({VIA_LABEL[routing.via] ?? routing.via})
    </p>
  );
}

export function SupportBadge({ support }: { support: ClaimSupport | null | undefined }): JSX.Element | null {
  if (support !== 'low' && support !== 'unclear') return null;
  return (
    <span className={support === 'low' ? styles.supportLow : styles.supportUnclear} data-testid={`support-${support}`} title="Jev evidence check of the cited code">
      {support === 'low' ? 'low support (Jev)' : 'unclear support (Jev)'}
    </span>
  );
}

export function JevLabel({ text }: { text: string }): JSX.Element {
  return (
    <span className={styles.jevLabel} data-testid="jev-label">
      {text}
    </span>
  );
}
