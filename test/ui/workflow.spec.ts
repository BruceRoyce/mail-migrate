import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('folder edits automatically rebuild from the snapshot without discovery or connection tests', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  const connect = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '1. Test your connections' }) });
  const review = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '2. Review the migration plan' }) });
  await expect(connect.getByText('Folder policy', { exact: false })).toHaveCount(0);
  await expect(review.getByText('Folder policy · mailbox-1', { exact: true })).toBeVisible();
  let tests = 0,
    discoveries = 0,
    replans = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/test')) tests++;
    if (r.url().endsWith('/api/plan')) discoveries++;
    if (r.url().endsWith('/api/replan')) replans++;
  });
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
  const discover = page.getByRole('button', { name: 'Discover folders & build plan', exact: true });
  await discover.click();
  const inbox = page.getByRole('checkbox', { name: 'Include mailbox-1 INBOX', exact: true });
  const clients = page.getByRole('checkbox', {
    name: 'Include mailbox-1 Clients/日本語',
    exact: true,
  });
  const nonselectable = page.getByRole('checkbox', {
    name: 'Include mailbox-1 Container only',
    exact: true,
  });
  await expect(inbox).toBeChecked();
  await expect(clients).toBeChecked();
  const migrationField = page.getByLabel('Existing migration ID (resume / catch-up)', {
    exact: true,
  });
  const migrationId = await migrationField.inputValue();
  expect(migrationId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Load saved migration' })).toBeDisabled();
  await expect(nonselectable).not.toBeChecked();
  await expect(nonselectable).toBeDisabled();
  const consent = page.getByLabel('I reviewed this plan’s accounts, folders and scope.', {
    exact: false,
  });
  const start = page.getByRole('button', { name: 'Start migration', exact: true });
  await consent.check();
  await expect(start).toBeEnabled();
  await page.route(
    '**/api/replan',
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    },
    { times: 1 },
  );
  await clients.uncheck();
  const exclusions = page.getByLabel('mailbox-1 excluded folders', { exact: true });
  await expect(exclusions).toHaveValue('Clients/日本語');
  await expect(consent).not.toBeChecked();
  await expect(consent).toBeDisabled();
  await expect(start).toBeDisabled();
  // Polling must not restore approval of the old plan after a local edit.
  await page.waitForResponse((r) => r.url().endsWith('/api/session'));
  await expect(consent).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download private plan' })).toBeDisabled();
  await exclusions.fill('INBOX\nClients/日本語\n');
  await expect(inbox).not.toBeChecked();
  await inbox.check();
  await expect(exclusions).toHaveValue('Clients/日本語');

  await expect(page.getByRole('cell', { name: 'explicit_exclusion', exact: true })).toBeVisible();
  await expect(clients).not.toBeChecked();
  await expect(consent).toBeEnabled();
  await expect(migrationField).toHaveValue(migrationId);
  await expect(start).toBeDisabled();
  await page.screenshot({ path: 'test-results/folder-selection.png', fullPage: true });
  await clients.check();
  await expect(exclusions).toHaveValue('');
  await expect(consent).toBeDisabled();

  await expect(consent).toBeEnabled();
  await expect(clients).toBeChecked();
  await expect(migrationField).toHaveValue(migrationId);
  await expect(page.getByRole('cell', { name: 'explicit_exclusion', exact: true })).toHaveCount(0);
  expect(tests).toBe(1);
  expect(discoveries).toBe(1);
  expect(replans).toBeGreaterThanOrEqual(2);
  const pilotField = page.getByLabel('Pilot message limit (blank = all)', { exact: true });
  await pilotField.fill('1');
  await expect(consent).toBeEnabled();
  await expect(page.getByText('Pilot scope: at most 1 messages.', { exact: false })).toBeVisible();
  await pilotField.fill('');
  await expect(consent).toBeEnabled();
  await expect(page.getByText('Pilot scope: at most', { exact: false })).toHaveCount(0);
  expect(discoveries).toBe(1);
});

