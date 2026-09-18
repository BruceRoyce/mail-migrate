import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { validateConfig, type Endpoint } from '../../src/config.js';
import { ImapWriter, ImapReader, imapFactory } from '../../src/transport.js';
import { makePlan } from '../../src/plan.js';
import { Store } from '../../src/store.js';
import { execute } from '../../src/engine.js';
import { hash } from '../../src/safety.js';
const enabled = process.env.IMAP_INTEGRATION === '1';
test(
  'two TLS Dovecot servers: MIME fixtures, duplicates, immutability, rerun and 25 MiB ceiling',
  { skip: !enabled, timeout: 180000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), 'mail-migrate-imap-'));
    const endpoint = (port: number, side: string) => ({
      host: '127.0.0.1',
      port,
      tlsMode: 'implicit',
      username: side + '@business.example',
      caFile: resolve(`test/integration/private-certs/${side}.pem`),
      auth: { type: 'password', secretRef: 'env:SYNTHETIC' },
    });
    const c = validateConfig({
      version: 1,
      stateDirectory: join(base, 'state'),
      reportDirectory: join(base, 'reports'),
      mailboxes: [
        {
          id: 'synthetic',
          source: endpoint(1993, 'source'),
          destination: endpoint(2993, 'destination'),
          folders: {},
        },
      ],
    });
    const m = c.mailboxes[0]!,
      values = new Map<Endpoint, string>([
        [m.source, 'synthetic-test-only'],
        [m.destination, 'synthetic-test-only'],
      ]);
    const source = new ImapWriter(m.source, 'synthetic-test-only', c),
      dest = new ImapWriter(m.destination, 'synthetic-test-only', c);
    for (let attempt = 0; ; attempt++) {
      try {
        await source.connect();
        break;
      } catch (e) {
        if (attempt === 9) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await dest.connect();
    const common =
      'From: synthetic@business.example\r\nTo: synthetic@business.example\r\nMIME-Version: 1.0\r\n';
    const bodies = [
      'Content-Type: text/plain; charset=utf-8\r\n\r\nHello 日本語\r\n',
      'Content-Type: text/html\r\n\r\n<p>HTML must never be rendered<script>throw 1</script></p>\r\n',
      'Message-ID: <repeated@business.example>\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="test.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAwQF\r\n--b--\r\n',
      'Message-ID: <repeated@business.example>\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: image/png\r\nContent-ID: <inline>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--b--\r\n',
      'Content-Type: multipart/signed; boundary="b"; protocol="application/pgp-signature"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nOpaque signed fixture\r\n--b\r\nContent-Type: application/pgp-signature\r\n\r\nSYNTHETIC-NOT-A-REAL-SIGNATURE\r\n--b--\r\n',
      'Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\nContent-Transfer-Encoding: base64\r\n\r\nU3ludGhldGljIG9wYXF1ZSBieXRlcw==\r\n',
    ];
    const fixtures = bodies.map((b) => Buffer.from(common + b));
    fixtures.push(fixtures[0]!);
    await source.create('Clients/日本語');
    await source.open('INBOX');
    await dest.open('INBOX');
    for (const bytes of fixtures)
      await source.append('INBOX', bytes, ['\\Seen', '\\Flagged'], '2020-01-02T03:04:05.000Z');
    await source.append('Clients/日本語', fixtures[0]!, [], '2020-01-02T03:04:05.000Z');
    await dest.append(
      'INBOX',
      Buffer.from(common + '\r\nUnrelated existing mail\r\n'),
      [],
      '2020-01-02T03:04:05.000Z',
    );
    const header = Buffer.from(common + 'Content-Type: text/plain\r\n\r\n');
    const max = Buffer.alloc(c.defaults.maxMessageBytes, 0x78);
    header.copy(max);
    max[max.length - 2] = 13;
    max[max.length - 1] = 10;
    await source.append('INBOX', max, [], '2020-01-02T03:04:05.000Z');
    await source.close();
    await dest.close();
    const snapshot = async () => {
      const reader = new ImapReader(m.source, 'synthetic-test-only', c);
      await reader.connect();
      try {
        const result = [];
        for (const f of await reader.list()) {
          if (!f.selectable) continue;
          const v = await reader.open(f.path);
          const meta = await reader.scan(String(BigInt(v.next) - 1n), 100);
          for (const msg of meta)
            result.push({
              folder: f.path,
              ...msg,
              hash: hash(await reader.raw(msg.uid, c.defaults.maxMessageBytes)),
            });
        }
        return result;
      } finally {
        await reader.close();
      }
    };
    const before = await snapshot();
    const plan = await makePlan(c, values, imapFactory);
    mkdirSync(c.stateDirectory);
    const store = new Store(c.stateDirectory, true);
    const rssBefore = process.memoryUsage().rss;
    try {
      const result = await execute(c, values, imapFactory, store, plan);
      assert.equal(result.unresolved, 0, JSON.stringify(result.lastPass));
      assert.equal(result.counts.verified, fixtures.length + 2);
      const again = await execute(c, values, imapFactory, store, plan, { existing: true });
      assert.equal(again.lastPass?.skipped, fixtures.length + 2);
      const verify = await execute(c, values, imapFactory, store, plan, {
        existing: true,
        verifyOnly: true,
      });
      assert.equal(verify.unresolved, 0);
      assert.deepEqual(await snapshot(), before);
      const measure = {
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        peakRssKiB: process.resourceUsage().maxRSS,
        maxMessageBytes: c.defaults.maxMessageBytes,
        concurrency: 1,
      };
      writeFileSync(
        'test/integration/private-memory-measurement.json',
        JSON.stringify(measure, null, 2),
      );
      console.log(JSON.stringify(measure));
      assert.ok(
        measure.peakRssKiB * 1024 < c.defaults.memoryBudgetMiB * 1024 * 1024,
        'Measured process peak exceeded configured planning allowance',
      );
    } finally {
      store.close();
    }
  },
);
