import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, raw, Mailbox, FakeReader, FakeWriter, Server } from './fake.js';
import { makePlan, mappings, checkPlan } from '../src/plan.js';
import { execute, report, resolveItem } from '../src/engine.js';
import { Store, lock, unlock } from '../src/store.js';
import { fingerprint, validateConfig } from '../src/config.js';
import { category, Fault } from '../src/safety.js';
import type { Item } from '../src/model.js';
async function prepared() {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const p = await makePlan(f.c, f.values, f.factory);
  mkdirSync(f.c.stateDirectory);
  const store = new Store(f.c.stateDirectory, true);
  return { ...f, p, store };
}
test('raw content, intentional duplicates, existing mail, rerun and source immutability', async () => {
  const f = fixture();
  const inbox = f.source.folders.get('INBOX')!;
  inbox.add(raw, ['\\Seen', '\\Deleted', 'project']);
  inbox.add(raw);
  f.destination.folders.get('INBOX')!.add(Buffer.from('unrelated'));
  const before = JSON.stringify([...inbox.messages]);
  const p = await makePlan(f.c, f.values, f.factory);
  mkdirSync(f.c.stateDirectory);
  const store = new Store(f.c.stateDirectory, true);
  try {
    let r = await execute(f.c, f.values, f.factory, store, p);
    assert.equal(r.counts.verified, 2);
    assert.equal(r.status, 'content_complete_with_metadata_deviations');
    assert.equal(f.destination.folders.get('INBOX')!.messages.size, 3);
    assert.equal(new Set(r.items.map((i) => i.evidence?.uid)).size, 2);
    r = await execute(f.c, f.values, f.factory, store, p, { existing: true });
    assert.equal(r.lastPass?.skipped, 2);
    assert.equal(f.destination.writes.length, 2);
    assert.equal(JSON.stringify([...inbox.messages]), before);
  } finally {
    store.close();
  }
});
for (const fault of ['before', 'after', 'no_uid'] as const)
  test(`${fault}: uncertain APPEND is not automatically retried`, async () => {
    const f = await prepared();
    try {
      f.destination.fault = fault;
      await execute(f.c, f.values, f.factory, f.store, f.p);
      f.destination.fault = undefined;
      const r = await execute(f.c, f.values, f.factory, f.store, f.p, { existing: true });
      assert.equal(f.destination.writes.length, 1);
      assert.equal(r.counts.ambiguous, 1);
      assert.equal(r.status, 'incomplete');
      assert.equal(r.items[0]!.candidates?.length, fault === 'before' ? 0 : 1);
      if (fault !== 'before') {
        await resolveItem(f.c, f.values, f.factory, f.store, f.p.migration, r.items[0]!.id, {
          link: '1',
        });
        assert.equal(f.store.items(f.p.migration)[0]!.state, 'verified');
      } else {
        await resolveItem(f.c, f.values, f.factory, f.store, f.p.migration, r.items[0]!.id, {
          appendAgain: true,
        });
        const next = await execute(f.c, f.values, f.factory, f.store, f.p, { existing: true });
        assert.equal(next.counts.verified, 1);
        assert.equal(f.destination.writes.length, 2);
      }
    } finally {
      f.store.close();
    }
  });
test('crash after server commit with durable pending intent recovers as ambiguous', async () => {
  const f = await prepared();
  try {
    f.store.begin(f.p);
    const item = f.store.items(f.p.migration)[0]!;
    const { hash } = await import('../src/safety.js');
    item.hash = hash(raw);
    item.baseline = {
      validity: f.destination.folders.get('INBOX')!.validity,
      next: '1',
      count: 0,
      flags: [],
    };
    f.store.save(item, 'prepared');
    f.store.intent(item);
    f.destination.folders.get('INBOX')!.add();
    const r = await execute(f.c, f.values, f.factory, f.store, f.p, { existing: true });
    assert.equal(r.counts.ambiguous, 1);
    assert.equal(f.destination.writes.length, 0);
  } finally {
    f.store.close();
  }
});
test('fresh verify detects destination removal and makes zero writes', async () => {
  const f = await prepared();
  try {
    await execute(f.c, f.values, f.factory, f.store, f.p);
    f.destination.folders.get('INBOX')!.messages.clear();
    const writes = f.destination.writes.length;
    const r = await execute(f.c, f.values, f.factory, f.store, f.p, {
      verifyOnly: true,
      existing: true,
    });
    assert.equal(r.counts.destination_missing, 1);
    assert.equal(r.status, 'incomplete');
    assert.equal(f.destination.writes.length, writes);
  } finally {
    f.store.close();
  }
});
for (const side of ['source', 'destination'] as const)
  test(`${side} UIDVALIDITY reset rejects old assumptions`, async () => {
    const f = await prepared();
    try {
      await execute(f.c, f.values, f.factory, f.store, f.p);
      f[side].folders.get('INBOX')!.validity = '9007199254740994';
      const r = await execute(f.c, f.values, f.factory, f.store, f.p, { existing: true });
      assert.equal(r.status, 'incomplete');
      assert.equal(r.counts.identity_changed, 1);
      assert.equal(f.destination.writes.length, 1);
    } finally {
      f.store.close();
    }
  });
