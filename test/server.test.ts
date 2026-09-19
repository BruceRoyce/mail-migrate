import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeb } from '../src/server.js';
import { fixture, Mailbox } from './fake.js';
import type { Plan } from '../src/model.js';
const payload = () => ({
  mailboxes: [
    {
      id: 'test',
      source: {
        host: 'old.example',
        port: 993,
        tlsMode: 'implicit',
        username: 'a@business.example',
        password: 'private-source',
      },
      destination: {
        host: 'new.example',
        port: 993,
        tlsMode: 'implicit',
        username: 'a@business.example',
        password: 'private-destination',
      },
      folders: { exclude: [], overrides: {}, labelStrategy: 'unresolved' },
    },
  ],
  maxMessageMiB: 25,
  memoryBudgetMiB: 512,
});
test('local replan uses the retained snapshot without any IMAP operations and invalidates old approvals', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  let adapters = 0;
  const web = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, (...args) => {
    adapters++;
    return f.factory(...args);
  });
  const headers = { host: '127.0.0.1:8787', 'x-session-token': web.token };
  const post = (path: string, payload: object) =>
    web.app.inject({ url: '/api/' + path, method: 'POST', headers, payload });
  const state = async () => (await web.app.inject({ url: '/api/session', headers })).json();
  try {
    await post('test', payload());
    await post('plan', { pilot: 1 });
    for (let i = 0; i < 100 && web.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    const original = await state();
    const requests = adapters;
    const policies = [
      { id: 'test', folders: { exclude: ['INBOX'], overrides: {}, labelStrategy: 'unresolved' } },
    ];
    const changed = await post('replan', {
      snapshotId: original.snapshot.id,
      folderPolicies: policies,
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().plan.migration, original.plan.migration);
    assert.notEqual(changed.json().plan.hash, original.plan.hash);
    assert.equal(changed.json().plan.pairs[0].mappings[0].excluded, 'explicit_exclusion');
    assert.equal(
      (await post('run', { hash: original.plan.hash, confirm: true })).json().error,
      'confirmation_hash_mismatch',
    );
    policies[0]!.folders.exclude = [];
    const restored = await post('replan', {
      snapshotId: original.snapshot.id,
      folderPolicies: policies,
    });
    assert.equal(restored.json().plan.pairs[0].mappings[0].messages.length, 1);
    assert.equal(adapters, requests);
    assert.equal(f.destination.writes.length, 0);
    await post('test', payload());
    const stale = await post('replan', {
      snapshotId: original.snapshot.id,
      folderPolicies: policies,
    });
    assert.equal(stale.json().error, 'refresh_discovery_required');
    assert.equal((await state()).plan, undefined);
  } finally {
    await web.app.close();
  }
});
test('review policies rebuild the approved scope without retesting or changing credentials', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const archive = new Mailbox();
  archive.add();
  f.source.folders.set('Archive/日本語', archive);
  const scanned: string[] = [];
  const w = await createWeb(
    8787,
    f.c.stateDirectory,
    f.c.reportDirectory,
    (e, secret, writable, c) => {
      assert.equal(secret, e.host === 'old.example' ? 'private-source' : 'private-destination');
      const reader = f.factory(e, secret, writable, c);
      const open = reader.open.bind(reader);
      reader.open = async (path) => {
        if (e.host === 'old.example') scanned.push(path);
        return open(path);
      };
      return reader;
    },
  );
  const headers = { host: '127.0.0.1:8787', 'x-session-token': w.token };
  const post = (url: string, body: object) =>
    w.app.inject({ url: '/api/' + url, method: 'POST', headers, payload: body });
  const waitPlan = async () => {
    for (let i = 0; i < 100 && w.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.isRunning(), false);
    const state = (await w.app.inject({ url: '/api/session', headers })).json();
    assert.equal(state.discovery.status, 'complete');
    return state.plan as Plan;
  };
  try {
    assert.equal((await post('test', payload())).json().ready, true);
    assert.equal((await post('plan', {})).statusCode, 202);
    const initial = await waitPlan();
    scanned.length = 0;
    const folders = {
      exclude: ['Archive/日本語'],
      overrides: { INBOX: 'Imported' },
      labelStrategy: 'explicit-folders',
    };
    assert.equal(
      (await post('plan', { folderPolicies: [{ id: 'test', folders }] })).statusCode,
      202,
    );
    const revised = await waitPlan();
    assert.notEqual(revised.hash, initial.hash);
    assert.equal(revised.migration, initial.migration);
    assert.equal(revised.pairs[0]!.mappings[0]!.target, 'Imported');
    const excluded = revised.pairs[0]!.mappings.find((m) => m.source.path === 'Archive/日本語')!;
    assert.equal(excluded.excluded, 'explicit_exclusion');
    assert.equal(excluded.messages.length, 0);
    assert.ok(!scanned.includes('Archive/日本語'));
    assert.equal(
      (await post('run', { hash: initial.hash, confirm: true })).json().error,
      'confirmation_hash_mismatch',
    );
    assert.equal(f.destination.writes.length, 0);
    // Only the newly reviewed scope can write, using the original in-memory credentials.
    assert.equal((await post('run', { hash: revised.hash, confirm: true })).statusCode, 200);
    for (let i = 0; i < 100 && w.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(f.destination.folders.has('Imported'));
    assert.ok(!f.destination.folders.has('Archive/日本語'));
    const loaded = await post('load', {
      migration: revised.migration,
      folderPolicies: [{ id: 'test', folders }],
    });
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.json().report.exclusions[0].reason, 'explicit_exclusion');
    // Re-inclusion re-inventories the folder, still without another connection test.
    assert.equal(
      (
        await post('plan', {
          folderPolicies: [{ id: 'test', folders: { ...folders, exclude: [] } }],
        })
      ).statusCode,
      202,
    );
    const included = await waitPlan();
    assert.equal(included.migration, revised.migration);
    assert.equal(included.pairs[0]!.mappings[1]!.excluded, undefined);
    assert.equal(included.pairs[0]!.mappings[1]!.messages.length, 1);
    assert.equal(
      (await post('run', { hash: included.hash, confirm: true, mode: 'resume' })).statusCode,
      200,
    );
    for (let i = 0; i < 100 && w.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    const resumed = (await w.app.inject({ url: '/api/session', headers })).json();
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.recordedMigrationId, initial.migration);
    assert.equal(resumed.report.counts.verified, 2);
    assert.equal(f.destination.folders.get('Imported')!.messages.size, 1);
    assert.equal(f.destination.folders.get('Archive/日本語')!.messages.size, 1);
    for (const bad of [
      [],
      [{ id: 'unknown', folders }],
      [
        { id: 'test', folders },
        { id: 'test', folders },
      ],
    ]) {
      assert.equal(
        (await post('plan', { folderPolicies: bad })).json().error,
        'folder_policy_mailboxes_mismatch',
      );
    }
    assert.equal(
      (
        await post('plan', {
          folderPolicies: [{ id: 'test', folders: { ...folders, exclude: ['bad\u0000name'] } }],
        })
      ).json().error,
      'invalid_configuration',
    );
    assert.equal(
      (
        await post('plan', {
          folderPolicies: [{ id: 'test', folders, source: { host: 'other.example' } }],
        })
      ).statusCode,
      400,
    );
  } finally {
    await w.app.close();
  }
});

