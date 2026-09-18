import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
test('operator connects, reviews, confirms, migrates and downloads evidence', async ({ page }) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  await expect(page.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  for (const side of ['source', 'destination']) {
    await page
      .getByLabel(`mailbox-1 ${side} host`, { exact: true })
      .fill(side === 'source' ? 'old.example' : 'new.example');
    await page
      .getByLabel(`mailbox-1 ${side} username`, { exact: true })
      .fill('synthetic@business.example');
    await page.getByLabel(`mailbox-1 ${side} password`, { exact: true }).fill('synthetic-only');
  }
  await page.getByRole('button', { name: 'Test both connections' }).click();
  await expect(
    page.getByText('mailbox-1 · source: TLS, authentication and folder access passed'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Discover folders & build plan' }).click();
  await expect(
    page.getByRole('cell', { name: 'Clients/日本語', exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  await page
    .getByLabel('I reviewed this plan’s accounts, folders and scope.', { exact: false })
    .check();
  await page.getByRole('button', { name: 'Start migration', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'content complete for recorded scope' }),
  ).toBeVisible({ timeout: 15000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download private report' }).click();
  await expect((await download).suggestedFilename()).toBe('migration-report.json');
  await page.screenshot({ path: 'test-results/workflow.png', fullPage: true });
});
