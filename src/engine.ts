import { identity, type Config, type Endpoint } from './config.js';
import type { Evidence, Item, PairPlan, Plan, Reader, View, Writer } from './model.js';
import type { Factory } from './transport.js';
import { Store } from './store.js';
import { checkPlan } from './plan.js';
import { Fault, category, hash, readRetry } from './safety.js';

export type Progress = { mailbox: string; item?: string; state: string; bytes?: number };
function verificationPairs(c: Config, items: Item[]): PairPlan[] {
  const result: PairPlan[] = [];
  for (const id of new Set(items.map((i) => i.mailbox))) {
    const configured = c.mailboxes.find((m) => m.id === id);
    if (!configured) throw new Fault('ledger_mailbox_missing_from_config', 3);
    const owned = items.filter((i) => i.mailbox === id);
    result.push({
      id,
      source: identity(configured.source),
      destination: identity(configured.destination),
      capabilities: { source: [], destination: [] },
      quota: { status: 'unknown' },
      appendLimit: null,
      warnings: [],
      mappings: [...new Set(owned.map((i) => i.folder))].map((folder) => {
        const occurrences = owned.filter((i) => i.folder === folder),
          first = occurrences[0]!;
        return {
          source: { path: folder, delimiter: '', selectable: true, validity: first.validity },
          target: first.target,
          messages: occurrences.map((i) => i.meta),
          bytes: occurrences.reduce((n, i) => n + i.meta.size, 0),
          oversized: 0,
        };
      }),
    });
  }
  return result;
}
export function report(store: Store, migration: string) {
  const items = store.items(migration),
    plan = store.plan(migration),
    counts: Record<string, number> = {};
  for (const i of items) counts[i.state] = (counts[i.state] ?? 0) + 1;
  const last = store.db
    .prepare('SELECT * FROM passes WHERE migration=? ORDER BY rowid DESC LIMIT 1')
    .get(migration) as { id: string; ended: string | null; result: string | null } | undefined;
  const passResult = last?.result
    ? (JSON.parse(last.result) as {
        errors: string[];
        interrupted: boolean;
        skipped: number;
        newArrivals: unknown[];
      })
    : null;
  const unresolved = items.filter((i) => i.state !== 'verified').length;
  return {
    version: 1,
    migration,
    plan: plan.id,
    planHash: plan.hash,
    scope: plan.scope,
    status:
      unresolved || !last?.ended || passResult?.errors.length || passResult?.interrupted
        ? 'incomplete'
        : items.some((i) => i.deviations.length)
          ? 'content_complete_with_metadata_deviations'
          : 'content_complete_for_recorded_scope',
    counts,
    occurrences: items.length,
    verifiedBytes: items
      .filter((i) => i.state === 'verified')
      .reduce((n, i) => n + (i.evidence?.size ?? 0), 0),
    unresolved,
    lastPass: passResult,
    scopeLimitations: plan.limitations,
    exclusions: plan.pairs.flatMap((p) =>
      p.mappings
        .filter((m) => m.excluded)
        .map((m) => ({ mailbox: p.id, folder: m.source.path, reason: m.excluded })),
    ),
    items,
    events: store.db
      .prepare('SELECT at,category,data FROM events WHERE migration=? ORDER BY id')
      .all(migration),
    verification:
      'raw-sha256; evidence is an observation, not a guarantee of continued destination retention',
  };
}

export async function verifyItem(
  store: Store,
  migration: string,
  item: Item,
  d: Reader,
  view: View,
  ceiling: number,
): Promise<void> {
  view = await d.open(item.target);
  if (!item.destination || !item.hash) {
    item.category = 'no_destination_identity';
    store.save(item, 'ambiguous');
    return;
  }
  if (view.validity !== item.destination.validity) {
    item.category = 'destination_uidvalidity_changed';
    store.save(item, 'identity_changed');
    return;
  }
  const meta = await readRetry(() => d.meta(item.destination!.uid));
  if (!meta) {
    item.category = 'destination_missing';
    store.save(item, 'destination_missing');
    return;
  }
  let raw: Buffer;
  try {
    raw = await readRetry(() => d.raw(item.destination!.uid, ceiling));
  } catch (e) {
    if (category(e) !== 'source_missing') throw e;
    item.category = 'destination_missing';
    store.save(item, 'destination_missing');
    return;
  }
  const observed = hash(raw);
  if ((await d.open(item.target)).validity !== view.validity) {
    item.category = 'destination_uidvalidity_changed';
    store.save(item, 'identity_changed');
    return;
  }
  if (observed !== item.hash) {
    item.category = 'content_mismatch';
    store.save(item, 'content_mismatch');
    return;
  }
  const deviations = new Set(item.deviations);
  if (meta.date !== item.meta.date) deviations.add('internal_date_changed');
  for (const flag of item.meta.flags.filter((f) => f !== '\\Recent'))
    if (!meta.flags.includes(flag)) deviations.add('flag_not_preserved:' + flag);
  for (const flag of meta.flags.filter((f) => f !== '\\Recent'))
    if (!item.meta.flags.includes(flag)) deviations.add('destination_extra_flag:' + flag);
  item.deviations = [...deviations];
  item.category = undefined;
  item.evidence = {
    folder: item.target,
    validity: view.validity,
    uid: meta.uid,
    hash: observed,
    size: raw.length,
    at: new Date().toISOString(),
    method: 'raw-sha256',
  };
  store.verified(migration, item);
}

