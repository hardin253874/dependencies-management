/**
 * v2 Stage 1.2.b — legacy OpenAI envelopes stay renderable.
 *
 * OpenAI was removed in v2, but v1 caches with `source: 'openai:<model>'`
 * remain on users' disks. Views and downloads must render them (marked as
 * legacy), never throw.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RelatedUpgradeTable } from '@/components/RightPanel/RelatedUpgradeTable';
import { formatSourceLabel } from '@/lib/reports/sourceLabel';
import type { RelatedUpgradeDetail } from '@/lib/api-types';

const CLASSES = {
  emptyHint: 'hint',
  globalNotes: 'notes',
  table: 'table',
  actionPill: 'pill',
  actionKeep: 'keep',
  actionUpgrade: 'upgrade',
  actionInvestigate: 'investigate',
  confidence: 'confidence'
};

const DETAIL: RelatedUpgradeDetail = {
  viewedDep: 'react',
  fromVersion: '17.0.2',
  toVersion: '18.3.1',
  globalNotes: 'Upgrade react-dom together.',
  recommendations: []
};

describe('legacy openai: envelope source', () => {
  it('formatSourceLabel marks openai sources as legacy and leaves others unchanged', () => {
    expect(formatSourceLabel('openai:gpt-4o')).toBe('OpenAI · gpt-4o (legacy)');
    expect(formatSourceLabel('anthropic:claude-opus-5')).toBe('anthropic:claude-opus-5');
    expect(formatSourceLabel('deterministic-partial')).toBe('deterministic-partial');
  });

  it('a view rendering an envelope with source openai:gpt-4o does not throw', () => {
    expect(() =>
      render(
        <RelatedUpgradeTable
          detail={DETAIL}
          generatedAt="2026-05-01T10:00:00.000Z"
          source="openai:gpt-4o"
          classNames={CLASSES}
        />
      )
    ).not.toThrow();
    expect(screen.getByTestId('related-upgrade-table')).toBeInTheDocument();
    expect(screen.getByText(/OpenAI · gpt-4o \(legacy\)/)).toBeInTheDocument();
  });
});
