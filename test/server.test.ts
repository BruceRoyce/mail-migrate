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
    assert.equal(res.statusCode, 200, res.body);
    const p = res.json();
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
