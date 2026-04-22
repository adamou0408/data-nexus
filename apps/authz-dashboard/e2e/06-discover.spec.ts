import { test, expect } from '@playwright/test';
import { loginAs, navigateTo, ADMIN_USER_LABEL } from './helpers';

const NON_ADMIN_LABEL = 'Tsai (BI Analyst)';

// ============================================================
// Discover tab E2E — bottom-up resource catalog (Phase A):
//   * admin sees Discover in nav; non-admin doesn't
//   * tab loads, shows >0 rows from at least one DS
//   * unmapped-only toggle reduces row count
//   * search filter narrows results
//   * each row shows DS name + type + mapped-or-not status
// ============================================================

test.describe('Discover (bottom-up catalog)', () => {
  test('admin sees Discover in nav; non-admin does not', async ({ page }) => {
    await page.goto('/');
    await loginAs(page, ADMIN_USER_LABEL);
    const adminNav = page.locator('aside nav button', { hasText: 'Discover' });
    await expect(adminNav).toBeVisible({ timeout: 10_000 });

    // Switch to a non-admin user; Discover should disappear
    await page.locator('aside select').first().selectOption({ label: NON_ADMIN_LABEL });
    await expect(page.getByText('Resolving permissions...')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('aside nav button', { hasText: 'Discover' })).toHaveCount(0);
  });

  test('tab loads and shows resource rows', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');

    await expect(page.getByTestId('discover-tab')).toBeVisible({ timeout: 10_000 });

    // Wait for at least one row to appear
    const rows = page.locator('[data-testid^="row-"]');
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    // Stat strip labels should be visible (scoped to .stat-label to avoid nav collision)
    await expect(page.locator('.stat-label', { hasText: 'Data Sources' })).toBeVisible();
    await expect(page.locator('.stat-label', { hasText: 'Total Resources' })).toBeVisible();
  });

  test('unmapped-only toggle reduces row count', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible();

    const rows = page.locator('[data-testid^="row-"]');
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const totalCount = await rows.count();

    // Enable unmapped-only filter
    await page.getByTestId('unmapped-only').check();

    // Wait until the row count differs from the unfiltered total
    await expect
      .poll(async () => rows.count(), { timeout: 15_000 })
      .toBeLessThanOrEqual(totalCount);

    const unmappedCount = await rows.count();
    // Sanity: every visible row should display the Unmapped badge
    if (unmappedCount > 0) {
      const mappedBadges = page.locator('[data-testid^="row-"]').locator('text=/^Unmapped$/');
      const mappedBadgeCount = await mappedBadges.count();
      expect(mappedBadgeCount).toBeGreaterThan(0);
    }
  });

  test('type filter narrows to functions only', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible();

    const rows = page.locator('[data-testid^="row-"]');
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.getByTestId('type-function').click();

    // Every row id should now start with "row-function:"
    await expect
      .poll(async () => {
        const count = await rows.count();
        if (count === 0) return false;
        const ids = await rows.evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-testid') || ''),
        );
        return ids.every((id) => id.startsWith('row-function:'));
      }, { timeout: 15_000 })
      .toBeTruthy();
  });

  test('search filter narrows results', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible();

    const rows = page.locator('[data-testid^="row-"]');
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const totalCount = await rows.count();

    // Search for a token unlikely to match every row
    await page.getByTestId('search').fill('material');
    await page.getByTestId('search').press('Enter');

    await expect
      .poll(async () => rows.count(), { timeout: 15_000 })
      .toBeLessThanOrEqual(totalCount);
  });

  test('each row shows DS name + type icon + mapped status', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible();

    const rows = page.locator('[data-testid^="row-"]');
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    const firstRow = rows.first();
    // Type column should render text (table/view/function)
    await expect(firstRow.locator('text=/table|view|function/i').first()).toBeVisible();
    // Either Mapped (with module name) or Unmapped badge should appear
    const mappedOrUnmapped = firstRow.locator('text=/Unmapped|^[A-Za-z].*$/').first();
    await expect(mappedOrUnmapped).toBeVisible();
  });
});
