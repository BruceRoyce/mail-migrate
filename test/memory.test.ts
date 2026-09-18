import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fixture } from './fake.js';
import { makePlan } from '../src/plan.js';
import { execute } from '../src/engine.js';
import { Store } from '../src/store.js';
test('25 MiB application memory smoke test at concurrency one (synthetic adapter)', async () => {
  const f = fixture();
  const payload = Buffer.alloc(f.c.defaults.maxMessageBytes, 0x78);
  Buffer.from('From: synthetic@business.example\r\nContent-Type: text/plain\r\n\r\n').copy(payload);
  payload[payload.length - 2] = 13;
  payload[payload.length - 1] = 10;
  f.source.folders.get('INBOX')!.add(payload);
  const plan = await makePlan(f.c, f.values, f.factory);
  mkdirSync(f.c.stateDirectory);
  const store = new Store(f.c.stateDirectory, true);
  const rssBefore = process.memoryUsage().rss;
  try {
    const result = await execute(f.c, f.values, f.factory, store, plan);
    assert.equal(result.counts.verified, 1);
    assert.equal(result.verifiedBytes, payload.length);
    const measure = {
      adapter: 'synthetic (not IMAP interoperability evidence)',
      maxMessageBytes: payload.length,
      concurrency: 1,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      peakRssKiB: process.resourceUsage().maxRSS,
    };
    console.log(JSON.stringify(measure));
    assert.ok(measure.peakRssKiB * 1024 < f.c.defaults.memoryBudgetMiB * 1024 * 1024);
  } finally {
    store.close();
  }
});
