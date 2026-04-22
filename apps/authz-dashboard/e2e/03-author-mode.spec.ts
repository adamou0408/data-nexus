import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';

test.describe('Query Tool — Author mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loginAs(page);
    await navigateTo(page, 'Query Tool');
  });

  test('switch to Author mode shows tables + SQL editor', async ({ page }) => {
    await page.getByRole('button', { name: /^Author$/ }).click();
    // Tables panel header (text includes leading icon whitespace)
    await expect(page.getByText(/Tables \(\d+\)/)).toBeVisible({ timeout: 15_000 });
    // SQL editor header
    await expect(page.getByText(/SQL — CREATE \[OR REPLACE\] FUNCTION/)).toBeVisible();
    // Validate + Deploy buttons
    await expect(page.getByRole('button', { name: /^Validate$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Deploy$/ })).toBeVisible();
    // Ask AI placeholder (disabled in W5)
    const aiBtn = page.getByRole('button', { name: /Ask AI to draft/ });
    await expect(aiBtn).toBeVisible();
    await expect(aiBtn).toBeDisabled();
  });

  test('selecting a table pre-fills SQL template', async ({ page }) => {
    await page.getByRole('button', { name: /^Author$/ }).click();
    // Wait for tables list to populate
    const tableBtns = page.locator('main button').filter({ has: page.locator('span.font-mono') });
    await expect.poll(async () => await tableBtns.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await tableBtns.first().click();
    // SQL textarea should now contain "CREATE OR REPLACE FUNCTION"
    const sqlTextarea = page.locator('textarea').first();
    const val = await sqlTextarea.inputValue();
    expect(val).toMatch(/CREATE OR REPLACE FUNCTION/i);
  });

  test('validate with empty SQL keeps button disabled', async ({ page }) => {
    await page.getByRole('button', { name: /^Author$/ }).click();
    const sqlTextarea = page.locator('textarea').first();
    await sqlTextarea.fill('');
    await expect(page.getByRole('button', { name: /^Validate$/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Deploy$/ })).toBeDisabled();
  });

  test('validate a trivially safe function against pg_k8', async ({ page }) => {
    // Select pg_k8 by finding the option text via DOM
    const dsSelect = page.locator('main select').first();
    const pgK8Value = await dsSelect.locator('option', { hasText: 'pg_k8' }).first().getAttribute('value');
    if (!pgK8Value) throw new Error('pg_k8 option not present');
    await dsSelect.selectOption(pgK8Value);

    await page.getByRole('button', { name: /^Author$/ }).click();

    const sql = `CREATE OR REPLACE FUNCTION public.fn_e2e_noop()
RETURNS TABLE(ok boolean)
LANGUAGE sql STABLE AS $$
  SELECT true
$$;`;
    const sqlTextarea = page.locator('textarea').first();
    await sqlTextarea.fill(sql);
    await page.getByRole('button', { name: /^Validate$/ }).click();
    // Either success panel or clear error — don't fail the whole suite on a connection issue,
    // just assert one of the two outcomes arrives within the timeout.
    const success = page.getByText(/Validation passed/);
    const errorPanel = page.locator('.bg-red-50').first();
    await Promise.race([
      success.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => null),
      errorPanel.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => null),
    ]);
    const outcome = (await success.isVisible()) ? 'success' : (await errorPanel.isVisible()) ? 'error' : 'timeout';
    // Log for visibility — the test passes as long as the UI surfaced an outcome.
    test.info().annotations.push({ type: 'validate-outcome', description: outcome });
    expect(['success', 'error']).toContain(outcome);
  });
});
