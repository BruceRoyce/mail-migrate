import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ImapReader } from '../src/transport.js';
import { fixture } from './fake.js';
import type { ImapFlow } from 'imapflow';
import type { ScanProgress } from '../src/model.js';
class Probe extends ImapReader {
  replace(client: Partial<ImapFlow>) {
    this.client = client as ImapFlow;
  }
  options() {
    return this.client.options;
  }
}
test('transport always validates TLS and requires STARTTLS; source selects read-only', async () => {
  const f = fixture();
  const p = new Probe({ ...f.c.mailboxes[0]!.source, tlsMode: 'starttls' }, 'not-logged', f.c);
  const options = p.options();
  assert.equal(options.doSTARTTLS, true);
  assert.equal(options.tls?.rejectUnauthorized, true);
  assert.equal(options.logger, false);
  assert.equal(options.logRaw, false);
  let closed = false;
  p.replace({
    mailboxOpen: async (_path, opts) => {
      assert.equal(opts?.readOnly, true);
      return { uidValidity: 9007199254740993n, uidNext: 2, exists: 1 } as never;
    },
    close: () => {
      closed = true;
    },
  });
  assert.equal((await p.open('INBOX')).validity, '9007199254740993');
  await p.close();
  assert.ok(closed);
  assert.equal('append' in p, false);
});
test('download cap rejects oversized and truncated bytes instead of passing verification', async () => {
  const f = fixture();
  const p = new Probe(f.c.mailboxes[0]!.source, 'synthetic', f.c);
  let bytes = Buffer.from('abc');
  p.replace({
    fetchOne: async (_uid, _query, opts) => {
      assert.equal(opts?.uid, true);
      return { uid: 1, size: 3, flags: new Set(), internalDate: new Date() } as never;
    },
    download: async (uid, part, opts) => {
      assert.equal(uid, '1');
      assert.equal(part, undefined);
      assert.equal(opts?.uid, true);
      assert.equal(opts?.chunkSize, 65536);
      assert.equal(opts?.maxBytes, 4);
      return { content: Readable.from([bytes]) } as never;
    },
  });
  assert.deepEqual(await p.raw('1', 3), bytes);
  bytes = Buffer.from('ab');
  await assert.rejects(() => p.raw('1', 3), /truncated/);
  bytes = Buffer.from('abcd');
  await assert.rejects(() => p.raw('1', 3), /quota_or_size/);
});

test('sparse high UIDs use one bounded SEARCH and metadata FETCH batches, not per-message requests', async () => {
  const f = fixture();
  const reader = new Probe(f.c.mailboxes[0]!.source, 'synthetic', f.c);
  const ids = Array.from({ length: 501 }, (_, i) => 4000000000 + i),
    searches: string[] = [],
    batches: string[] = [],
    events: ScanProgress[] = [];
  reader.replace({
    mailbox: { exists: 501 } as never,
    search: async (query, options) => {
      assert.equal(options?.uid, true);
      searches.push(String(query.uid));
      return ids;
    },
    fetch: async function* (range, query, options) {
      assert.equal(options?.uid, true);
      assert.equal(query.source, undefined);
      batches.push(String(range));
      for (const uid of String(range).split(',').map(Number)) {
        if (uid === 4000000001) continue;
        yield {
          uid,
          size: 42,
          flags: new Set(['\\Seen']),
          internalDate: new Date('2020-01-01T00:00:00Z'),
        } as never;
      }
    },
    fetchOne: async () => {
      throw new Error('Per-message FETCH must not be used by scan');
    },
  });
  const messages = await reader.scan('4000001000', 501, '1', { progress: (p) => events.push(p) });
  assert.deepEqual(searches, ['1:4000001000']);
  assert.equal(batches.length, 3);
  assert.ok(batches.every((b) => b.split(',').length <= 250));
  assert.equal(messages.length, 501);
  assert.equal(messages[1]!.date, null);
  assert.equal(messages[1]!.uid, '4000000001');
  assert.equal(events.at(-1)!.scanned, 501);
  assert.equal(events.at(-1)!.bytes, 500 * 42);
});

test('scan aborts before the next batch and rejects unexpected UIDs', async () => {
  const f = fixture();
  const reader = new Probe(f.c.mailboxes[0]!.source, 'synthetic', f.c);
  const controller = new AbortController();
  let batches = 0;
  reader.replace({
    mailbox: { exists: 251 } as never,
    search: async () => Array.from({ length: 251 }, (_, i) => i + 1),
    fetch: async function* () {
      batches++;
      controller.abort();
      yield { uid: 1, size: 1 } as never;
    },
  });
  await assert.rejects(() => reader.scan('251', 251, '1', { signal: controller.signal }));
  assert.equal(batches, 1);
  reader.replace({
    mailbox: { exists: 1 } as never,
    search: async () => [7],
    fetch: async function* () {
      yield { uid: 8, size: 1 } as never;
    },
  });
  await assert.rejects(() => reader.scan('8', 10), /unexpected_fetch_uid/);
});
