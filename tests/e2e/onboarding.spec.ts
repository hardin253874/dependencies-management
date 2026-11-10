/**
 * E2E — First-launch onboarding (spec §16, Stage 1)
 *
 * Stage 1 scope: enter dummy key (mocked test endpoint),
 * add `small-modern` fixture project, middle panel renders within 2s
 * with deps + installed versions.
 *
 * NOTE: Backend stream owns the API endpoints + fixture vendoring (see
 * IMPLEMENTATION_PLAN.md §B.1). Until those land, this test runs against
 * the live dev server with backend mocks. It is wired and ready, but will
 * fail until Backend stream completes their Stage 1 work.
 *
 * Run: `npm run test:e2e`.
 */

import { test, expect } from '@playwright/test';

test('first-launch onboarding flow', async ({ page }) => {
  await page.goto('/');

  // Step 1 — welcome card visible.
  await expect(page.getByRole('heading', { name: 'Welcome to Dependencies Agent' })).toBeVisible({
    timeout: 10_000
  });

  // Get started → step 2 (LLM setup).
  await page.getByTestId('welcome-continue').click();

  // Step 2 — paste a dummy key, save. (v2: Anthropic is the only provider,
  // so there is no provider radio to pick any more.)
  await page.getByTestId('onboarding-apikey').fill('sk-ant-test-key');
  await page.getByTestId('onboarding-llm-continue').click();

  // Step 3 — Add project pointing at the small-modern fixture.
  // The fixture path is anchored by Backend's test-fixtures setup.
  const fixturePath = process.env.SMALL_MODERN_FIXTURE_PATH ?? 'test-fixtures/projects/small-modern';
  await page.getByTestId('picker-input').fill(fixturePath);

  // Wait for validation (debounced) to flip Add Project to enabled.
  const addBtn = page.getByTestId('onboarding-add-project');
  await expect(addBtn).toBeEnabled({ timeout: 5_000 });

  // Add → middle panel should render within 2s with dep names.
  await addBtn.click();

  // Verify middle panel populated.
  await expect(page.getByRole('complementary', { name: 'Dependencies' })).toBeVisible({
    timeout: 5_000
  });
  // Spec §15: middle panel renders within 2s — Playwright soft check.
  await expect(page.getByText(/dependencies \(/)).toBeVisible({ timeout: 2_000 });
});
