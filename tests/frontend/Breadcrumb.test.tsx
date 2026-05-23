/**
 * Stage 2 — Breadcrumb component rendering. Pairs with routes.test.ts which
 * covers segment composition; this verifies the DOM contract: last segment
 * non-clickable + aria-current, earlier segments emit `onNavigate` on click.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Breadcrumb } from '@/components/RightPanel/Breadcrumb';

describe('Breadcrumb', () => {
  it('renders the last segment as aria-current', () => {
    render(
      <Breadcrumb
        segments={[
          { label: 'react', route: { kind: 'A', depName: 'react' } },
          { label: 'v19.0.0', route: null }
        ]}
        onNavigate={vi.fn()}
      />
    );
    const last = screen.getByTestId('crumb-segment-1');
    expect(last).toHaveAttribute('aria-current', 'page');
    expect(last.tagName.toLowerCase()).toBe('span');
  });

  it('emits onNavigate when a non-current segment is clicked', async () => {
    const onNavigate = vi.fn();
    render(
      <Breadcrumb
        segments={[
          { label: 'react', route: { kind: 'A', depName: 'react' } },
          { label: 'Usage', route: null }
        ]}
        onNavigate={onNavigate}
      />
    );
    await userEvent.click(screen.getByTestId('crumb-segment-0'));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'A', depName: 'react' });
  });
});
