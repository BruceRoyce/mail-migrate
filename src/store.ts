import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Item, Plan, State } from './model.js';
import { Fault, hash, canonical } from './safety.js';
export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}
export function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export function lock(directory: string): () => void {
  privateDir(directory);
  const path = join(directory, 'writer.lock');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new Fault('state_locked_use_unlock_after_confirming_owner_dead', 3);
  }
  try {
    writePrivate(join(path, 'owner.json'), {
      pid: process.pid,
      host: hostname(),
      started: new Date().toISOString(),
    });
  } catch (e) {
    rmdirSync(path);
    throw e;
  }
  return () => {
    unlinkSync(join(path, 'owner.json'));
    rmdirSync(path);
  };
}
export function unlock(directory: string): void {
  const path = join(directory, 'writer.lock');
  const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as {
    pid: number;
    host: string;
  };
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1)
    throw new Fault('lock_requires_manual_investigation', 3);
  try {
    process.kill(owner.pid, 0);
    throw new Fault('lock_owner_alive', 3);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
  unlinkSync(join(path, 'owner.json'));
  rmdirSync(path);
}
const transitions: Record<State, State[]> = {
  discovered: [
    'prepared',
    'source_missing',
    'retryable_failure',
    'permanent_failure',
    'identity_changed',
  ],
  prepared: [
    'append_pending',
    'source_missing',
    'retryable_failure',
    'permanent_failure',
    'identity_changed',
  ],
  append_pending: ['appended_unverified', 'ambiguous', 'identity_changed'],
  appended_unverified: [
    'verified',
    'ambiguous',
    'content_mismatch',
    'destination_missing',
    'identity_changed',
    'retryable_failure',
  ],
  verified: [
    'verified',
    'content_mismatch',
    'destination_missing',
    'identity_changed',
    'retryable_failure',
  ],
  retryable_failure: [
    'prepared',
    'verified',
    'source_missing',
    'permanent_failure',
    'content_mismatch',
    'destination_missing',
    'identity_changed',
    'retryable_failure',
  ],
  permanent_failure: ['discovered', 'identity_changed'],
  ambiguous: ['ambiguous', 'appended_unverified', 'discovered', 'identity_changed'],
  source_missing: ['discovered', 'identity_changed'],
  content_mismatch: [
    'appended_unverified',
    'verified',
    'content_mismatch',
    'destination_missing',
    'identity_changed',
    'retryable_failure',
  ],
  destination_missing: [
    'appended_unverified',
    'verified',
    'destination_missing',
    'identity_changed',
    'retryable_failure',
  ],
  identity_changed: ['identity_changed', 'appended_unverified'],
};
export const occurrenceId = (
  migration: string,
  mailbox: string,
  folder: string,
  validity: string,
  uid: string,
) => hash(canonical([migration, mailbox, folder, validity, uid]));
export class Store {
  db: DatabaseSync;
  constructor(directory: string, create = false) {
    const file = join(directory, 'ledger.sqlite');
    if (!create && !existsSync(file)) throw new Fault('state_missing_not_a_resume', 3);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version !== 0 && version !== 1) throw new Fault('unsupported_state_schema', 3);
    if (version === 0) {
      if (!create) throw new Fault('uninitialized_state', 3);
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE migrations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE passes(id TEXT PRIMARY KEY, migration TEXT NOT NULL REFERENCES migrations(id), started TEXT NOT NULL, ended TEXT, plan TEXT NOT NULL, result TEXT);
      CREATE TABLE folders(migration TEXT, mailbox TEXT, source TEXT, validity TEXT, target TEXT, destination_validity TEXT, boundary TEXT, PRIMARY KEY(migration,mailbox,source));
      CREATE TABLE items(id TEXT PRIMARY KEY,migration TEXT NOT NULL REFERENCES migrations(id),mailbox TEXT NOT NULL,folder TEXT NOT NULL,validity TEXT NOT NULL,uid TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL, UNIQUE(migration,mailbox,folder,validity,uid));
      CREATE TABLE attempts(id TEXT PRIMARY KEY,item TEXT NOT NULL REFERENCES items(id),intent TEXT NOT NULL,outcome TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE evidence(item TEXT PRIMARY KEY REFERENCES items(id),migration TEXT NOT NULL,mailbox TEXT NOT NULL,folder TEXT NOT NULL,validity TEXT NOT NULL,uid TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(migration,mailbox,folder,validity,uid));
      CREATE TABLE events(id INTEGER PRIMARY KEY,migration TEXT NOT NULL,at TEXT NOT NULL,category TEXT NOT NULL,data TEXT NOT NULL);
      PRAGMA user_version=1;COMMIT;`);
    }
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    if (
      (this.db.prepare('PRAGMA quick_check').get() as Record<string, string>).quick_check !== 'ok'
    )
      throw new Fault('state_corrupt', 3);
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  plan(id: string): Plan {
    const row = this.db.prepare('SELECT plan FROM migrations WHERE id=?').get(id) as
      { plan: string } | undefined;
    if (!row) throw new Fault('unknown_migration', 3);
    return JSON.parse(row.plan) as Plan;
  }
  migrationId(): string | undefined {
    const rows = this.db.prepare('SELECT id FROM migrations').all() as { id: string }[];
    if (rows.length > 1) throw new Fault('one_migration_per_state_directory', 3);
    return rows[0]?.id;
  }
  begin(p: Plan, existing = false): string {
    // Persist identity invalidation outside the new-pass transaction; a blocked plan must
    // not leave old verified rows looking current after a source UIDVALIDITY reset.
    for (const pair of p.pairs)
      for (const f of pair.mappings) {
        if (f.excluded) continue;
        const old = this.db
          .prepare(
            'SELECT validity,target FROM folders WHERE migration=? AND mailbox=? AND source=?',
          )
          .get(p.migration, pair.id, f.source.path) as
          { validity: string; target: string } | undefined;
        if (old && old.validity !== f.source.validity) {
          this.tx(() => {
            for (const item of this.items(p.migration).filter(
              (i) => i.mailbox === pair.id && i.folder === f.source.path,
            )) {
              item.category = 'source_uidvalidity_changed';
              this.save(item, 'identity_changed');
            }
            this.event(p.migration, 'source_uidvalidity_changed', {
              mailbox: pair.id,
              folder: f.source.path,
            });
          });
          throw new Fault('source_uidvalidity_changed');
        }
      }
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT fingerprint FROM migrations WHERE id=?')
        .get(p.migration) as { fingerprint: string } | undefined;
      if (!row && existing) throw new Fault('unknown_migration', 3);
      if (row && row.fingerprint !== p.fingerprint) {
        const history = this.db
          .prepare('SELECT plan FROM passes WHERE migration=?')
          .all(p.migration) as { plan: string }[];
        for (const prior of history)
          for (const old of (JSON.parse(prior.plan) as Plan).pairs) {
            const next = p.pairs.find((pair) => pair.id === old.id);
            if (
              next &&
              (canonical(next.source) !== canonical(old.source) ||
                canonical(next.destination) !== canonical(old.destination))
            )
              throw new Fault('endpoint_change_requires_separate_reconciliation', 3);
          }
      }
      if (!row) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as {
          n: number;
        };
        if (count.n) throw new Fault('one_migration_per_state_directory', 3);
        this.db
          .prepare('INSERT INTO migrations VALUES(?,?,?,?)')
          .run(p.migration, p.fingerprint, JSON.stringify(p), 'incomplete');
      }
      this.db
        .prepare('UPDATE migrations SET plan=?,status=?,fingerprint=? WHERE id=?')
        .run(JSON.stringify(p), 'incomplete', p.fingerprint, p.migration);
      const pass = randomUUID();
      this.db
        .prepare('INSERT INTO passes VALUES(?,?,?,?,?,?)')
        .run(pass, p.migration, new Date().toISOString(), null, JSON.stringify(p), null);
      for (const pair of p.pairs)
        for (const f of pair.mappings) {
          if (f.excluded) continue;
          const old = this.db
            .prepare('SELECT * FROM folders WHERE migration=? AND mailbox=? AND source=?')
            .get(p.migration, pair.id, f.source.path) as
            { validity: string; target: string } | undefined;
          if (old && (old.validity !== f.source.validity || old.target !== f.target))
            throw new Fault('source_uidvalidity_or_mapping_changed');
          this.db
            .prepare('INSERT OR IGNORE INTO folders VALUES(?,?,?,?,?,?,?)')
            .run(
              p.migration,
              pair.id,
              f.source.path,
              f.source.validity!,
              f.target,
              null,
              f.boundary!,
            );
          this.db
            .prepare('UPDATE folders SET boundary=? WHERE migration=? AND mailbox=? AND source=?')
            .run(f.boundary!, p.migration, pair.id, f.source.path);
          for (const meta of f.messages) {
            const id = occurrenceId(
              p.migration,
              pair.id,
              f.source.path,
              f.source.validity!,
              meta.uid,
            );
            const item: Item = {
              id,
              mailbox: pair.id,
              folder: f.source.path,
              target: f.target,
              validity: f.source.validity!,
              meta,
              state: 'discovered',
              deviations: [],
            };
            this.db
              .prepare('INSERT OR IGNORE INTO items VALUES(?,?,?,?,?,?,?,?)')
              .run(
                id,
                p.migration,
                pair.id,
                item.folder,
                item.validity,
                meta.uid,
                item.state,
                JSON.stringify(item),
              );
          }
        }
      return pass;
    });
  }
  items(migration: string): Item[] {
    return (
      this.db.prepare('SELECT data FROM items WHERE migration=? ORDER BY rowid').all(migration) as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as Item);
  }
  item(id: string): Item {
    const row = this.db.prepare('SELECT data FROM items WHERE id=?').get(id) as
      { data: string } | undefined;
    if (!row) throw new Fault('unknown_item', 3);
    return JSON.parse(row.data) as Item;
  }
  save(item: Item, state: State): void {
    const old = this.item(item.id).state;
    if (old !== state && !transitions[old].includes(state))
      throw new Fault('illegal_state_transition', 3);
    item.state = state;
    this.db
      .prepare('UPDATE items SET state=?,data=? WHERE id=?')
      .run(state, JSON.stringify(item), item.id);
  }
  intent(item: Item): string {
    return this.tx(() => {
      this.save(item, 'append_pending');
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO attempts VALUES(?,?,?,?,?)')
        .run(
          id,
          item.id,
          new Date().toISOString(),
          'pending',
          JSON.stringify({ baseline: item.baseline, hash: item.hash }),
        );
      return id;
    });
  }
  outcome(item: Item, attempt: string, state: State): void {
    this.tx(() => {
      this.save(item, state);
      this.db.prepare('UPDATE attempts SET outcome=?,data=? WHERE id=?').run(
        state,
        JSON.stringify({
          category: item.category,
          destination: item.destination,
          baseline: item.baseline,
        }),
        attempt,
      );
    });
  }
  verified(migration: string, item: Item): void {
    if (!item.evidence) throw new Fault('missing_evidence', 3);
    this.tx(() => {
      const e = item.evidence!;
      this.db
        .prepare(
          'INSERT INTO evidence VALUES(?,?,?,?,?,?,?) ON CONFLICT(item) DO UPDATE SET validity=excluded.validity,uid=excluded.uid,data=excluded.data',
        )
        .run(item.id, migration, item.mailbox, e.folder, e.validity, e.uid, JSON.stringify(e));
      this.save(item, 'verified');
    });
  }
  event(migration: string, cat: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO events(migration,at,category,data) VALUES(?,?,?,?)')
      .run(migration, new Date().toISOString(), cat, JSON.stringify(data));
  }
  finish(pass: string, migration: string, result: unknown): void {
    this.tx(() => {
      this.db
        .prepare('UPDATE passes SET ended=?,result=? WHERE id=?')
        .run(new Date().toISOString(), JSON.stringify(result), pass);
      this.db.prepare('UPDATE migrations SET status=? WHERE id=?').run('see_report', migration);
    });
  }
  close(): void {
    this.db.close();
  }
}