test('folder selections preserve existing exclusions and remain scoped to each mailbox pair', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  await page.getByRole('button', { name: 'Add mailbox pair' }).click();
  for (const id of ['mailbox-1', 'mailbox-2']) {
    for (const side of ['source', 'destination']) {
      await page
        .getByLabel(`${id} ${side} host`, { exact: true })
        .fill(side === 'source' ? 'old.example' : 'new.example');
      await page
        .getByLabel(`${id} ${side} username`, { exact: true })
        .fill(`${id}@business.example`);
      await page.getByLabel(`${id} ${side} password`, { exact: true }).fill('synthetic-only');
    }
  }
  await page.getByRole('button', { name: 'Test both connections' }).click();
  const first = page.getByLabel('mailbox-1 excluded folders', { exact: true });
  const second = page.getByLabel('mailbox-2 excluded folders', { exact: true });
  await expect(first).toBeEnabled();
  await first.fill('Clients/日本語');
  const discover = page.getByRole('button', { name: 'Discover folders & build plan', exact: true });
  await discover.click();
  await expect(
    page.getByRole('checkbox', { name: 'Include mailbox-1 Clients/日本語', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Include mailbox-2 Clients/日本語', exact: true }),
  ).toBeChecked();
  await page.getByRole('checkbox', { name: 'Include mailbox-2 INBOX', exact: true }).uncheck();
  await expect(first).toHaveValue('Clients/日本語');
  await expect(second).toHaveValue('INBOX');
  await expect(
    page.getByRole('checkbox', { name: 'Include mailbox-1 INBOX', exact: true }),
  ).toBeChecked();

  await expect(page.getByRole('cell', { name: 'explicit_exclusion', exact: true })).toHaveCount(2);
  const previouslyExcluded = page.getByRole('checkbox', {
    name: 'Include mailbox-1 Clients/日本語',
    exact: true,
  });
  await previouslyExcluded.check();
  await expect(page.getByText('was not inventoried.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh discovery', exact: true }).click();
  await expect(page.getByText('was not inventoried.', { exact: false })).toHaveCount(0);
  await expect(
    page.getByLabel('I reviewed this plan’s accounts, folders and scope.', { exact: false }),
  ).toBeEnabled();
});
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
  const migrationField = page.getByLabel('Existing migration ID (resume / catch-up)', {
    exact: true,
  });
  const recordedId = await migrationField.inputValue();
  await page
    .getByRole('checkbox', { name: 'Include mailbox-1 Clients/日本語', exact: true })
    .uncheck();

  await expect(
    page.getByLabel('I reviewed this plan’s accounts, folders and scope.', { exact: false }),
  ).toBeEnabled();
  await expect(migrationField).toHaveValue(recordedId);
  await page
    .getByLabel('I reviewed this plan’s accounts, folders and scope.', { exact: false })
    .check();
  await page.getByRole('button', { name: 'Resume / run catch-up', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'content complete for recorded scope' }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
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

test('recovery controls offer only actions supported by each recorded message state', async ({
  page,
}) => {
  const { token } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  const cases = [
    { state: 'permanent_failure', folder: 'Pre-copy failure' },
    { state: 'source_missing', folder: 'Missing source' },
    { state: 'retryable_failure', folder: 'Retry on resume' },
    { state: 'ambiguous', folder: 'Uncertain unlinked' },
    { state: 'ambiguous', folder: 'Uncertain linked', destination: { uid: '7', validity: '1' } },
    {
      state: 'destination_missing',
      folder: 'Missing destination',
      destination: { uid: '8', validity: '1' },
    },
    {
      state: 'identity_changed',
      folder: 'Source identity changed',
      category: 'source_uidvalidity_changed',
    },
  ];
  const report = {
    migration: '00000000-0000-4000-8000-000000000001',
    status: 'incomplete',
    unresolved: cases.length,
    occurrences: cases.length,
    verifiedBytes: 0,
    counts: {},
    items: cases.map((c, n) => ({
      ...c,
      id: String(n + 1).repeat(64),
      mailbox: 'test',
      hash: 'a'.repeat(64),
      deviations: [],
      candidates: [],
    })),
  };
  let action: Record<string, unknown> | undefined;
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { running: false, progress: [], report } }),
  );
  await page.route('**/api/resolve', (route) => {
    action = route.request().postDataJSON();
    report.items[0]!.state = 'discovered';
    return route.fulfill({ json: report });
  });
  await page.goto('/#' + token);
  for (const c of cases) {
    const row = page
      .getByRole('row')
      .filter({ has: page.locator('td:first-child').filter({ hasText: c.folder }) });
    await row.getByText('Review / resolve', { exact: true }).click();
    await expect(row.getByRole('button', { name: 'Permit a new append on resume' })).toHaveCount(
      c.folder === 'Uncertain unlinked' ? 1 : 0,
    );
    await expect(
      row.getByRole('button', { name: 'Permit retry after correcting failure' }),
    ).toHaveCount(['permanent_failure', 'source_missing'].includes(c.state) ? 1 : 0);
    if (c.state === 'identity_changed')
      await expect(row.getByRole('button', { name: 'Verify & link UID' })).toHaveCount(0);
  }
  const ambiguous = page
    .getByRole('row')
    .filter({ has: page.locator('td:first-child').filter({ hasText: 'Uncertain unlinked' }) });
  await expect(
    ambiguous.getByRole('button', { name: 'Permit a new append on resume' }),
  ).toBeDisabled();
  await ambiguous.getByRole('checkbox').check();
  await expect(
    ambiguous.getByRole('button', { name: 'Permit a new append on resume' }),
  ).toBeEnabled();
  const failed = page
    .getByRole('row')
    .filter({ has: page.locator('td:first-child').filter({ hasText: 'Pre-copy failure' }) });
  await failed.getByRole('button', { name: 'Permit retry after correcting failure' }).click();
  await expect(
    failed.getByRole('button', { name: 'Permit retry after correcting failure' }),
  ).toHaveCount(0);
  expect(action?.retryRead).toBe(true);
  expect(action?.appendAgain).toBeUndefined();
  expect(action?.acceptDuplicateRisk).toBeUndefined();
});

