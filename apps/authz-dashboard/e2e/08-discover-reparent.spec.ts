import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';

// ============================================================
// Discover → Reparent (Phase D):
//   Inverse of Promote. From a mapped row, the user can:
//     - Move:   reparent under a different Module
//     - Detach: return to the unmapped pool (parent_id = NULL)
//
//  Both tests find a mapped row, mutate it, then restore it so
//  the seed catalog stays usable across runs.
// ============================================================

test.describe('Discover → Reparent (Phase D)', () => {
  test('move reparents a mapped resource under a different module', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible({ timeout: 10_000 });

    // Find any mapped row (Move button = data-testid^="reparent-")
    const moveBtn = page.locator('[data-testid^="reparent-"]').first();
    await expect(moveBtn).toBeVisible({ timeout: 10_000 });
    const rowEl = moveBtn.locator('xpath=ancestor::tr');
    const rowTestId = await rowEl.getAttribute('data-testid');
    const resourceId = rowTestId!.replace(/^row-/, '');
    const originalModule = (await rowEl.locator('td').nth(5).textContent())?.trim() || '';
    expect(originalModule.length).toBeGreaterThan(0);

    // Open modal — defaults to "Move" mode
    await moveBtn.click();
    await expect(page.getByTestId('reparent-modal')).toBeVisible();

    // Pick the first module in the list (current module is filtered out)
    const moduleList = page.getByTestId('reparent-module-list');
    const firstModuleBtn = moduleList.locator('[data-testid^="reparent-module-"]').first();
    await expect(firstModuleBtn).toBeVisible({ timeout: 10_000 });
    const newModuleName = (await firstModuleBtn.locator('div').first().textContent())?.trim() || '';
    expect(newModuleName.length).toBeGreaterThan(0);
    expect(newModuleName).not.toBe(originalModule);
    await firstModuleBtn.click();

    await page.getByTestId('reparent-confirm').click();
    await expect(page.getByTestId('reparent-modal')).toBeHidden({ timeout: 10_000 });

    // Verify new module name appears on the row
    const search = page.getByTestId('search');
    await search.fill(resourceId);
    await search.press('Enter');
    const movedRow = page.getByTestId(`row-${resourceId}`);
    await expect(movedRow).toBeVisible({ timeout: 10_000 });
    await expect(movedRow.getByText(newModuleName)).toBeVisible({ timeout: 10_000 });

    // Restore: move back to the original module
    const moveBackBtn = movedRow.locator('[data-testid^="reparent-"]');
    await moveBackBtn.click();
    await expect(page.getByTestId('reparent-modal')).toBeVisible();
    const restoreBtn = page.getByTestId('reparent-module-list')
      .locator('[data-testid^="reparent-module-"]')
      .filter({ hasText: originalModule })
      .first();
    await expect(restoreBtn).toBeVisible({ timeout: 10_000 });
    await restoreBtn.click();
    await page.getByTestId('reparent-confirm').click();
    await expect(page.getByTestId('reparent-modal')).toBeHidden({ timeout: 10_000 });
  });

  test('detach returns a mapped resource to the unmapped pool', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible({ timeout: 10_000 });

    const moveBtn = page.locator('[data-testid^="reparent-"]').first();
    await expect(moveBtn).toBeVisible({ timeout: 10_000 });
    const rowEl = moveBtn.locator('xpath=ancestor::tr');
    const rowTestId = await rowEl.getAttribute('data-testid');
    const resourceId = rowTestId!.replace(/^row-/, '');
    const originalModule = (await rowEl.locator('td').nth(5).textContent())?.trim() || '';
    expect(originalModule.length).toBeGreaterThan(0);

    await moveBtn.click();
    await expect(page.getByTestId('reparent-modal')).toBeVisible();
    await page.getByTestId('reparent-mode-detach').click();
    await page.getByTestId('reparent-confirm').click();
    await expect(page.getByTestId('reparent-modal')).toBeHidden({ timeout: 10_000 });

    // Row should now show "Unmapped" and a Promote button
    const search = page.getByTestId('search');
    await search.fill(resourceId);
    await search.press('Enter');
    const detachedRow = page.getByTestId(`row-${resourceId}`);
    await expect(detachedRow).toBeVisible({ timeout: 10_000 });
    await expect(detachedRow.getByText('Unmapped')).toBeVisible({ timeout: 10_000 });
    await expect(detachedRow.locator(`[data-testid="promote-${resourceId}"]`)).toBeVisible();

    // Restore: promote back to the original module via attach mode
    await detachedRow.locator(`[data-testid="promote-${resourceId}"]`).click();
    await expect(page.getByTestId('promote-modal')).toBeVisible();
    await page.getByTestId('promote-mode-attach').click();
    const restoreBtn = page.getByTestId('promote-module-list')
      .locator('[data-testid^="promote-module-"]')
      .filter({ hasText: originalModule })
      .first();
    await expect(restoreBtn).toBeVisible({ timeout: 10_000 });
    await restoreBtn.click();
    await page.getByTestId('promote-confirm').click();
    await expect(page.getByTestId('promote-modal')).toBeHidden({ timeout: 10_000 });
  });
});
