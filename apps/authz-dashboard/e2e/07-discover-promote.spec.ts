import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';

// ============================================================
// Discover → Promote to Module (Phase B):
//   Picks an unmapped resource, opens the modal, names a new module,
//   confirms the row flips to "mapped" after reload.
//
// NOTE: this test mutates DB state (creates a module + reparents a
// resource). The module name is timestamp-suffixed to avoid collisions
// across runs. The created module is left behind — manual cleanup OK
// for POC; a teardown hook can be added later.
// ============================================================

test.describe('Discover → Promote to Module (Phase B)', () => {
  test('promote unmapped resource creates module and re-renders as mapped', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible({ timeout: 10_000 });

    // Filter to unmapped only so the first row is guaranteed unmapped + has a Promote button
    await page.getByTestId('unmapped-only').check();

    const rows = page.locator('[data-testid^="row-"]');
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    // Find the first row that has a Promote button (will skip rows already mapped)
    const promoteBtn = page.locator('[data-testid^="promote-"]').first();
    await expect(promoteBtn).toBeVisible({ timeout: 10_000 });

    // Capture the row's resource_id from its parent <tr> testid
    const rowEl = promoteBtn.locator('xpath=ancestor::tr');
    const rowTestId = await rowEl.getAttribute('data-testid');
    expect(rowTestId).toMatch(/^row-/);
    const resourceId = rowTestId!.replace(/^row-/, '');

    // Open modal
    await promoteBtn.click();
    await expect(page.getByTestId('promote-modal')).toBeVisible();

    // Type a unique module name
    const moduleName = `E2E Promote ${Date.now()}`;
    const nameInput = page.getByTestId('promote-name');
    await nameInput.fill(moduleName);

    // Submit
    await page.getByTestId('promote-confirm').click();

    // Modal closes
    await expect(page.getByTestId('promote-modal')).toBeHidden({ timeout: 10_000 });

    // After load(), the unmapped filter is still on, so the promoted row
    // should disappear from the unmapped list. Toggle off to re-find it.
    await page.getByTestId('unmapped-only').uncheck();

    // Search for the original resource_id and confirm the badge now shows
    // the new module name instead of "Unmapped".
    const search = page.getByTestId('search');
    await search.fill(resourceId);
    await search.press('Enter');

    const promotedRow = page.getByTestId(`row-${resourceId}`);
    await expect(promotedRow).toBeVisible({ timeout: 10_000 });
    await expect(promotedRow.getByText(moduleName)).toBeVisible({ timeout: 10_000 });
    // Promote button should be gone for this row
    await expect(promotedRow.locator('[data-testid^="promote-"]')).toHaveCount(0);
  });

  test('cancel button closes modal without promoting', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible();

    await page.getByTestId('unmapped-only').check();
    const promoteBtn = page.locator('[data-testid^="promote-"]').first();
    await expect(promoteBtn).toBeVisible({ timeout: 10_000 });

    await promoteBtn.click();
    await expect(page.getByTestId('promote-modal')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('promote-modal')).toBeHidden();
  });

  test('attach mode reparents unmapped resource under existing module', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible({ timeout: 10_000 });

    // Find an unmapped row + capture its resource_id
    await page.getByTestId('unmapped-only').check();
    const promoteBtn = page.locator('[data-testid^="promote-"]').first();
    await expect(promoteBtn).toBeVisible({ timeout: 10_000 });
    const rowEl = promoteBtn.locator('xpath=ancestor::tr');
    const rowTestId = await rowEl.getAttribute('data-testid');
    const resourceId = rowTestId!.replace(/^row-/, '');

    // Open modal, switch to attach mode
    await promoteBtn.click();
    await expect(page.getByTestId('promote-modal')).toBeVisible();
    await page.getByTestId('promote-mode-attach').click();

    // Module list should populate
    const moduleList = page.getByTestId('promote-module-list');
    await expect(moduleList).toBeVisible();

    // Pick the first available module and capture its display name
    const firstModuleBtn = moduleList.locator('[data-testid^="promote-module-"]').first();
    await expect(firstModuleBtn).toBeVisible({ timeout: 10_000 });
    const moduleName = (await firstModuleBtn.locator('div').first().textContent())?.trim() || '';
    expect(moduleName.length).toBeGreaterThan(0);
    await firstModuleBtn.click();

    // Submit
    await page.getByTestId('promote-confirm').click();
    await expect(page.getByTestId('promote-modal')).toBeHidden({ timeout: 10_000 });

    // Verify the row now shows the existing module name and Promote is gone
    await page.getByTestId('unmapped-only').uncheck();
    const search = page.getByTestId('search');
    await search.fill(resourceId);
    await search.press('Enter');

    const attachedRow = page.getByTestId(`row-${resourceId}`);
    await expect(attachedRow).toBeVisible({ timeout: 10_000 });
    await expect(attachedRow.getByText(moduleName)).toBeVisible({ timeout: 10_000 });
    await expect(attachedRow.locator('[data-testid^="promote-"]')).toHaveCount(0);
  });
});
