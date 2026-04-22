import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';

test.describe('Query Tool — Run mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Query Tool');
  });

  test('shows Run / Author toggle and data source picker', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Run$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Author$/ })).toBeVisible();
    // Data source dropdown present
    const dsSelect = page.locator('main select').first();
    await expect(dsSelect).toBeVisible();
  });

  test('subtype filter chips render with counts', async ({ page }) => {
    // Give functions time to load
    await page.waitForTimeout(1500);
    const main = page.locator('main');
    for (const chip of ['All', 'Query', 'Calculation', 'Action', 'Report']) {
      await expect(
        main.getByRole('button', { name: new RegExp(`^${chip}\\s*\\(\\d+\\)$`) })
      ).toBeVisible();
    }
  });

  test('pg_k8 appears in data source list', async ({ page }) => {
    const dsSelect = page.locator('main select').first();
    const options = await dsSelect.locator('option').allTextContents();
    const hasPgK8 = options.some((o) => /pg_k8/i.test(o));
    expect(hasPgK8, `Expected pg_k8 in options, got: ${options.join(' | ')}`).toBeTruthy();
  });
});
