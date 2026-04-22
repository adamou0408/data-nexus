import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';

// ============================================================
// Discover → Bulk operations (Phase E):
//   Select N rows → sticky action bar → three modes:
//     - Promote N into new Module (create_attach)
//     - Attach N to existing
//     - Detach N
//
//   Both tests select rows, mutate them, then restore so the
//   seed catalog stays usable across runs.
// ============================================================

test.describe('Discover → Bulk (Phase E)', () => {
  test('bulk create_attach promotes N unmapped rows into one new module', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible({ timeout: 10_000 });

    // Filter to unmapped only so the selection is naturally consistent.
    await page.getByTestId('unmapped-only').check();
    await expect(page.getByTestId('discover-tab')).toBeVisible();

    // Wait for at least 2 unmapped rows; if fewer, skip.
    const promoteBtns = page.locator('[data-testid^="promote-"]:not([data-testid="promote-modal"]):not([data-testid^="promote-mode-"]):not([data-testid^="promote-module-"]):not([data-testid="promote-name"]):not([data-testid="promote-confirm"]):not([data-testid="promote-module-search"]):not([data-testid="promote-module-list"])');
    const initialCount = await promoteBtns.count();
    test.skip(initialCount < 2, 'Need at least 2 unmapped rows for bulk test');

    // Capture two row resource_ids by walking up to <tr> from the first 2 promote buttons.
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const tr = promoteBtns.nth(i).locator('xpath=ancestor::tr');
      const tid = await tr.getAttribute('data-testid');
      ids.push(tid!.replace(/^row-/, ''));
    }

    // Tick the row checkboxes.
    for (const id of ids) {
      await page.getByTestId(`select-${id}`).check();
    }

    // Sticky bulk bar appears with N selected.
    const bar = page.getByTestId('bulk-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(`${ids.length} selected`);

    // Open create_attach modal.
    await page.getByTestId('bulk-create-attach').click();
    await expect(page.getByTestId('bulk-modal')).toBeVisible();

    const moduleName = `BulkE2E_${Date.now()}`;
    await page.getByTestId('bulk-module-name').fill(moduleName);
    await page.getByTestId('bulk-confirm').click();
    await expect(page.getByTestId('bulk-modal')).toBeHidden({ timeout: 15_000 });

    // Verify both rows are now mapped to the new module.
    await page.getByTestId('unmapped-only').uncheck();
    for (const id of ids) {
      const search = page.getByTestId('search');
      await search.fill(id);
      await search.press('Enter');
      const row = page.getByTestId(`row-${id}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row.getByText(moduleName)).toBeVisible({ timeout: 10_000 });
    }

    // Restore: detach the rows so the seed remains unmapped.
    await page.getByTestId('search').fill('');
    await page.getByTestId('search').press('Enter');
    for (const id of ids) {
      await page.getByTestId(`select-${id}`).check();
    }
    await page.getByTestId('bulk-detach').click();
    await expect(page.getByTestId('bulk-modal')).toBeVisible();
    await page.getByTestId('bulk-confirm').click();
    await expect(page.getByTestId('bulk-modal')).toBeHidden({ timeout: 15_000 });
  });

  test('bulk detach returns N mapped rows to the unmapped pool', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Discover');
    await expect(page.getByTestId('discover-tab')).toBeVisible({ timeout: 10_000 });

    // Find at least 2 mapped rows (those have a Move button, not a Promote button).
    const moveBtns = page.locator('[data-testid^="reparent-"]');
    const initialCount = await moveBtns.count();
    test.skip(initialCount < 2, 'Need at least 2 mapped rows for bulk detach test');

    // Capture 2 ids and their original module names so we can restore.
    const targets: { id: string; module: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const tr = moveBtns.nth(i).locator('xpath=ancestor::tr');
      const tid = await tr.getAttribute('data-testid');
      const id = tid!.replace(/^row-/, '');
      const moduleText = (await tr.locator('td').nth(5).textContent())?.trim() || '';
      targets.push({ id, module: moduleText });
    }

    for (const t of targets) {
      await page.getByTestId(`select-${t.id}`).check();
    }
    const bar = page.getByTestId('bulk-bar');
    await expect(bar).toBeVisible();

    await page.getByTestId('bulk-detach').click();
    await expect(page.getByTestId('bulk-modal')).toBeVisible();
    await page.getByTestId('bulk-confirm').click();
    await expect(page.getByTestId('bulk-modal')).toBeHidden({ timeout: 15_000 });

    // Verify rows are unmapped.
    for (const t of targets) {
      const search = page.getByTestId('search');
      await search.fill(t.id);
      await search.press('Enter');
      const row = page.getByTestId(`row-${t.id}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row.getByText('Unmapped')).toBeVisible({ timeout: 10_000 });
    }

    // Restore each via single-row promote (attach to original module).
    for (const t of targets) {
      const search = page.getByTestId('search');
      await search.fill(t.id);
      await search.press('Enter');
      await page.getByTestId(`promote-${t.id}`).click();
      await expect(page.getByTestId('promote-modal')).toBeVisible();
      await page.getByTestId('promote-mode-attach').click();
      const restoreBtn = page.getByTestId('promote-module-list')
        .locator('[data-testid^="promote-module-"]')
        .filter({ hasText: t.module })
        .first();
      await expect(restoreBtn).toBeVisible({ timeout: 10_000 });
      await restoreBtn.click();
      await page.getByTestId('promote-confirm').click();
      await expect(page.getByTestId('promote-modal')).toBeHidden({ timeout: 10_000 });
    }
  });
});
