import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeb } from '../src/server.js';
import { fixture } from './fake.js';
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
