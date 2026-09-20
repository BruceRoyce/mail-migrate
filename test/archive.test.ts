import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fixture, Mailbox, raw } from './fake.js';
import { ArchiveReader, archiveSource, exportArchive, openArchive } from '../src/archive.js';
import { makePlan } from '../src/plan.js';
import { execute } from '../src/engine.js';
import { Store, privateDir } from '../src/store.js';
import type { Factory } from '../src/transport.js';

test('local archive preserves raw bytes, duplicates, folders and metadata, imports offline and resumes without duplicates', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add(raw, ['\\Seen']);
  f.source.folders.get('INBOX')!.add(raw, ['\\Seen']);
  const nested = new Mailbox();
  nested.add(Buffer.concat([raw, Buffer.from('nested attachment bytes\x00\xff')]));
  f.source.folders.set('Clients/日本語', nested);
  const directory = join(f.base, 'named-archive');
  const progress: number[] = [];
  await exportArchive(
    f.c,
    f.c.mailboxes[0]!.source,
    'never-save-password',
    f.factory,
    directory,
    [],
    (p) => progress.push(p.messages),
  );
  const exported = openArchive(directory);
  assert.equal(exported.manifest.folders.length, 2);
  assert.equal(exported.manifest.folders[0]!.messages.length, 2);
  assert.equal(progress.at(-1), 3);
  assert.equal(existsSync(join(directory, 'INCOMPLETE.txt')), false);
  assert.ok(!readFileSync(join(directory, 'archive.json'), 'utf8').includes('never-save-password'));
  assert.equal(f.source.writes.length, 0);
  assert.equal(f.destination.writes.length, 0);
  const moved = join(f.base, 'moved-archive');
  renameSync(directory, moved);
  const archive = openArchive(moved);
  assert.equal(archive.digest, exported.digest);
  const source = archiveSource(archive);
  f.c.mailboxes[0]!.source = source;
  const values = new Map([
    [source, 'local'],
    [f.c.mailboxes[0]!.destination, 'synthetic'],
  ]);
  const factory: Factory = (e, secret, writable, c) => {
    if (e === source) {
      assert.equal(writable, false);
      return new ArchiveReader(archive);
    }
    assert.equal(e.host, 'new.example');
    return f.factory(e, secret, writable, c);
  };
  const plan = await makePlan(f.c, values, factory);
  privateDir(f.c.stateDirectory);
  const store = new Store(f.c.stateDirectory, true);
  try {
    const report = await execute(f.c, values, factory, store, plan);
    assert.equal(report.counts.verified, 3);
    assert.equal(f.destination.folders.get('INBOX')!.messages.size, 2);
    const copied = f.destination.folders.get('INBOX')!.messages.get('1')!;
    assert.deepEqual(copied.bytes, raw);
    assert.deepEqual(copied.flags, ['\\Seen']);
    assert.equal(copied.date, '2020-01-02T03:04:05.000Z');
    assert.deepEqual(
      f.destination.folders.get('Clients/日本語')!.messages.get('1')!.bytes,
      nested.messages.get('1')!.bytes,
    );
    await execute(f.c, values, factory, store, plan, { existing: true });
    assert.equal(f.destination.folders.get('INBOX')!.messages.size, 2);
  } finally {
    store.close();
  }
});

test('archive refuses overwrite, corrupt content, traversal and modified manifests', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const directory = join(f.base, 'archive');
  await exportArchive(f.c, f.c.mailboxes[0]!.source, 'secret', f.factory, directory, [], () => {});
  await assert.rejects(
    exportArchive(f.c, f.c.mailboxes[0]!.source, 'secret', f.factory, directory, [], () => {}),
    /archive_target_already_exists/,
  );
  const archive = openArchive(directory);
  const reader = new ArchiveReader(archive);
  await reader.open('INBOX');
  writeFileSync(join(directory, archive.manifest.folders[0]!.messages[0]!.file), 'corrupt');
  await assert.rejects(reader.raw('1', 10000), /archive_checksum_mismatch/);
  const malicious = structuredClone(archive.manifest);
  malicious.folders[0]!.messages[0]!.file = '../outside.eml';
  writeFileSync(join(directory, 'archive.json'), JSON.stringify(malicious));
  assert.throws(() => openArchive(directory), /archive_manifest_invalid/);
  writeFileSync(
    join(directory, 'archive.json'),
    JSON.stringify({ ...archive.manifest, id: '00000000-0000-4000-8000-000000000001' }),
  );
  await assert.rejects(reader.connect(), /archive_manifest_changed/);
});

test('failed and cancelled exports cannot be imported; exclusions never download their messages', async () => {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const path = join(f.base, 'cancelled');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportArchive(
      f.c,
      f.c.mailboxes[0]!.source,
      'secret',
      f.factory,
      path,
      [],
      () => {},
      controller.signal,
    ),
    /discovery_cancelled/,
  );
  assert.throws(() => openArchive(path), /archive_incomplete/);
  const limited = join(f.base, 'limited');
  f.c.defaults.maxMessageBytes = 1;
  await assert.rejects(
    exportArchive(f.c, f.c.mailboxes[0]!.source, 'secret', f.factory, limited, [], () => {}),
    /quota_or_size/,
  );
  assert.equal(existsSync(join(limited, 'archive.json')), false);
  const excluded = join(f.base, 'excluded');
  await exportArchive(
    f.c,
    f.c.mailboxes[0]!.source,
    'secret',
    f.factory,
    excluded,
    ['INBOX'],
    () => {},
  );
  assert.equal(openArchive(excluded).manifest.folders.length, 0);
  assert.deepEqual(openArchive(excluded).manifest.exclusions, ['INBOX']);
});
