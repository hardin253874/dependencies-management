/**
 * Stage 2 — BadgeCluster glyph rendering tests.
 *
 * Each state from spec §7.5 is exercised in isolation against the design
 * decisions captured in UI_DESIGN.md §2.3 (render order, accessibility text).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BadgeCluster, deriveBadgeState } from '@/components/MiddlePanel/BadgeCluster';

describe('BadgeCluster', () => {
  it('renders a single `?` placeholder when unscanned', () => {
    render(<BadgeCluster badges={{ outdatedSeverity: null, hasCve: null, deprecated: null, unscanned: true }} />);
    const cluster = screen.getByRole('img');
    expect(cluster).toHaveAttribute('aria-label', 'Not yet scanned');
    expect(cluster.querySelectorAll('[data-glyph]')).toHaveLength(1);
    expect(cluster.querySelector('[data-glyph="unscanned"]')?.textContent).toBe('?');
  });

  it('renders red ↑ for a major outdated dep', () => {
    render(
      <BadgeCluster
        badges={{ outdatedSeverity: 'major', hasCve: false, deprecated: false }}
      />
    );
    const major = screen.getByRole('img').querySelector('[data-glyph="outdated-major"]');
    expect(major).not.toBeNull();
    expect(major?.textContent).toBe('↑');
  });

  it('renders amber ↑ for a minor outdated dep', () => {
    render(
      <BadgeCluster
        badges={{ outdatedSeverity: 'minor', hasCve: false, deprecated: false }}
      />
    );
    const minor = screen.getByRole('img').querySelector('[data-glyph="outdated-minor"]');
    expect(minor).not.toBeNull();
  });

  it('renders a red CVE • dot when hasCve is true', () => {
    render(
      <BadgeCluster
        badges={{ outdatedSeverity: null, hasCve: true, deprecated: false }}
      />
    );
    const cve = screen.getByRole('img').querySelector('[data-glyph="cve"]');
    expect(cve).not.toBeNull();
    expect(cve?.textContent).toBe('•');
  });

  it('renders a gray ⊘ for a deprecated dep', () => {
    render(
      <BadgeCluster
        badges={{ outdatedSeverity: null, hasCve: false, deprecated: true }}
      />
    );
    const dep = screen.getByRole('img').querySelector('[data-glyph="deprecated"]');
    expect(dep).not.toBeNull();
    expect(dep?.textContent).toBe('⊘');
  });

  it('renders a clean ✓ when scanned with no issues', () => {
    render(
      <BadgeCluster
        badges={{ outdatedSeverity: null, hasCve: false, deprecated: false }}
      />
    );
    const cluster = screen.getByRole('img');
    expect(cluster).toHaveAttribute('aria-label', 'current and clean');
    expect(cluster.querySelector('[data-glyph="clean"]')?.textContent).toBe('✓');
  });

  it('renders a gray ? for CVE-data-unavailable', () => {
    render(
      <BadgeCluster
        badges={{
          outdatedSeverity: null,
          hasCve: null,
          deprecated: false,
          cveDataUnavailable: true
        }}
      />
    );
    const cve = screen.getByRole('img').querySelector('[data-glyph="cve-unknown"]');
    expect(cve).not.toBeNull();
  });

  it('renders multiple glyphs in render order (outdated → CVE → deprecated)', () => {
    render(
      <BadgeCluster
        badges={{ outdatedSeverity: 'major', hasCve: true, deprecated: true }}
      />
    );
    const glyphs = Array.from(screen.getByRole('img').querySelectorAll('[data-glyph]'));
    expect(glyphs.map((g) => g.getAttribute('data-glyph'))).toEqual([
      'outdated-major',
      'cve',
      'deprecated'
    ]);
  });

  it('deriveBadgeState marks unscanned when all values null', () => {
    expect(
      deriveBadgeState({ outdatedSeverity: null, hasCve: null, deprecated: null }).unscanned
    ).toBe(true);
    expect(
      deriveBadgeState({ outdatedSeverity: null, hasCve: false, deprecated: false }).unscanned
    ).toBe(false);
  });
});
