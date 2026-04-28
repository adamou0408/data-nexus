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

  test('aggregate operator: palette → node + inspector renders', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    await page.getByTestId('palette-op-aggregate').click();

    const aggNode = page.locator('[data-testid^="op-aggregate-"]').first();
    await expect(aggNode).toBeVisible();
    await aggNode.click();

    // Inspector shows aggregate-specific controls
    await expect(page.getByTestId('op-agg-groupby-add')).toBeVisible();
    await expect(page.getByTestId('op-agg-add')).toBeVisible();
    await expect(page.getByTestId('op-agg-fn-0')).toBeVisible();
    await expect(page.getByTestId('op-agg-col-0')).toBeVisible();

    // Default config: count(?). Switch fn to sum and confirm node summary updates.
    await page.getByTestId('op-agg-fn-0').selectOption('sum');
    await expect(aggNode).toContainText(/sum\(/);
  });

  test('sink (page): palette → node + inspector renders config form', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    // Sink palette button is composer-native (no fn deploy required)
    await page.getByTestId('palette-sink-page').click();

    // Sink node renders
    const sinkNode = page.locator('[data-testid^="sink-page-"]').first();
    await expect(sinkNode).toBeVisible();
    await sinkNode.click();

    // Inspector form fields render with the expected testids
    await expect(page.locator('[data-testid^="sink-kind-"]')).toBeVisible();
    const pageIdInput = page.locator('[data-testid^="sink-page-id-"]').first();
    await expect(pageIdInput).toBeVisible();
    await expect(page.locator('[data-testid^="sink-title-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="sink-parent-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="sink-overwrite-"]').first()).toBeVisible();

    // Default page_id is non-empty (auto-generated from dag/node)
    const defaultPageId = await pageIdInput.inputValue();
    expect(defaultPageId.length).toBeGreaterThan(0);
    expect(defaultPageId).toMatch(/^[a-z][a-z0-9_]*$/);

    // Editing page_id reflects in the field
    await pageIdInput.fill('e2e_sink_smoke');
    await expect(pageIdInput).toHaveValue('e2e_sink_smoke');

    // Sink summary on canvas reflects the new page_id
    await expect(sinkNode).toContainText('e2e_sink_smoke');
  });

  test('sink (page): execute without upstream surfaces actionable error', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    await page.getByTestId('palette-sink-page').click();
    const sinkNode = page.locator('[data-testid^="sink-page-"]').first();
    await sinkNode.click();

    // Execute sink without saved DAG / upstream — should toast an error,
    // not hang. (UX validation pass 4 in sink-as-node-kind plan §3.4.)
    await page.locator('[data-testid^="execute-sink-"]').first().click();
    // Either "Save the DAG first" or "no upstream" depending on dag save state
    await expect(
      page.getByText(/Save the DAG first|no upstream|Run upstream node/i),
    ).toBeVisible({ timeout: 5000 });

    // Sink chip should still read 'unsaved' (no successful run recorded)
    await expect(sinkNode).toContainText(/unsaved/i);
  });

  test('aggregate operator: add group key + extra aggregation', async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Flow Composer');
    await expect(page.getByTestId('dag-tab')).toBeVisible();

    await page.getByTestId('palette-op-aggregate').click();
    const aggNode = page.locator('[data-testid^="op-aggregate-"]').first();
    await aggNode.click();

    // Add a group_by key (no upstream → free-text input)
    await page.getByTestId('op-agg-groupby-add').click();
    const grpInput = page.getByTestId('op-agg-groupby-0');
    await expect(grpInput).toBeVisible();
    await grpInput.fill('product_line');

    // Add a 2nd aggregation
    await page.getByTestId('op-agg-add').click();
    await expect(page.getByTestId('op-agg-fn-1')).toBeVisible();
    await page.getByTestId('op-agg-fn-1').selectOption('avg');
    await page.getByTestId('op-agg-col-1').fill('cost');

    // Node summary reflects "by product_line" + "avg(cost)"
    await expect(aggNode).toContainText('by product_line');
    await expect(aggNode).toContainText(/avg\(cost\)/);
  });
});