test('missing source is an accountable gap', async () => {
  const f = await prepared();
  try {
    f.source.folders.get('INBOX')!.messages.clear();
    const r = await execute(f.c, f.values, f.factory, f.store, f.p);
    assert.equal(r.counts.source_missing, 1);
    assert.equal(f.destination.writes.length, 0);
  } finally {
    f.store.close();
  }
});
test('content mismatch cannot become success', async () => {
  const f = await prepared();
  try {
    f.destination.fault = 'corrupt';
    const r = await execute(f.c, f.values, f.factory, f.store, f.p);
    assert.equal(r.counts.content_mismatch, 1);
    assert.equal(r.status, 'incomplete');
    assert.equal(r.verifiedBytes, 0);
  } finally {
    f.store.close();
  }
});
test('metadata mismatch is explicit', async () => {
  const f = await prepared();
  try {
    f.destination.fault = 'date';
    const r = await execute(f.c, f.values, f.factory, f.store, f.p);
    assert.equal(r.counts.verified, 1);
    assert.equal(r.status, 'content_complete_with_metadata_deviations');
    assert.ok(r.items[0]!.deviations.includes('internal_date_changed'));
  } finally {
    f.store.close();
  }
});
test('new arrivals and international nested folders enter a later pass', async () => {
  const f = await prepared();
  try {
    await execute(f.c, f.values, f.factory, f.store, f.p);
    const folder = new Mailbox();
    folder.add(Buffer.from('Content-Type: text/plain\r\n\r\nInternational\r\n'));
    f.source.folders.set('Customers/日本語', folder);
    f.source.folders.get('INBOX')!.add();
    const next = await makePlan(f.c, f.values, f.factory, {}, f.p.migration);
    const r = await execute(f.c, f.values, f.factory, f.store, next, { existing: true });
    assert.equal(r.counts.verified, 3);
    assert.ok(f.destination.folders.has('Customers/日本語'));
    assert.equal(f.destination.folders.get('INBOX')!.messages.size, 2);
  } finally {
    f.store.close();
  }
});
test('pilot completion stays labelled and later full scope includes leftovers', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.source.folders.get('INBOX')!.add();
  const p = await makePlan(f.c, f.values, f.factory, { pilot: 1 });
  mkdirSync(f.c.stateDirectory);
  const s = new Store(f.c.stateDirectory, true);
  try {
    const r = await execute(f.c, f.values, f.factory, s, p);
    assert.equal(r.scope.pilot, 1);
    assert.equal(r.occurrences, 1);
    const full = await makePlan(f.c, f.values, f.factory, {}, p.migration);
    assert.equal(
      (await execute(f.c, f.values, f.factory, s, full, { existing: true })).counts.verified,
      4,
    );
  } finally {
    s.close();
  }
});
test('cancellation settles current append and preserves remaining scope', async () => {
  const f = await prepared();
  try {
    f.source.folders.get('INBOX')!.add();
    const p = await makePlan(f.c, f.values, f.factory, {}, f.p.migration);
    let stop = false;
    f.destination.onAppend = () => {
      stop = true;
    };
    let r = await execute(f.c, f.values, f.factory, f.store, p, { stop: () => stop });
    assert.equal(r.counts.verified, 1);
    assert.equal(r.counts.discovered, 1);
    assert.equal(r.status, 'incomplete');
    f.destination.onAppend = undefined;
    r = await execute(f.c, f.values, f.factory, f.store, p, { existing: true });
    assert.equal(r.counts.verified, 2);
  } finally {
    f.store.close();
  }
});
test('size ceiling and quota pause do not truncate or loop', async () => {
  const f = await prepared();
  try {
    f.destination.limit = 1;
    let r = await execute(f.c, f.values, f.factory, f.store, f.p);
    assert.equal(r.counts.permanent_failure, 1);
    assert.equal(f.destination.writes.length, 0);
  } finally {
    f.store.close();
  }
  const g = await prepared();
  try {
    g.destination.fault = 'quota';
    const r = await execute(g.c, g.values, g.factory, g.store, g.p);
    assert.equal(r.counts.ambiguous, 1);
    assert.equal(g.destination.writes.length, 1);
  } finally {
    g.store.close();
  }
});
test('read-only plan never creates writable adapters', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const p = await makePlan(f.c, f.values, (e, s, w, c) => {
    assert.equal(w, false);
    return f.factory(e, s, w, c);
  });
  assert.equal(p.pairs[0]!.mappings[0]!.messages.length, 1);
  assert.equal(f.destination.writes.length, 0);
});
test('mapping collisions, delimiter collisions and virtual strategy are blocked', async () => {
  const folder = (path: string, delimiter = '/') => ({ path, delimiter, selectable: true });
  assert.throws(() =>
    mappings(
      [folder('A'), folder('a')],
      [],
      { exclude: [], overrides: {}, labelStrategy: 'unresolved' },
      true,
    ),
  );
  assert.throws(() =>
    mappings(
      [folder('A.B/C')],
      [folder('INBOX', '.')],
      { exclude: [], overrides: {}, labelStrategy: 'unresolved' },
      true,
    ),
  );
  const f = fixture();
  f.source.caps.push('X-GM-EXT-1');
  const p = await makePlan(f.c, f.values, f.factory);
  assert.equal(p.blockers.length, 1);
  assert.throws(() => checkPlan(p, f.c));
});
test('config validation rejects unknown fields, self-copy, duplicate IDs and insecure modes', () => {
  const f = fixture();
  assert.throws(() => validateConfig({ ...f.c, password: 'secret' }));
  assert.throws(() => validateConfig({ ...f.c, mailboxes: [f.c.mailboxes[0], f.c.mailboxes[0]] }));
  assert.throws(() =>
    validateConfig({
      ...f.c,
      mailboxes: [{ ...f.c.mailboxes[0], destination: f.c.mailboxes[0]!.source }],
    }),
  );
  assert.throws(() =>
    validateConfig({ ...f.c, defaults: { ...f.c.defaults, messageConcurrency: 2 } }),
  );
  assert.throws(() => validateConfig({ ...f.c, stateDirectory: f.c.reportDirectory }));
  const rotated = structuredClone(f.c);
  rotated.mailboxes[0]!.source.auth.secretRef = 'env:ROTATED';
  assert.equal(fingerprint(rotated), fingerprint(f.c));
  rotated.mailboxes[0]!.source.host = 'changed.example';
  assert.notEqual(fingerprint(rotated), fingerprint(f.c));
});
test('single writer lock, missing state and illegal transitions fail safely', async () => {
  const f = fixture();
  assert.throws(() => new Store(f.c.stateDirectory));
  const release = lock(f.c.stateDirectory);
  try {
    assert.throws(() => lock(f.c.stateDirectory));
    assert.throws(() => unlock(f.c.stateDirectory));
    const s = new Store(f.c.stateDirectory, true);
    try {
      const p = await makePlan(f.c, f.values, f.factory);
      s.begin(p);
      assert.equal(report(s, p.migration).status, 'incomplete');
    } finally {
      s.close();
    }
  } finally {
    release();
  }
});
test('server exception text is never exposed by error classification', () => {
  assert.equal(
    category(new Error('password=hunter2\u001b[31m private subject')),
    'access_or_provider',
  );
  assert.equal(category({ code: 'ECONNRESET', message: 'secret' }), 'network');
});
test('evidence is one-to-one even for manually linked identical content', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  f.source.folders.get('INBOX')!.add();
  f.destination.fault = 'no_uid';
  const p = await makePlan(f.c, f.values, f.factory);
  mkdirSync(f.c.stateDirectory);
  const s = new Store(f.c.stateDirectory, true);
  try {
    await execute(f.c, f.values, f.factory, s, p);
    const items = s.items(p.migration);
    await resolveItem(f.c, f.values, f.factory, s, p.migration, items[0]!.id, { link: '1' });
    await assert.rejects(
      () => resolveItem(f.c, f.values, f.factory, s, p.migration, items[1]!.id, { link: '1' }),
      /already_claimed/,
    );
    assert.equal(s.items(p.migration).filter((i) => i.state === 'verified').length, 1);
  } finally {
    s.close();
  }
});

