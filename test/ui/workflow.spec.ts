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

test('invalid browser fields show corrective guidance without exposing entered values', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  await expect(
    page.getByText('This form uses the settings entered below.', { exact: false }),
  ).toBeVisible();
  for (const side of ['source', 'destination']) {
    await page
      .getByLabel(`mailbox-1 ${side} host`, { exact: true })
      .fill(side === 'source' ? 'old.example' : 'new.example');
    await page
      .getByLabel(`mailbox-1 ${side} username`, { exact: true })
      .fill('synthetic@business.example');
    await page.getByLabel(`mailbox-1 ${side} password`, { exact: true }).fill('never-in-an-error');
  }
  await page.getByLabel('Mailbox identifier 1', { exact: true }).fill('private-id@example.invalid');
  await page.getByRole('button', { name: 'Test both connections' }).click();
  await expect(page.getByRole('alert')).toContainText('config.mailboxes[0].id');
  await expect(page.getByRole('alert')).toContainText('hyphens');
  await expect(page.getByRole('alert')).not.toContainText('never-in-an-error');
  await expect(page.getByRole('alert')).not.toContainText('private-id@example.invalid');
  await expect(page.getByRole('button', { name: 'Discover folders & build plan' })).toBeDisabled();
});

test('refresh keeps local access but never stores mailbox passwords or form data', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  await expect(page.getByRole('button', { name: 'Test both connections' })).toBeEnabled();
  await page.getByLabel('mailbox-1 source password', { exact: true }).fill('must-remain-in-memory');
  await page
    .getByLabel('mailbox-1 source username', { exact: true })
    .fill('private-user@example.invalid');
  const stored = await page.evaluate(() => ({
    session: { ...sessionStorage },
    local: { ...localStorage },
    hash: location.hash,
  }));
  expect(stored.session).toEqual({ 'mail-migrate.session-token': token });
  expect(stored.local).toEqual({});
  expect(stored.hash).toBe('');
  await page.reload();
  const response = await page.waitForResponse((r) => r.url().endsWith('/api/session'));
  expect(response.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Reconnect to the local app' })).toHaveCount(0);
  await expect(page.getByLabel('mailbox-1 source password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('mailbox-1 source username', { exact: true })).toHaveValue('');
});

test('bare address offers explicit reconnect and rejects links for a different origin', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  let mailboxRequests = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST') mailboxRequests++;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Reconnect to the local app' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test both connections' })).toBeDisabled();
  await page
    .getByLabel('Private session link from PowerShell')
    .fill('http://evil.example/#' + token);
  await page.getByRole('button', { name: 'Reconnect this tab' }).click();
  await expect(page.getByRole('alert')).toContainText('this address and port');
  await page
    .getByLabel('Private session link from PowerShell')
    .fill('http://127.0.0.1:8788/#' + token);
  await page.getByRole('button', { name: 'Reconnect this tab' }).click();
  await expect(page.getByRole('heading', { name: 'Reconnect to the local app' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test both connections' })).toBeEnabled();
  expect(mailboxRequests).toBe(0);
});

test('rejected session can reconnect without losing form entries or testing mailboxes', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  await page
    .getByLabel('mailbox-1 source username', { exact: true })
    .fill('keep-this-user@example.invalid');
  await page
    .getByLabel('mailbox-1 source password', { exact: true })
    .fill('keep-this-password-in-memory');
  await page.route(
    '**/api/session',
    (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'session_rejected' }),
      }),
    { times: 1 },
  );
  await expect(page.getByRole('heading', { name: 'Reconnect to the local app' })).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('mail-migrate.session-token')),
  ).toBeNull();
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST') posts++;
  });
  await page
    .getByLabel('Private session link from PowerShell')
    .fill('http://127.0.0.1:8788/#' + token);
  await page.getByRole('button', { name: 'Reconnect this tab' }).click();
  await expect(page.getByRole('heading', { name: 'Reconnect to the local app' })).toHaveCount(0);
  await expect(page.getByLabel('mailbox-1 source username', { exact: true })).toHaveValue(
    'keep-this-user@example.invalid',
  );
  await expect(page.getByLabel('mailbox-1 source password', { exact: true })).toHaveValue(
    'keep-this-password-in-memory',
  );
  await expect(page.getByRole('button', { name: 'Discover folders & build plan' })).toBeDisabled();
  expect(posts).toBe(0);
});

test('an expired link is rejected and a new same-page fragment restores access', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + '0'.repeat(64));
  await expect(page.getByRole('heading', { name: 'Reconnect to the local app' })).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('mail-migrate.session-token')),
  ).toBeNull();
  await page.evaluate((value) => {
    location.hash = value;
  }, token);
  await expect(page.getByRole('heading', { name: 'Reconnect to the local app' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test both connections' })).toBeEnabled();
  expect(await page.evaluate(() => location.hash)).toBe('');
});

test('slow discovery shows inline progress, can cancel, and allows another plan attempt', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  for (const side of ['source', 'destination']) {
    await page
      .getByLabel(`mailbox-1 ${side} host`, { exact: true })
      .fill(side === 'source' ? 'old.example' : 'new.example');
    await page
      .getByLabel(`mailbox-1 ${side} username`, { exact: true })
      .fill(side === 'source' ? 'slow@business.example' : 'synthetic@business.example');
    await page.getByLabel(`mailbox-1 ${side} password`, { exact: true }).fill('synthetic-only');
  }
  await page.getByRole('button', { name: 'Test both connections' }).click();
  await expect(
    page.getByText('mailbox-1 · source: TLS, authentication and folder access passed'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Discover folders & build plan' }).click();
  await expect(page.getByRole('button', { name: 'Discovering folders…' })).toBeVisible();
  await expect(page.getByText('Reading message metadata', { exact: true })).toBeVisible();
  await expect(page.getByText('Current folder: 0 / 1 messages')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Folders scanned' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/discovery-progress.png', fullPage: true });
  await page.getByRole('button', { name: 'Cancel discovery', exact: true }).click();
  await expect(page.getByText('Discovery cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discover folders & build plan' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  await page
    .getByLabel('mailbox-1 source username', { exact: true })
    .fill('synthetic@business.example');
  await page.getByRole('button', { name: 'Test both connections' }).click();
  await expect(page.getByRole('button', { name: 'Discover folders & build plan' })).toBeEnabled();
  await page.getByRole('button', { name: 'Discover folders & build plan' }).click();
  await expect(page.getByText('Discovery complete', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Clients/日本語', exact: true }).first(),
  ).toBeVisible();
});

test('inventory limit produces a visible discovery error with no partial plan to approve', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  for (const side of ['source', 'destination']) {
    await page
      .getByLabel(`mailbox-1 ${side} host`, { exact: true })
      .fill(side === 'source' ? 'old.example' : 'new.example');
    await page
      .getByLabel(`mailbox-1 ${side} username`, { exact: true })
      .fill('synthetic@business.example');
    await page.getByLabel(`mailbox-1 ${side} password`, { exact: true }).fill('synthetic-only');
  }
  await page.getByLabel('Inventory occurrence ceiling', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Test both connections' }).click();
  await expect(page.getByRole('button', { name: 'Discover folders & build plan' })).toBeEnabled();
  await page.getByRole('button', { name: 'Discover folders & build plan' }).click();
  await expect(page.getByText('Discovery failed', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('inventory exceeds');
  await expect(page.getByRole('button', { name: 'Discover folders & build plan' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download private plan' })).toHaveCount(0);
});
