import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';

test.describe('Smoke — dashboard boot + login', () => {
  test('dashboard loads and admin can log in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Data Nexus').first()).toBeVisible();
    await expect(page.getByText('AuthZ Platform').first()).toBeVisible();
    await loginAs(page);
    // After login, admin-only groups should be visible in sidebar
    await expect(page.locator('aside nav').getByText('AuthZ Tools')).toBeVisible();
    await expect(page.locator('aside nav').getByText('Identity & Access')).toBeVisible();
  });

  test('all Data nav items are reachable', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    for (const label of ['Data Explorer', 'Query Tool', 'Metabase BI']) {
      await navigateTo(page, label);
      await expect(page.locator('main')).toBeVisible();
    }
  });
});
