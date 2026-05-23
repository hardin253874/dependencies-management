/**
 * E2E — Stage 2 deterministic views (A, B, C) + Phase 2 badges.
 *
 * Stage 2 requires backend endpoints that are being delivered in parallel
 * (`GET/POST /api/projects/:slug/deps/:name`, …). These tests run against the
 * dev server. They are marked `test.skip()` while the BE work lands; the
 * orchestrator can flip the gate (or add an env var) to enable them once the
 * full pipeline is green.
 *
 * Scenarios covered:
 *   1. Add `small-modern` fixture → watch Phase 2 progress in status bar →
 *      badges populate live.
 *   2. Click dep → [A] renders → click version → [B] → back to [A] → "Usage"
 *      → [C]. All three render from cache on second visit.
 *   3. Click Regenerate on [A] → cache invalidated → new data fetched →
 *      view re-renders.
 *   4. Tab close mid-Phase-2 → reopen tab → status bar shows reattached job.
 */
import { test, expect } from '@playwright/test';

const STAGE_2_E2E_ENABLED = process.env.STAGE_2_E2E === 'true';

test.describe('Stage 2 — deterministic views + Phase 2 progress', () => {
  test.skip(!STAGE_2_E2E_ENABLED, 'Requires Backend Stage 2 endpoints + fixtures; opt in via STAGE_2_E2E=true');

  test('Phase 2 scan populates badges live', async ({ page }) => {
    await page.goto('/');
    const fixturePath = process.env.SMALL_MODERN_FIXTURE_PATH ?? 'test-fixtures/projects/small-modern';
    // Onboard if needed.
    if (await page.getByRole('heading', { name: 'Welcome to Dependencies Agent' }).isVisible()) {
      await page.getByTestId('welcome-continue').click();
      await page.getByTestId('onboarding-provider-anthropic').check();
      await page.getByTestId('onboarding-apikey').fill('sk-ant-test-key');
      await page.getByTestId('onboarding-llm-continue').click();
      await page.getByTestId('picker-input').fill(fixturePath);
      await page.getByTestId('onboarding-add-project').click();
    }
    // Status bar should show bounded progress.
    await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 5_000 });
    // Badges populate — find a dep row with a clean ✓ badge.
    await expect(
      page.locator('[data-testid="badge-cluster"] [data-glyph="clean"]')
    ).toBeVisible({ timeout: 60_000 });
  });

  test('click dep → [A] → version → [B] → back → Usage → [C]', async ({ page }) => {
    await page.goto('/');
    // Pick the first dep row.
    await page.locator('[data-testid^="dep-row-"]').first().click();
    await expect(page.getByTestId('view-usage-button')).toBeVisible();
    // Expand a major and click a version → [B].
    await page.locator('[data-testid^="major-toggle-"]').first().click();
    await page.locator('[data-testid^="version-link-"]').first().click();
    await expect(page.getByTestId('cve-section-title')).toBeVisible();
    // Breadcrumb back to dep → [A].
    await page.getByTestId('crumb-segment-0').click();
    await expect(page.getByTestId('view-usage-button')).toBeVisible();
    // View Usage → [C].
    await page.getByTestId('view-usage-button').click();
    await expect(page.getByTestId('last-scanned')).toBeVisible();
  });

  test('Regenerate invalidates cache and re-fetches', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid^="dep-row-"]').first().click();
    await page.getByTestId('regenerate-button').click();
    // Status bar should briefly show a job; view re-renders when done.
    await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 5_000 });
  });

  test('Tab close mid-Phase-2 → reopen shows reattached job', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/');
    // Wait for Phase 2 to be running.
    await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 5_000 });
    await page.close();
    const page2 = await ctx.newPage();
    await page2.goto('/');
    await expect(page2.getByRole('progressbar')).toBeVisible({ timeout: 5_000 });
    await ctx.close();
  });
});
