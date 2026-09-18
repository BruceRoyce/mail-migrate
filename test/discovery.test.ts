import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FakeReader } from './fake.js';
import { makePlan } from '../src/plan.js';
import type { DiscoveryProgress } from '../src/discovery.js';
import type { ScanControl } from '../src/model.js';

test('planning publishes each stage, folder totals and inventoried message counts', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const progress: DiscoveryProgress[] = [];
  const plan = await makePlan(f.c, f.values, f.factory, {}, undefined, {
    progress: (p) => progress.push(p),
  });
  assert.equal(plan.pairs[0]!.mappings[0]!.messages.length, 1);
  for (const phase of [
    'connecting_source',
    'connecting_destination',
    'listing_source',
    'listing_destination',
    'opening_folder',
    'searching',
    'quota',
    'complete',
  ])
    assert.ok(progress.some((p) => p.phase === phase));
  assert.equal(progress.at(-1)!.messages, 1);
  assert.equal(progress.at(-1)!.foldersDone, 1);
  assert.equal(f.destination.writes.length, 0);
});

test('an unresponsive discovery read times out, closes connections and cannot publish a plan', async () => {
  const f = fixture();
  let closes = 0,
    connects = 0;
  let phase: string | undefined;
  const factory: typeof f.factory = (e, s, w, c) => {
    assert.equal(w, false);
    const reader = f.factory(e, s, w, c);
    reader.close = async () => {
      closes++;
    };
    reader.connect = async () => {
      connects++;
      return new Promise<void>(() => {});
    };
    return reader;
  };
  await assert.rejects(
    () =>
      makePlan(f.c, f.values, factory, {}, undefined, {
        operationTimeoutMs: 25,
        progress: (p) => {
          phase = p.phase;
        },
      }),
    /discovery_timeout/,
  );
  assert.equal(phase, 'connecting_source');
  assert.equal(connects, 1);
  assert.ok(closes >= 2);
  assert.equal(f.destination.writes.length, 0);
});

test('cancel interrupts an in-flight read and no subsequent discovery operations start', async () => {
  const f = fixture();
  const controller = new AbortController();
  let closes = 0,
    connects = 0;
  const factory: typeof f.factory = (e, s, w, c) => {
    const reader = f.factory(e, s, w, c);
    reader.close = async () => {
      closes++;
    };
    reader.connect = async () => {
      connects++;
      controller.abort();
      return new Promise<void>(() => {});
    };
    return reader;
  };
  await assert.rejects(
    () => makePlan(f.c, f.values, factory, {}, undefined, { signal: controller.signal }),
    /discovery_cancelled/,
  );
  assert.equal(connects, 1);
  assert.ok(closes >= 2);
  assert.equal(f.destination.writes.length, 0);
});

test('scan progress renews a read deadline for a legitimately long folder scan', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  class SlowReader extends FakeReader {
    override async scan(boundary: string, ceiling: number, from = '1', control: ScanControl = {}) {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 50));
        control.signal?.throwIfAborted();
        control.progress?.({ phase: 'fetching', scanned: 0, total: 1, bytes: 0 });
      }
      return super.scan(boundary, ceiling, from);
    }
  }
  const factory: typeof f.factory = (e) =>
    new SlowReader(e.host === 'old.example' ? f.source : f.destination);
  const plan = await makePlan(f.c, f.values, factory, {}, undefined, { operationTimeoutMs: 150 });
  assert.equal(plan.pairs[0]!.mappings[0]!.messages.length, 1);
});

test('an over-limit inventory fails before a metadata scan; pilot does not conceal the limit', async () => {
  const f = fixture();
  f.c.defaults.maxOccurrences = 1;
  f.source.folders.get('INBOX')!.add();
  f.source.folders.get('INBOX')!.add();
  let scans = 0;
  const factory: typeof f.factory = (e, s, w, c) => {
    const reader = f.factory(e, s, w, c);
    reader.scan = async () => {
      scans++;
      return [];
    };
    return reader;
  };
  await assert.rejects(() => makePlan(f.c, f.values, factory, { pilot: 1 }), /occurrence_ceiling/);
  assert.equal(scans, 0);
});