async function reconcile(
  store: Store,
  item: Item,
  d: Reader,
  c: Config,
  view: View,
): Promise<void> {
  item.candidates = [];
  item.category = 'operator_resolution_required';
  // Even a unique matching hash cannot identify its writer in an active destination.
  if (item.baseline && item.baseline.validity === view.validity && item.hash) {
    try {
      const candidates = await d.scan(
        String(BigInt(view.next) - 1n),
        c.defaults.candidateLimit,
        item.baseline.next,
      );
      for (const meta of candidates) {
        if (meta.size !== item.meta.size) continue;
        const bytes = await d.raw(meta.uid, c.defaults.maxMessageBytes);
        if (hash(bytes) === item.hash)
          item.candidates.push({
            folder: item.target,
            validity: view.validity,
            uid: meta.uid,
            hash: item.hash,
            size: bytes.length,
            at: new Date().toISOString(),
            method: 'raw-sha256',
          });
      }
    } catch (e) {
      item.category = 'candidate_search_' + category(e);
    }
  }
  store.save(item, 'ambiguous');
}

export async function execute(
  c: Config,
  values: Map<Endpoint, string>,
  factory: Factory,
  store: Store,
  p: Plan,
  options: {
    verifyOnly?: boolean;
    existing?: boolean;
    stop?: () => boolean;
    progress?: (p: Progress) => void;
  } = {},
) {
  checkPlan(p, c);
  const stop = options.stop ?? (() => false),
    progress = options.progress ?? (() => {});
  const pass = store.begin(p, options.existing);
  const errors: string[] = [],
    newArrivals: unknown[] = [];
  let skipped = 0;
  // Recover intent before touching the network. A process crash may have followed remote commit.
  for (const item of store.items(p.migration))
    if (item.state === 'append_pending') {
      item.category = 'interrupted_append';
      store.save(item, 'ambiguous');
    }
  const workPairs = options.verifyOnly ? verificationPairs(c, store.items(p.migration)) : p.pairs;
  for (const pair of workPairs) {
    if (stop()) break;
    const m = c.mailboxes.find((m) => m.id === pair.id)!;
    const s = factory(m.source, values.get(m.source)!, false, c),
      d = factory(m.destination, values.get(m.destination)!, !options.verifyOnly, c);
    try {
      if (!options.verifyOnly) await s.connect();
      await d.connect();
      const destinationFolders = await d.list();
      for (const mapping of pair.mappings) {
        if (stop()) break;
        if (mapping.excluded) continue;
        const approvedUids = new Set(mapping.messages.map((m) => m.uid));
        const selected = store
          .items(p.migration)
          .filter(
            (i) =>
              i.mailbox === pair.id &&
              i.folder === mapping.source.path &&
              approvedUids.has(i.meta.uid),
          );
        if (!selected.length) continue;
        if (!options.verifyOnly) {
          const sourceView = await s.open(mapping.source.path);
          if (sourceView.validity !== mapping.source.validity) {
            for (const i of selected) {
              i.category = 'source_uidvalidity_changed';
              store.save(i, 'identity_changed');
            }
            errors.push(pair.id + ':source_uidvalidity_changed');
            continue;
          }
        }
        const known = destinationFolders.find((f) => f.path === mapping.target);
        const ledgerFolder = store.db
          .prepare(
            'SELECT destination_validity FROM folders WHERE migration=? AND mailbox=? AND source=?',
          )
          .get(p.migration, pair.id, mapping.source.path) as {
          destination_validity: string | null;
        };
        if (!known) {
          // A folder lost after a previous run is not automatically recreated.
          if (options.verifyOnly || ledgerFolder.destination_validity || mapping.existing) {
            for (const i of selected) {
              i.category = 'destination_folder_missing';
              store.save(i, 'identity_changed');
            }
            errors.push(pair.id + ':destination_folder_missing');
            continue;
          }
          await (d as Writer).create(mapping.target);
        }
        let view = await d.open(mapping.target);
        if (
          ledgerFolder.destination_validity &&
          ledgerFolder.destination_validity !== view.validity
        ) {
          for (const i of selected) {
            if (i.destination?.validity !== view.validity) {
              i.category = 'destination_uidvalidity_changed';
              store.save(i, 'identity_changed');
            }
          }
          errors.push(pair.id + ':destination_uidvalidity_changed');
          continue;
        }
        store.db
          .prepare(
            'UPDATE folders SET destination_validity=? WHERE migration=? AND mailbox=? AND source=?',
          )
          .run(view.validity, p.migration, pair.id, mapping.source.path);
        ledgerFolder.destination_validity = view.validity;
        for (const item of selected) {
          if (stop()) break;
          try {
            if (item.state === 'identity_changed') {
              errors.push(pair.id + ':identity_changed');
              continue;
            }
            if (item.destination) {
              if (item.state === 'verified' && !options.verifyOnly) {
                skipped++;
                continue;
              }
              await verifyItem(store, p.migration, item, d, view, c.defaults.maxMessageBytes);
              continue;
            }
            if (item.state === 'ambiguous' || item.state === 'appended_unverified') {
              await reconcile(store, item, d, c, view);
              continue;
            }
            if (options.verifyOnly) continue;
            if (!['discovered', 'prepared', 'retryable_failure'].includes(item.state)) continue;
            const current = await readRetry(() => s.meta(item.meta.uid), stop);
            if (!current) {
              item.category = 'source_missing';
              store.save(item, 'source_missing');
              continue;
            }
            const limit = Math.min(c.defaults.maxMessageBytes, d.appendLimit() ?? Infinity);
            if (current.size > limit) {
              item.category = 'quota_or_size';
              store.save(item, 'permanent_failure');
              continue;
            }
            if (!current.date) {
              item.category = 'missing_internal_date';
              store.save(item, 'permanent_failure');
              continue;
            }
            const bytes = await readRetry(() => s.raw(item.meta.uid, limit), stop);
            if ((await s.open(item.folder)).validity !== item.validity) {
              item.category = 'source_uidvalidity_changed';
              store.save(item, 'identity_changed');
              continue;
            }
            const rawHash = hash(bytes);
            if (item.hash && item.hash !== rawHash) throw new Fault('source_content_changed');
            item.hash = rawHash;
            item.meta = current;
            item.deviations = [];
            const flags = current.flags.filter((f) => {
              if (f === '\\Recent') return false;
              if (f === '\\Deleted') {
                item.deviations.push('deleted_flag_omitted');
                return false;
              }
              const supported =
                view.flags.includes(f) || (!f.startsWith('\\') && view.flags.includes('\\*'));
              if (!supported) item.deviations.push('unsupported_flag:' + f);
              return supported;
            });
            store.save(item, 'prepared');
            if (stop()) break;
            view = await d.open(mapping.target);
            if (
              view.validity !== ledgerFolder.destination_validity &&
              ledgerFolder.destination_validity
            ) {
              item.category = 'destination_uidvalidity_changed';
              store.save(item, 'identity_changed');
              throw new Fault('destination_uidvalidity_changed');
            }
            item.baseline = view;
            const attempt = store.intent(item);
            try {
              const result = await (d as Writer).append(item.target, bytes, flags, current.date);
              item.destination = result ?? undefined;
              item.category = result ? undefined : 'appenduid_unavailable';
              store.outcome(item, attempt, 'appended_unverified');
            } catch (e) {
              item.category = category(e);
              store.outcome(item, attempt, 'ambiguous');
              throw new Fault(item.category);
            }
            // No UIDPLUS is safe but needs explicit occurrence linking, even on a tagged success.
            if (item.destination)
              await verifyItem(store, p.migration, item, d, view, c.defaults.maxMessageBytes);
            else await reconcile(store, item, d, c, await d.open(item.target));
          } catch (e) {
            const cat = category(e);
            if (
              cat === 'state_failure' ||
              (!(e instanceof Fault) &&
                String((e as { code?: string }).code).startsWith('ERR_SQLITE'))
            )
              throw e;
            if (!['ambiguous', 'append_pending', 'identity_changed'].includes(item.state)) {
              item.category = cat;
              store.save(
                item,
                cat === 'source_missing'
                  ? 'source_missing'
                  : item.destination
                    ? 'retryable_failure'
                    : ['network'].includes(cat)
                      ? 'retryable_failure'
                      : 'permanent_failure',
              );
            }
            if (['quota_or_size', 'authentication', 'network', 'access_or_provider'].includes(cat))
              throw new Fault(cat);
          } finally {
            progress({
              mailbox: pair.id,
              item: item.id,
              state: item.state,
              bytes: item.evidence?.size,
            });
          }
        }
        if (!options.verifyOnly) {
          const end = await s.open(mapping.source.path);
          newArrivals.push({
            mailbox: pair.id,
            folder: mapping.source.path,
            boundary: mapping.boundary,
            observedNext: end.next,
            possibleNewArrivals: BigInt(end.next) > BigInt(mapping.boundary!) + 1n,
          });
        }
      }
      if (!options.verifyOnly) {
        const folders = await s.list();
        for (const folder of folders.filter(
          (f) => f.selectable && !pair.mappings.some((m) => m.source.path === f.path),
        ))
          newArrivals.push({
            mailbox: pair.id,
            folder: folder.path,
            kind: 'new_folder_outside_pass',
          });
      }
    } catch (e) {
      const cat = category(e);
      if (cat === 'state_failure' || String((e as { code?: string }).code).startsWith('ERR_SQLITE'))
        throw e;
      errors.push(pair.id + ':' + cat);
      store.event(p.migration, cat, { mailbox: pair.id });
    } finally {
      await s.close();
      await d.close();
    }
  }
  store.finish(pass, p.migration, { errors, interrupted: stop(), skipped, newArrivals });
  return report(store, p.migration);
}