test('one failed mailbox does not prevent an independent pair from finishing', async () => {
  const f = fixture();
  const source2 = new Server(),
    destination2 = new Server();
  source2.folders.get('INBOX')!.add();
  const second = structuredClone(f.c.mailboxes[0]!);
  second.id = 'second';
  second.source.username = 'second@business.example';
  second.destination.username = 'second@business.example';
  f.c.mailboxes.push(second);
  const values = new Map(
    f.c.mailboxes.flatMap(
      (m) =>
        [
          [m.source, 'synthetic'],
          [m.destination, 'synthetic'],
        ] as const,
    ),
  );
  const factory: typeof f.factory = (e, s, w, c) => {
    const server =
      e.username === 'second@business.example'
        ? e.host === 'old.example'
          ? source2
          : destination2
        : e.host === 'old.example'
          ? f.source
          : f.destination;
    return w ? new FakeWriter(server, true) : new FakeReader(server);
  };
  f.source.folders.get('INBOX')!.add();
  const p = await makePlan(f.c, values, factory);
  f.source.connectError = 'authentication';
  mkdirSync(f.c.stateDirectory);
  const store = new Store(f.c.stateDirectory, true);
  try {
    const r = await execute(f.c, values, factory, store, p);
    assert.equal(r.status, 'incomplete');
    assert.equal(r.counts.verified, 1);
    assert.equal(r.counts.discovered, 1);
    assert.equal(destination2.writes.length, 1);
    assert.equal(f.destination.writes.length, 0);
  } finally {
    store.close();
  }
});

