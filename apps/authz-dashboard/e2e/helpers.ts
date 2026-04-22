import { Page, expect } from '@playwright/test';

export const ADMIN_USER_ID = 'sys_admin';
export const ADMIN_USER_LABEL = 'SysAdmin';
export const PG_K8_DS_ID = 'ds:pg_k8';

/**
 * Log in by selecting a user from the sidebar user selector.
 * Waits until permissions have been resolved (loading spinner gone).
 */
export async function loginAs(page: Page, userLabel: string = ADMIN_USER_LABEL) {
  const selector = page.locator('aside select').first();
  await expect(selector).toBeVisible({ timeout: 15_000 });
  // Wait for users to finish loading — dropdown label changes away from "Loading users..."
  await expect
    .poll(async () => {
      const opts = await selector.locator('option').allTextContents();
      return opts.some((o) => o.includes(userLabel));
    }, { timeout: 15_000, message: `Expected user option "${userLabel}" to appear` })
    .toBeTruthy();
  await selector.selectOption({ label: userLabel });
  // Wait for "Resolving permissions..." to finish
  await expect(page.getByText('Resolving permissions...')).toBeHidden({ timeout: 15_000 });
}

/**
 * Click a sidebar nav item by its visible label.
 * Example: navigateTo(page, 'Query Tool')
 */
export async function navigateTo(page: Page, label: string) {
  await page.locator('aside nav button', { hasText: label }).first().click();
}

/**
 * Select a data source from the Query Tool's DS dropdown.
 * Matches on label substring (display_name + source_id are rendered together).
 */
export async function selectDataSource(page: Page, displayNameFragment: string) {
  const ds = page.locator('select').filter({ hasText: displayNameFragment }).first();
  await expect(ds).toBeVisible({ timeout: 10_000 });
  await ds.selectOption({ label: new RegExp(displayNameFragment) });
}