export async function resolveItem(
  c: Config,
  values: Map<Endpoint, string>,
  factory: Factory,
  store: Store,
  migration: string,
  id: string,
  action: { link?: string; appendAgain?: boolean; retryRead?: boolean },
) {
  const item = store.items(migration).find((i) => i.id === id);
  if (!item) throw new Fault('unknown_item', 3);
  if (action.retryRead) {
    if (!['permanent_failure', 'source_missing'].includes(item.state) || item.destination)
      throw new Fault('retry_read_requires_pre_append_failure', 3);
    store.event(migration, 'operator_retry_read', { item: id });
    item.category = undefined;
    store.save(item, 'discovered');
    return;
  }
  if (action.appendAgain) {
    if (item.state !== 'ambiguous' || item.destination)
      throw new Fault('append_again_only_for_uncertain_unlinked_writes', 3);
    store.event(migration, 'operator_accepted_duplicate_risk', { item: id });
    item.candidates = [];
    item.category = undefined;
    store.save(item, 'discovered');
    return;
  }
  if (!action.link || !/^\d+$/.test(action.link) || !item.hash)
    throw new Fault('link_requires_uid_and_source_hash', 3);
  if (
    ![
      'ambiguous',
      'identity_changed',
      'destination_missing',
      'content_mismatch',
      'appended_unverified',
    ].includes(item.state)
  )
    throw new Fault('item_not_resolvable', 3);
  if (item.category === 'source_uidvalidity_changed')
    throw new Fault('source_reset_requires_folder_reconciliation', 3);
  const pair = c.mailboxes.find((m) => m.id === item.mailbox)!;
  const d = factory(pair.destination, values.get(pair.destination)!, false, c);
  try {
    await d.connect();
    const view = await d.open(item.target);
    const meta = await d.meta(action.link);
    if (!meta) throw new Fault('destination_missing');
    const raw = await d.raw(action.link, c.defaults.maxMessageBytes);
    if (hash(raw) !== item.hash) throw new Fault('content_mismatch');
    const claimed = store.db
      .prepare(
        'SELECT item FROM evidence WHERE migration=? AND mailbox=? AND folder=? AND validity=? AND uid=? AND item<>?',
      )
      .get(migration, item.mailbox, item.target, view.validity, action.link, item.id);
    if (claimed) throw new Fault('destination_occurrence_already_claimed', 3);
    item.destination = { validity: view.validity, uid: action.link };
    store.tx(() => {
      store.save(item, 'appended_unverified');
      store.event(migration, 'operator_link', { item: id, destination: item.destination });
    });
    await verifyItem(store, migration, item, d, view, c.defaults.maxMessageBytes);
    const others = store
      .items(migration)
      .filter((i) => i.mailbox === item.mailbox && i.folder === item.folder);
    if (others.every((i) => i.state === 'verified' && i.destination?.validity === view.validity))
      store.db
        .prepare(
          'UPDATE folders SET destination_validity=? WHERE migration=? AND mailbox=? AND source=?',
        )
        .run(view.validity, migration, item.mailbox, item.folder);
  } finally {
    await d.close();
  }
}