test('a fresh catch-up plan cannot hide source identity invalidation', async () => {
  const f = await prepared();
  try {
    await execute(f.c, f.values, f.factory, f.store, f.p);
    f.source.folders.get('INBOX')!.validity = '42';
    const next = await makePlan(f.c, f.values, f.factory, {}, f.p.migration);
    await assert.rejects(
      () => execute(f.c, f.values, f.factory, f.store, next, { existing: true }),
      /source_uidvalidity_changed/,
    );
    assert.equal(report(f.store, f.p.migration).status, 'incomplete');
    assert.equal(f.store.items(f.p.migration)[0]!.state, 'identity_changed');
  } finally {
    f.store.close();
  }
});

test('corrected pre-append failure requires explicit local retry decision', async () => {
  const f = await prepared();
  try {
    f.destination.limit = 1;
    await execute(f.c, f.values, f.factory, f.store, f.p);
    f.destination.limit = null;
    let r = await execute(f.c, f.values, f.factory, f.store, f.p, { existing: true });
    assert.equal(r.counts.permanent_failure, 1);
    await resolveItem(f.c, f.values, f.factory, f.store, f.p.migration, r.items[0]!.id, {
      retryRead: true,
    });
    r = await execute(f.c, f.values, f.factory, f.store, f.p, { existing: true });
    assert.equal(r.counts.verified, 1);
  } finally {
    f.store.close();
  }
});

test('plans bind policy and endpoints, but credential rotation does not invalidate approval', async () => {
  const f = await prepared();
  try {
    const tampered = structuredClone(f.p);
    tampered.pairs[0]!.mappings[0]!.target = 'Elsewhere';
    assert.throws(() => checkPlan(tampered, f.c));
    const rotated = structuredClone(f.c);
    rotated.mailboxes[0]!.source.auth.secretRef = 'env:NEW';
    assert.doesNotThrow(() => checkPlan(f.p, rotated));
    const i: Item = {
      id: 'fake',
      mailbox: 'test',
      folder: 'INBOX',
      target: 'INBOX',
      validity: '1',
      meta: { uid: '1', date: null, size: 0, flags: [] },
      state: 'discovered',
      deviations: [],
    };
    f.store.begin(f.p);
    const actual = f.store.items(f.p.migration)[0]!;
    assert.throws(() => f.store.save(actual, 'verified'), /illegal_state_transition/);
  } finally {
    f.store.close();
  }
});

test('a narrowed pilot never copies older ledger work outside its approved occurrence list', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.source.folders.get('INBOX')!.add();
  const full = await makePlan(f.c, f.values, f.factory);
  mkdirSync(f.c.stateDirectory);
  const s = new Store(f.c.stateDirectory, true);
  try {
    s.begin(full);
    const pilot = await makePlan(f.c, f.values, f.factory, { pilot: 1 }, full.migration);
    const r = await execute(f.c, f.values, f.factory, s, pilot, { existing: true });
    assert.equal(f.destination.writes.length, 1);
    assert.equal(r.counts.discovered, 3);
    assert.equal(r.status, 'incomplete');
  } finally {
    s.close();
  }
});

test('verify revisits every ledger occurrence even after a narrower pilot plan', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.source.folders.get('INBOX')!.add();
  const full = await makePlan(f.c, f.values, f.factory);
  mkdirSync(f.c.stateDirectory);
  const s = new Store(f.c.stateDirectory, true);
  try {
    await execute(f.c, f.values, f.factory, s, full);
    const pilot = await makePlan(f.c, f.values, f.factory, { pilot: 1 }, full.migration);
    await execute(f.c, f.values, f.factory, s, pilot, { existing: true });
    f.destination.folders.get('INBOX')!.messages.delete('4');
    const writes = f.destination.writes.length;
    const r = await execute(f.c, f.values, f.factory, s, pilot, {
      existing: true,
      verifyOnly: true,
    });
    assert.equal(r.counts.destination_missing, 1);
    assert.equal(r.status, 'incomplete');
    assert.equal(f.destination.writes.length, writes);
  } finally {
    s.close();
  }
});
