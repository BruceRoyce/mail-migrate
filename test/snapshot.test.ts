import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, Mailbox } from './fake.js';
import { discoverSnapshot, planFromSnapshot, checkPlan } from '../src/plan.js';

test('snapshot keeps full pilot inventory and locally recomputes selection without changing the snapshot', async () => {
  const f = fixture();
  const inbox = f.source.folders.get('INBOX')!;
  inbox.add();
  inbox.add();
  inbox.add();
  const archive = new Mailbox();
  archive.add();
  archive.add();
  f.source.folders.set('Archive/日本語', archive);
  const snapshot = await discoverSnapshot(f.c, f.values, f.factory, { pilot: 1 });
  const frozen = JSON.stringify(snapshot);
  const first = planFromSnapshot(f.c, snapshot, { pilot: 1 });
  assert.equal(first.pairs[0]!.mappings[0]!.messages.length, 1);
  assert.equal(snapshot.inventory.pairs[0]!.mappings[0]!.messages.length, 3);
  inbox.add(); // Later mail must not silently enter a reviewed snapshot.
  f.c.mailboxes[0]!.folders.exclude = ['INBOX'];
  const selected = planFromSnapshot(f.c, snapshot, { pilot: 2 });
  assert.equal(selected.migration, first.migration);
  assert.notEqual(selected.hash, first.hash);
  assert.equal(selected.pairs[0]!.mappings[0]!.messages.length, 0);
  const selectedArchive = selected.pairs[0]!.mappings[1]!;
  assert.equal(selectedArchive.messages.length, 2);
  assert.equal(
    selectedArchive.bytes,
    selectedArchive.messages.reduce((n, m) => n + m.size, 0),
  );
  checkPlan(selected, f.c);
  f.c.mailboxes[0]!.folders.exclude = [];
  const restored = planFromSnapshot(f.c, snapshot);
  assert.equal(restored.pairs[0]!.mappings[0]!.messages.length, 3);
  assert.equal(restored.pairs[0]!.mappings[1]!.messages.length, 2);
  assert.equal(JSON.stringify(snapshot), frozen);
  assert.equal(first.pairs[0]!.mappings[0]!.messages.length, 1);
  assert.equal(f.destination.writes.length, 0);
});

test('never-inventoried folders require explicit refresh while excluded folders remain approvable', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  f.c.mailboxes[0]!.folders.exclude = ['INBOX'];
  const snapshot = await discoverSnapshot(f.c, f.values, f.factory);
  f.c.mailboxes[0]!.folders.exclude = [];
  const pending = planFromSnapshot(f.c, snapshot);
  assert.ok(pending.blockers.some((b) => b.endsWith(':refresh_discovery_required:INBOX')));
  assert.throws(() => checkPlan(pending, f.c), /plan_invalid_or_blocked/);
  f.c.mailboxes[0]!.folders.exclude = ['INBOX'];
  checkPlan(planFromSnapshot(f.c, snapshot), f.c);
});

test('local planning revalidates mappings and label acknowledgement and rejects changed connection settings', async () => {
  const f = fixture();
  f.source.caps.push('X-GM-EXT-1');
  f.source.folders.set('Other', new Mailbox());
  f.destination.folders.set('Previously unmapped', new Mailbox());
  const snapshot = await discoverSnapshot(f.c, f.values, f.factory);
  assert.ok(planFromSnapshot(f.c, snapshot).blockers.length);
  f.c.mailboxes[0]!.folders.labelStrategy = 'explicit-folders';
  f.c.mailboxes[0]!.folders.overrides = { INBOX: 'Previously unmapped' };
  const plan = planFromSnapshot(f.c, snapshot);
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.pairs[0]!.mappings[0]!.existing?.path, 'Previously unmapped');
  f.c.mailboxes[0]!.folders.overrides.Other = 'Previously unmapped';
  assert.throws(() => planFromSnapshot(f.c, snapshot), /mapping_collision/);
  f.c.mailboxes[0]!.source.host = 'different.example';
  assert.throws(() => planFromSnapshot(f.c, snapshot), /discovery_settings_changed/);
});