test('backend restart restores the ledger migration ID and rejects an unrelated ID before discovery', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  let web = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, f.factory);
  const headers = () => ({ host: '127.0.0.1:8787', 'x-session-token': web.token });
  const post = (path: string, body: object) =>
    web.app.inject({ url: '/api/' + path, method: 'POST', headers: headers(), payload: body });
  const state = () =>
    web.app.inject({ url: '/api/session', headers: headers() }).then((r) => r.json());
  const settled = async () => {
    for (let i = 0; i < 100 && web.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(web.isRunning(), false);
    return state();
  };
  try {
    await post('test', payload());
    await post('plan', {});
    const initial = (await settled()).plan as Plan;
    await post('run', { hash: initial.hash, confirm: true });
    assert.equal((await settled()).report.counts.verified, 1);
    await web.app.close();
    web = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, f.factory);
    assert.equal((await state()).migrationId, initial.migration);
    const tested = await post('test', payload());
    assert.equal(tested.json().recordedMigrationId, initial.migration);
    const bad = await post('plan', { migration: '00000000-0000-4000-8000-000000000001' });
    assert.equal(bad.json().error, 'migration_id_does_not_match_state_directory');
    assert.equal((await state()).discovery, undefined);
    // Even a blank ID from an older browser reuses the recorded migration.
    assert.equal((await post('plan', {})).statusCode, 202);
    const rebuilt = (await settled()).plan as Plan;
    assert.equal(rebuilt.migration, initial.migration);
    assert.equal(
      (await post('run', { hash: rebuilt.hash, confirm: true, mode: 'resume' })).statusCode,
      200,
    );
    assert.equal((await settled()).report.counts.verified, 1);
    assert.equal(f.destination.folders.get('INBOX')!.messages.size, 1);
  } finally {
    await web.app.close();
  }
});
test('UI requires session, origin, valid connections, plan hash and explicit confirmation', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const w = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, f.factory);
  const headers = {
    host: '127.0.0.1:8787',
    'x-session-token': w.token,
    origin: 'http://127.0.0.1:8787',
  };
  try {
    assert.equal(
      (await w.app.inject({ url: '/api/session', headers: { host: headers.host } })).statusCode,
      403,
    );
    assert.equal(
      (
        await w.app.inject({
          url: '/api/session',
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await w.app.inject({ url: '/api/session', headers: { ...headers, host: 'evil.example' } }))
        .statusCode,
      403,
    );
    let res = await w.app.inject({ url: '/api/test', method: 'POST', headers, payload: payload() });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ready, true);
    assert.ok(!res.body.includes('private-source'));
    res = await w.app.inject({ url: '/api/plan', method: 'POST', headers, payload: {} });
    assert.equal(res.statusCode, 202, res.body);
    while (w.isRunning()) await new Promise((r) => setTimeout(r, 10));
    const p = (await w.app.inject({ url: '/api/session', headers })).json().plan;
    assert.equal(f.destination.writes.length, 0);
    assert.ok(!res.body.includes('private-destination'));
    for (const input of [{ hash: p.hash }, { hash: 'wrong', confirm: true }]) {
      res = await w.app.inject({ url: '/api/run', method: 'POST', headers, payload: input });
      assert.ok(res.statusCode >= 400);
    }
    assert.equal(f.destination.writes.length, 0);
    res = await w.app.inject({
      url: '/api/run',
      method: 'POST',
      headers,
      payload: { hash: p.hash, confirm: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    while (w.isRunning()) await new Promise((r) => setTimeout(r, 10));
    const session = (await w.app.inject({ url: '/api/session', headers })).json();
    assert.equal(session.report.counts.verified, 1);
    assert.ok(!JSON.stringify(session).includes('private-source'));
  } finally {
    await w.app.close();
  }
});
test('failed auth cannot progress from the connection screen', async () => {
  const f = fixture();
  f.destination.connectError = 'authentication';
  const w = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, f.factory);
  const headers = { host: '127.0.0.1:8787', 'x-session-token': w.token };
  try {
    const res = await w.app.inject({
      url: '/api/test',
      method: 'POST',
      headers,
      payload: payload(),
    });
    assert.equal(res.json().ready, false);
    assert.equal(
      (await w.app.inject({ url: '/api/plan', method: 'POST', headers, payload: {} })).statusCode,
      400,
    );
    assert.equal(f.destination.writes.length, 0);
  } finally {
    await w.app.close();
  }
});

test('browser validation returns field-level guidance before any connection is attempted', async () => {
  const f = fixture();
  let calls = 0;
  const w = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, (...args) => {
    calls++;
    return f.factory(...args);
  });
  const headers = { host: '127.0.0.1:8787', 'x-session-token': w.token };
  try {
    const body = payload();
    body.mailboxes[0]!.id = 'support@private.example';
    const response = await w.app.inject({
      url: '/api/test',
      method: 'POST',
      headers,
      payload: body,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_configuration');
    assert.equal(response.json().issues[0].path, 'config.mailboxes[0].id');
    assert.match(response.json().issues[0].message, /hyphens/);
    assert.doesNotMatch(response.body, /private-source|private-destination|support@private/);
    assert.equal(calls, 0);
  } finally {
    await w.app.close();
  }
});

test('backend restart invalidates old tokens and preserves origin checks for new tokens', async () => {
  const f = fixture();
  const old = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, f.factory);
  const previousToken = old.token;
  await old.app.close();
  const current = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, f.factory);
  try {
    assert.notEqual(previousToken, current.token);
    for (const headers of [
      { host: '127.0.0.1:8787', 'x-session-token': previousToken },
      { host: '127.0.0.1:8787', 'x-session-token': current.token, origin: 'https://evil.example' },
      { host: '127.0.0.1:8787', cookie: 'mail-migrate.session-token=' + current.token },
    ])
      assert.equal((await current.app.inject({ url: '/api/session', headers })).statusCode, 403);
    const response = await current.app.inject({
      url: '/api/session',
      headers: {
        host: '127.0.0.1:8787',
        'x-session-token': current.token,
        origin: 'http://127.0.0.1:8787',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes(current.token));
    assert.equal(f.destination.writes.length, 0);
  } finally {
    await current.app.close();
  }
});

test('discovery returns immediately, publishes progress, rejects overlap and cancels a stalled read', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  let stalled = false,
    closes = 0;
  const factory: typeof f.factory = (e, s, w, c) => {
    const reader = f.factory(e, s, w, c);
    const open = reader.open.bind(reader);
    reader.open = async (folder) => {
      if (stalled) return new Promise(() => {});
      return open(folder);
    };
    reader.close = async () => {
      closes++;
    };
    return reader;
  };
  const web = await createWeb(8787, f.c.stateDirectory, f.c.reportDirectory, factory),
    headers = { host: '127.0.0.1:8787', 'x-session-token': web.token };
  try {
    assert.equal(
      (
        await web.app.inject({ url: '/api/test', method: 'POST', headers, payload: payload() })
      ).json().ready,
      true,
    );
    stalled = true;
    const start = await web.app.inject({ url: '/api/plan', method: 'POST', headers, payload: {} });
    assert.equal(start.statusCode, 202);
    assert.equal(start.json().discovery.status, 'running');
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await web.app.inject({ url: '/api/session', headers })).json();
      if (state.discovery.phase === 'opening_folder') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(state.discovery.phase, 'opening_folder');
    assert.equal(state.discovery.folder, 'INBOX');
    assert.equal(state.plan, undefined);
    assert.equal(
      (await web.app.inject({ url: '/api/plan', method: 'POST', headers, payload: {} })).json()
        .error,
      'discovery_running',
    );
    await web.app.inject({ url: '/api/cancel', method: 'POST', headers, payload: {} });
    for (let i = 0; i < 100 && web.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    state = (await web.app.inject({ url: '/api/session', headers })).json();
    assert.equal(state.discovery.status, 'cancelled');
    assert.equal(state.plan, undefined);
    assert.ok(closes >= 4);
    assert.equal(f.destination.writes.length, 0);
    stalled = false;
    assert.equal(
      (await web.app.inject({ url: '/api/plan', method: 'POST', headers, payload: {} })).statusCode,
      202,
    );
    for (let i = 0; i < 100 && web.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    state = (await web.app.inject({ url: '/api/session', headers })).json();
    assert.equal(state.discovery.status, 'complete');
    assert.ok(state.plan);
    assert.equal(state.discovery.messages, 1);
  } finally {
    web.cancel();
    await web.app.close();
  }
});