test('store locally exports a portable archive and imports it through the destination approval flow', async ({
  page,
}) => {
  const { token, archiveRoot } = JSON.parse(readFileSync('test/ui-session.json', 'utf8'));
  await page.goto('/#' + token);
  await page.getByRole('tab', { name: 'Store locally', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Store emails locally' })).toBeVisible();
  await expect(page.getByLabel('mailbox-1 destination host', { exact: true })).toHaveCount(0);
  await page.getByLabel('Archive source host', { exact: true }).fill('old.example');
  await page
    .getByLabel('Archive source username', { exact: true })
    .fill('synthetic@business.example');
  await page.getByLabel('Archive source password', { exact: true }).fill('synthetic-only');
  await page.getByRole('button', { name: 'Test source and list folders' }).click();
  await expect(page.getByText('Source connection passed.', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Store Container only', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('New archive folder path', { exact: true })
    .fill(join(archiveRoot, 'ui-archive'));
  await page.getByRole('button', { name: 'Download and store emails' }).click();
  await expect(page.getByText('Local archive complete', { exact: true })).toBeVisible();
  await expect(page.getByText('2 messages stored', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open in Append from local storage' }).click();
  await page.getByRole('button', { name: 'Open archive folder', exact: true }).click();
  await expect(page.getByText('Archive manifest loaded', { exact: true })).toBeVisible();
  await expect(page.getByLabel('mailbox-1 source password', { exact: true })).toHaveCount(0);
  await page.getByLabel('mailbox-1 destination host', { exact: true }).fill('new.example');
  await page
    .getByLabel('mailbox-1 destination username', { exact: true })
    .fill('archive-destination@business.example');
  await page.getByLabel('mailbox-1 destination password', { exact: true }).fill('synthetic-only');
  await page.getByRole('button', { name: 'Validate archive and test destination' }).click();
  await expect(
    page.getByText('Archive manifest and folder access passed', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Discover folders & build plan', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Include mailbox-1 Clients/日本語', exact: true }),
  ).toBeChecked();
  await expect(page.getByRole('button', { name: 'Start migration', exact: true })).toBeDisabled();
  await page
    .getByLabel('I reviewed this plan’s accounts, folders and scope.', { exact: false })
    .check();
  await page.getByRole('button', { name: 'Start migration', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'content complete for recorded scope' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/local-archive.png', fullPage: true });
});
