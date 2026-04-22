import { test, expect } from '@playwright/test';
import { loginAs, navigateTo } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * App A deployment smoke — reads each SQL draft in
 *   database/functions/pg_k8/app_a_material_360/
 * and runs Validate against pg_k8. Deploy is behind
 *   APP_A_DEPLOY=1 env to avoid mutating pg_k8 by default.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APP_A_DIR = path.join(REPO_ROOT, 'database/functions/pg_k8/app_a_material_360');

function loadSqlFiles(): { name: string; sql: string }[] {
  if (!fs.existsSync(APP_A_DIR)) return [];
  return fs
    .readdirSync(APP_A_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: fs.readFileSync(path.join(APP_A_DIR, f), 'utf8') }));
}

test.describe('App A — Material 360° SQL drafts', () => {
  const files = loadSqlFiles();

  test('drafts directory is populated', () => {
    expect(files.length, `No .sql files in ${APP_A_DIR}`).toBeGreaterThanOrEqual(8);
  });

  for (const f of files) {
    test(`validate ${f.name}`, async ({ page }) => {
      await page.goto('/');
      await loginAs(page);
      await navigateTo(page, 'Query Tool');
      const dsSelect = page.locator('main select').first();
      const pgK8Value = await dsSelect.locator('option', { hasText: 'pg_k8' }).first().getAttribute('value');
      if (!pgK8Value) throw new Error('pg_k8 option not present');
      await dsSelect.selectOption(pgK8Value);
      await page.getByRole('button', { name: /^Author$/ }).click();

      const sqlTextarea = page.locator('textarea').first();
      await sqlTextarea.fill(f.sql);

      await page.getByRole('button', { name: /^Validate$/ }).click();
      const success = page.getByText(/Validation passed/);
      const errorPanel = page.locator('.bg-red-50').first();
      await Promise.race([
        success.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => null),
        errorPanel.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => null),
      ]);

      if (await errorPanel.isVisible()) {
        const msg = await errorPanel.innerText();
        test.info().annotations.push({ type: 'validate-error', description: `${f.name}: ${msg.slice(0, 400)}` });
      }
      // Drafts have been verified against pg_k8; require success.
      await expect(success, `Validate failed for ${f.name}`).toBeVisible();
    });
  }
});
