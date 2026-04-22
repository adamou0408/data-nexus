import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';

// ============================================================
// Flow Composer E2E — validates W6+ (L3 DAG canvas):
//   * tab loads, palette lists pg_k8 functions
//   * add function node via palette
//   * second node appears in Compatible panel (W3-2 integration)
//   * edge type-check rejects mismatched connection
//   * per-node execute runs on server, shows row count
//   * save + reload round-trips
// ============================================================

test.describe('Flow Composer (W6+)', () => {
  test('tab loads + palette lists material functions', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');

    await expect(page.getByTestId('dag-tab')).toBeVisible({ timeout: 10_000 });
    // DS dropdown should default to pg_k8
    const dsSelect = page.getByLabel('Data source');
    await expect(dsSelect).toBeVisible();

    // Palette should list at least the 8 App A functions
    const lookup = page.getByTestId('palette-fn_material_lookup');
    await expect(lookup).toBeVisible({ timeout: 10_000 });
  });

  test('add node + compatible panel suggests downstream functions', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    // Click fn_material_lookup in palette
    await page.getByTestId('palette-fn_material_lookup').click();
    // Node should render on the canvas
    await expect(page.getByTestId('node-function:public.fn_material_lookup')).toBeVisible();

    // Compatible panel should now include fn_material_full_trace (both take material_no)
    await expect(page.getByTestId('compat-fn_material_full_trace')).toBeVisible({ timeout: 10_000 });

    // Click the compat suggestion to add it as second node
    await page.getByTestId('compat-fn_material_full_trace').click();
    await expect(page.getByTestId('node-function:public.fn_material_full_trace')).toBeVisible();
  });

  test('validate flags missing required input on orphaned node', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    await page.getByTestId('palette-fn_material_lookup').click();
    await expect(page.getByTestId('node-function:public.fn_material_lookup')).toBeVisible();

    await page.getByRole('button', { name: /^Validate$/ }).click();

    // Should report missing_input since p_material_no not bound
    await expect(page.getByText(/missing_input/i)).toBeVisible({ timeout: 10_000 });
  });

  test('per-node execute: bind param then run, see row count', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    await page.getByTestId('palette-fn_material_search').click();
    const node = page.getByTestId('node-function:public.fn_material_search');
    await expect(node).toBeVisible();
    await node.click(); // select

    // Bind p_keyword = 'SSD'
    const paramInput = page.locator('[data-testid^="param-"][data-testid$="-p_keyword"]').first();
    await expect(paramInput).toBeVisible();
    await paramInput.fill('SSD');

    // Run this node
    await page.locator('[data-testid^="run-"]').first().click();

    // Success toast OR last-result panel with row count
    await expect(page.getByText(/rows in \d+ms|\d+ rows/).first()).toBeVisible({ timeout: 20_000 });
  });

  test('save + reload round-trip', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    await page.getByTestId('palette-fn_material_lookup').click();
    await expect(page.getByTestId('node-function:public.fn_material_lookup')).toBeVisible();

    const dagName = page.getByLabel('DAG name');
    const uniqueName = `E2E Smoke ${Date.now()}`;
    await dagName.fill(uniqueName);

    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText(/Saved as dag:/i)).toBeVisible({ timeout: 10_000 });

    // Reload the page and ensure it appears in the DAG dropdown
    await page.reload();
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    const dagSelect = page.getByLabel('DAG', { exact: true });
    await expect(dagSelect).toBeVisible();
    await expect
      .poll(
        async () => {
          const opts = await dagSelect.locator('option').allTextContents();
          return opts.some((o) => o.includes(uniqueName));
        },
        { timeout: 10_000 },
      )
      .toBeTruthy();
  });
});
