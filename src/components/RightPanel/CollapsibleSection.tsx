'use client';

/**
 * Reusable collapsible section for right-panel views.
 *
 * Used to give every list-heavy section (Related deps in this project,
 * Available versions, Related deps upgrade analysis, Usage of related deps,
 * etc.) a consistent expand/collapse interaction so users can hide content
 * they're not currently looking at.
 *
 * UX contract:
 *   - The whole header row is clickable to toggle (button semantics — keyboard
 *     accessible). A chevron on the left indicates state (▾ open, ▸ closed).
 *   - The right side of the header carries an optional `headerAction` (e.g. a
 *     button or a checkbox toggle). Clicks on that subtree are intercepted so
 *     they don't bubble into the toggle.
 *   - `defaultExpanded` defaults to true. State is in-component only; no
 *     persistence across re-mount in v1.
 *   - Children only render when expanded — the DOM stays small for very long
 *     lists.
 */
import { useCallback, useState, type ReactNode, type MouseEvent } from 'react';

interface Props {
  /** Section heading text. */
  title: string;
  /** Optional count rendered next to the title (e.g. "(46)"). */
  count?: number | null;
  /** Optional right-side action (button, toggle, etc.). Pointer events stop here. */
  headerAction?: ReactNode;
  /** Default expanded; defaults to `true`. */
  defaultExpanded?: boolean;
  /** ARIA label for the wrapping <section>. Defaults to `title`. */
  ariaLabel?: string;
  /** Data-testid for the toggle button. */
  testId?: string;
  /** Class for the wrapping <section>. Lets the host apply existing section spacing. */
  sectionClassName?: string;
  /** Class for the header row. Used to hand over the host view's flex/typography. */
  headerClassName?: string;
  /** Class for the title element. */
  titleClassName?: string;
  /** Class for the count chip. */
  countClassName?: string;
  /** Class for the chevron span. */
  chevronClassName?: string;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  count,
  headerAction,
  defaultExpanded = true,
  ariaLabel,
  testId,
  sectionClassName,
  headerClassName,
  titleClassName,
  countClassName,
  chevronClassName,
  children
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);

  // Click handler on the header row: toggle, EXCEPT when the click originated
  // inside the `headerAction` subtree. We tag the action wrapper with a marker
  // attribute and walk up from the click target — anything inside the action
  // is excluded. Avoids the "user clicks the Re-scan button and the section
  // also toggles" bug.
  const onHeaderClick = useCallback((e: MouseEvent<HTMLElement>) => {
    let node: HTMLElement | null = e.target as HTMLElement;
    while (node !== null && node !== e.currentTarget) {
      if (node.dataset?.collapsibleAction === 'true') return;
      node = node.parentElement;
    }
    setExpanded((v) => !v);
  }, []);

  return (
    <section className={sectionClassName} aria-label={ariaLabel ?? title}>
      <div
        className={headerClassName}
        onClick={onHeaderClick}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        data-testid={testId}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <span aria-hidden="true" className={chevronClassName} style={{ marginRight: '0.4em' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span className={titleClassName} style={{ flex: '1 1 auto' }}>
          {title}
          {typeof count === 'number' && (
            <span className={countClassName}> ({count})</span>
          )}
        </span>
        {headerAction !== undefined && (
          <span data-collapsible-action="true" onClick={(e) => e.stopPropagation()}>
            {headerAction}
          </span>
        )}
      </div>
      {expanded && children}
    </section>
  );
}
