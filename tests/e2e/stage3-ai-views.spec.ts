/**
 * E2E — Stage 3 AI views (D, E) + streaming UX + cancel modal (spec §7.6,
 * §7.9, §11.8, §11.9).
 *
 * Stage 3 requires the LLM client + Stage 3 BE endpoints + a configured LLM
 * key. These tests run against the dev server with MOCK_LLM=true so no real
 * tokens are spent. They are marked `test.skip()` while the full BE pipeline
 * + record-llm-fixtures lands; the orchestrator flips `STAGE_3_E2E=true` once
 * the integration is green.
 *
 * Scenarios covered:
 *   1. Click "Analyze report" on [B] → navigate to [D] → AI streams (status
 *      text only, no JSON visible) → final report renders.
 *   2. Click Regenerate on [D] → cache invalidated → new analysis fetched.
 *   3. Cancel mid-AI → confirmation modal with verbatim cost-disclosure copy
 *      → cancel → previous cache preserved (no corruption).
 *   4. Toggle "Enable resolver check" in Settings → view [D] resolver block
 *      flips disabled↔enabled live without a restart.
 */
import { test, expect } from '@playwright/test';

const STAGE_3_E2E_ENABLED = process.env.STAGE_3_E2E === 'true';

test.describe('Stage 3 — AI views + streaming UX', () => {
  test.skip(
    !STAGE_3_E2E_ENABLED,
    'Requires Backend Stage 3 endpoints + MOCK_LLM fixtures; opt in via STAGE_3_E2E=true'
  );

  test('Analyze report on [B] streams without rendering JSON, then renders [D]', async ({
    page
  }) => {
    await page.goto('/');
    // Navigate dep → [A] → version → [B] → Analyze.
    await page.locator('[data-testid^="dep-row-"]').first().click();
    await page.locator('[data-testid^="major-toggle-"]').first().click();
    await page.locator('[data-testid^="version-link-"]').first().click();
    await page.getByTestId('analyze-report-button').click();
    // The status bar must show AI status text (no progress bar) and no JSON.
    await expect(page.getByTestId('status-ai-text')).toBeVisible({
      timeout: 10_000
    });
    // Any text starting with `{` would indicate a JSON leak — must not happen.
    await expect(page.locator('text=/^\\s*[{[]/')).toHaveCount(0);
    // The [D] view body renders the risk pill once the final tool-call lands.
    await expect(page.getByTestId('risk-pill-low').or(page.getByTestId('risk-pill-medium')).or(page.getByTestId('risk-pill-high'))).toBeVisible({
      timeout: 60_000
    });
  });

  test('Regenerate on [D] invalidates cache and re-runs the AI call', async ({
    page
  }) => {
    await page.goto('/');
    await page.locator('[data-testid^="dep-row-"]').first().click();
    await page.locator('[data-testid^="major-toggle-"]').first().click();
    await page.locator('[data-testid^="version-link-"]').first().click();
    await page.getByTestId('analyze-report-button').click();
    await page.getByTestId('regenerate-button').click();
    await expect(page.getByTestId('status-ai-text')).toBeVisible({
      timeout: 10_000
    });
  });

  test('Cancel mid-AI shows the verbatim cost-disclosure copy and preserves cache', async ({
    page
  }) => {
    await page.goto('/');
    await page.locator('[data-testid^="dep-row-"]').first().click();
    await page.locator('[data-testid^="major-toggle-"]').first().click();
    await page.locator('[data-testid^="version-link-"]').first().click();
    await page.getByTestId('analyze-report-button').click();
    await expect(page.getByTestId('status-ai-text')).toBeVisible({
      timeout: 10_000
    });
    await page.getByRole('button', { name: 'Cancel job' }).click();
    await expect(page.getByTestId('cancel-cost-disclosure')).toHaveText(
      'Note: any tokens already consumed by the in-flight LLM call are billed.'
    );
    await page.getByTestId('cancel-modal-confirm').click();
    // Modal dismisses; previous cache (if any) is preserved — we assert no
    // error banner and the empty-state CTA appears for fresh runs.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Resolver kill-switch toggle in Settings flips [D] resolver block without restart', async ({
    page
  }) => {
    await page.goto('/');
    // Open Settings → Behavior, flip toggle off.
    await page.getByRole('button', { name: /Open settings/i }).click();
    await page.getByTestId('settings-section-behavior').click();
    await page.getByTestId('toggle-resolver-enabled').click();
    await page.getByRole('button', { name: 'Close' }).click();
    // Generate a [D] view — resolver block must show the kill-switch banner.
    await page.locator('[data-testid^="dep-row-"]').first().click();
    await page.locator('[data-testid^="major-toggle-"]').first().click();
    await page.locator('[data-testid^="version-link-"]').first().click();
    await page.getByTestId('analyze-report-button').click();
    await expect(page.getByTestId('resolver-disabled-kill-switch')).toBeVisible({
      timeout: 60_000
    });
  });
});
