/**
 * Locks in the two non-obvious behaviours of `CollapsibleSection`:
 *
 *   1. Default state honours `defaultExpanded`; clicking the header toggles.
 *   2. Clicks inside the `headerAction` subtree do NOT propagate into the
 *      toggle. Regression for the "user clicks the Re-scan button and the
 *      section also collapses" class of bug.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollapsibleSection } from '@/components/RightPanel/CollapsibleSection';

describe('CollapsibleSection', () => {
  it('defaults to COLLAPSED; clicking the header toggles open/closed', async () => {
    // Project convention (v0.6.x): right-panel sections start collapsed so the
    // user sees the layout at a glance and chooses what to expand.
    render(
      <CollapsibleSection title="Demo" testId="collapse">
        <p>body-content</p>
      </CollapsibleSection>
    );
    // Body hidden initially.
    expect(screen.queryByText('body-content')).toBeNull();
    // Click header → body appears.
    await userEvent.click(screen.getByTestId('collapse'));
    expect(screen.getByText('body-content')).toBeInTheDocument();
    // Click again → body disappears.
    await userEvent.click(screen.getByTestId('collapse'));
    expect(screen.queryByText('body-content')).toBeNull();
  });

  it('honours defaultExpanded={true} (override for sections that should start open)', () => {
    render(
      <CollapsibleSection title="Demo" defaultExpanded testId="collapse">
        <p>body-content</p>
      </CollapsibleSection>
    );
    expect(screen.getByText('body-content')).toBeInTheDocument();
  });

  it('honours defaultExpanded={false} (explicit, matches new default)', () => {
    render(
      <CollapsibleSection title="Demo" defaultExpanded={false} testId="collapse">
        <p>body-content</p>
      </CollapsibleSection>
    );
    expect(screen.queryByText('body-content')).toBeNull();
  });

  it('clicks inside headerAction do NOT toggle the section', async () => {
    const onAction = vi.fn();
    render(
      // defaultExpanded={true} so the pre-condition "body visible" holds.
      <CollapsibleSection
        title="Demo"
        defaultExpanded
        testId="collapse"
        headerAction={
          <button type="button" data-testid="action-btn" onClick={onAction}>
            Click me
          </button>
        }
      >
        <p>body-content</p>
      </CollapsibleSection>
    );
    // Pre-condition: body visible.
    expect(screen.getByText('body-content')).toBeInTheDocument();
    // Click the action button — it should fire its handler but NOT toggle.
    await userEvent.click(screen.getByTestId('action-btn'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('body-content')).toBeInTheDocument();
  });

  it('renders the count chip when count is a number', () => {
    render(
      <CollapsibleSection title="Items" count={7} testId="collapse">
        <p>body</p>
      </CollapsibleSection>
    );
    expect(screen.getByTestId('collapse')).toHaveTextContent('Items (7)');
  });

  it('omits the count chip when count is null/undefined', () => {
    render(
      <CollapsibleSection title="Items" count={null} testId="collapse">
        <p>body</p>
      </CollapsibleSection>
    );
    expect(screen.getByTestId('collapse')).toHaveTextContent('Items');
    expect(screen.getByTestId('collapse')).not.toHaveTextContent('(');
  });

  it('is keyboard accessible via Enter and Space', async () => {
    // Start expanded so we can verify Enter→collapse + Space→expand sequence.
    render(
      <CollapsibleSection title="Demo" defaultExpanded testId="collapse">
        <p>body-content</p>
      </CollapsibleSection>
    );
    const header = screen.getByTestId('collapse');
    header.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByText('body-content')).toBeNull();
    await userEvent.keyboard(' ');
    expect(screen.getByText('body-content')).toBeInTheDocument();
  });
});
