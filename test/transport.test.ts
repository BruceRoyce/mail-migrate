import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ImapReader } from '../src/transport.js';
import { fixture } from './fake.js';
import type { ImapFlow } from 'imapflow';
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
