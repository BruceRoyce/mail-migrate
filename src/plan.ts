import { randomUUID } from 'node:crypto';
import { type Config, type Endpoint, fingerprint, identity } from './config.js';
import { hash, canonical, Fault } from './safety.js';
import type { DiscoverySnapshot, Folder, Mapping, Plan } from './model.js';
import type { Factory } from './transport.js';
import { DiscoveryControl, type DiscoveryOptions, type DiscoveryProgress } from './discovery.js';
export function mappings(
  source: Folder[],
  destination: Folder[],
  policy: Config['mailboxes'][number]['folders'],
  includeTrash: boolean,
): Mapping[] {
  const delimiter =
    destination.find((f) => f.path.toUpperCase() === 'INBOX')?.delimiter ??
    destination.find((f) => f.delimiter)?.delimiter ??
    '';
  const used = new Set<string>();
  return source.map((f) => {
    const excluded = !f.selectable
      ? 'non_selectable'
      : policy.exclude.includes(f.path)
        ? 'explicit_exclusion'
        : !includeTrash && ['\\Junk', '\\Trash'].includes(f.special ?? '')
          ? 'spam_trash_excluded'
          : undefined;
    let target = policy.overrides[f.path];
    if (!target) {
      const specials = f.special
        ? destination.filter((d) => d.special === f.special && d.selectable)
        : [];
      if (specials.length > 1 && !excluded) throw new Fault('ambiguous_special_folder');
      if (specials.length === 1) target = specials[0]!.path;
      else {
        const parts = f.delimiter ? f.path.split(f.delimiter) : [f.path];
        if (
          !excluded &&
          ((parts.length > 1 && !delimiter) ||
            (delimiter !== f.delimiter && parts.some((p) => delimiter && p.includes(delimiter))))
        )
          throw new Fault('delimiter_collision');
        target = parts.join(delimiter);
      }
    }
    if (/[\x00-\x1f\x7f]/.test(target)) throw new Fault('unsafe_folder_name');
    const key = target.normalize('NFC').toLowerCase();
    const existing = destination.find((d) => d.path === target);
    if (!excluded) {
      if (
        used.has(key) ||
        destination.some(
          (d) => d.path !== target && d.path.normalize('NFC').toLowerCase() === key,
        ) ||
        (existing && !existing.selectable)
      )
        throw new Fault('mapping_collision');
      used.add(key);
    }
    return { source: f, target, existing, excluded, messages: [], bytes: 0, oversized: 0 };
  });
}
export const seal = (p: Plan): Plan => ({ ...p, hash: hash(canonical({ ...p, hash: '' })) });
export function checkPlan(p: Plan, c: Config): void {
  if (
    p.version !== 1 ||
    p.hash !== seal(p).hash ||
    p.fingerprint !== fingerprint(c) ||
    p.blockers.length
  )
    throw new Fault('plan_invalid_or_blocked', 3);
  const ids = new Set<string>();
  for (const pair of p.pairs) {
    const configured = c.mailboxes.find((m) => m.id === pair.id);
    if (
      !configured ||
      ids.has(pair.id) ||
      canonical(pair.source) !== canonical(identity(configured.source)) ||
      canonical(pair.destination) !== canonical(identity(configured.destination))
    )
      throw new Fault('plan_endpoint_mismatch', 3);
    ids.add(pair.id);
  }
}
export async function discoverSnapshot(
  c: Config,
  values: Map<Endpoint, string>,
  factory: Factory,
  scope: Plan['scope'] = {},
  migration: string = randomUUID(),
  options: DiscoveryOptions = {},
): Promise<DiscoverySnapshot> {
  if (scope.mailbox && !c.mailboxes.some((m) => m.id === scope.mailbox))
    throw new Fault('unknown_mailbox', 3);
  const p: Plan = {
    version: 1,
    id: randomUUID(),
    migration,
    created: new Date().toISOString(),
    fingerprint: fingerprint(c),
    hash: '',
    scope,
    pairs: [],
    blockers: [],
    limitations: [
      'Folder scans are not an atomic account snapshot.',
      'Quotas and APPENDLIMIT may be unknown; preflight does not prove write access.',
      'Different hostnames may alias one server; operator must confirm independent accounts.',
      'Pilot scope is not full mailbox coverage.',
      'Flags are checked at transfer and verification; unsupported metadata is reported.',
    ],
  };
  let remaining = c.defaults.maxOccurrences;
  const destinations: Record<string, Folder[]> = {};
  const control = new DiscoveryControl(
    options.operationTimeoutMs ?? c.defaults.timeoutSeconds * 1000,
    options.signal,
  );
  let progress: DiscoveryProgress = {
    phase: 'starting',
    foldersDone: 0,
    foldersTotal: 0,
    messages: 0,
    bytes: 0,
    folderScanned: 0,
  };
  const emit = (next: Partial<DiscoveryProgress>) => {
    control.check();
    progress = { ...progress, ...next };
    control.touch();
    options.progress?.({ ...progress });
  };
  try {
    for (const m of c.mailboxes.filter((m) => !scope.mailbox || m.id === scope.mailbox)) {
      control.check();
      const s = factory(m.source, values.get(m.source)!, false, c),
        d = factory(m.destination, values.get(m.destination)!, false, c);
      control.add(s);
      control.add(d);
      try {
        emit({
          phase: 'connecting_source',
          mailbox: m.id,
          folder: undefined,
          folderScanned: 0,
          folderMessages: undefined,
        });
        await control.read(() => s.connect());
        emit({ phase: 'connecting_destination' });
        await control.read(() => d.connect());
        emit({ phase: 'listing_source' });
        const sf = await control.read(() => s.list());
        emit({ phase: 'listing_destination' });
        const df = await control.read(() => d.list());
        destinations[m.id] = df;
        const map = mappings(sf, df, m.folders, c.defaults.includeSpamAndTrash);
        emit({ foldersTotal: progress.foldersTotal + map.filter((f) => !f.excluded).length });
        if (
          (s.capabilities().includes('X-GM-EXT-1') ||
            sf.some((f) => ['\\All', '\\Flagged'].includes(f.special ?? ''))) &&
          m.folders.labelStrategy !== 'explicit-folders'
        )
          p.blockers.push(m.id + ':explicit_label_strategy_required');
        for (const f of map) {
          if (f.excluded) continue;
          emit({
            phase: 'opening_folder',
            folder: f.source.path,
            folderScanned: 0,
            folderMessages: f.source.count,
          });
          const v = await control.read(() => s.open(f.source.path));
          f.source.validity = v.validity;
          f.boundary = String(BigInt(v.next) - 1n);
          if (v.count > remaining)
            throw new Fault('occurrence_ceiling', 3, [
              {
                path: 'config.defaults.maxOccurrences',
                message:
                  'The observed folder count exceeds the remaining inventory allowance. Increase the inventory ceiling and memory allowance together, or explicitly exclude folders before retrying. A pilot still inventories the full selected folder scope.',
              },
            ]);
          const scannedBefore = progress.messages,
            bytesBefore = progress.bytes;
          emit({ phase: 'searching', folderMessages: v.count });
          const messages = await control.read(() =>
            s.scan(f.boundary!, remaining, '1', {
              signal: control.signal,
              progress: (value) =>
                emit({
                  phase: value.phase,
                  folderScanned: value.scanned,
                  folderMessages: value.total ?? v.count,
                  messages: scannedBefore + value.scanned,
                  bytes: bytesBefore + value.bytes,
                }),
            }),
          );
          const after = await control.read(() => s.open(f.source.path));
          if (after.validity !== v.validity) throw new Fault('source_uidvalidity_changed');
          remaining -= messages.length;
          f.bytes = messages.reduce((n, m) => n + m.size, 0);
          f.messages = messages;
          f.oversized = f.messages.filter(
            (msg) => msg.size > Math.min(c.defaults.maxMessageBytes, d.appendLimit() ?? Infinity),
          ).length;
          f.source.count = messages.length;
          emit({
            foldersDone: progress.foldersDone + 1,
            messages: scannedBefore + messages.length,
            bytes: bytesBefore + f.bytes,
            folderScanned: messages.length,
          });
        }
        emit({ phase: 'quota', folder: undefined, folderScanned: 0, folderMessages: undefined });
        p.pairs.push({
          id: m.id,
          source: identity(m.source),
          destination: identity(m.destination),
          mappings: map,
          capabilities: { source: s.capabilities(), destination: d.capabilities() },
          quota: await control.read(() => d.quota()),
          appendLimit: d.appendLimit(),
          warnings: [
            'endpoint_alias_identity_unconfirmed',
            'no_future_delivery_guarantee',
            ...(scope.pilot ? ['pilot_excludes_remaining_occurrences'] : []),
          ],
        });
      } finally {
        await Promise.allSettled([s.close(), d.close()]);
        control.remove(s);
        control.remove(d);
      }
    }
    emit({ phase: 'complete' });
    return {
      id: randomUUID(),
      created: new Date().toISOString(),
      configuration: snapshotConfiguration(c),
      inventory: p,
      destinations,
    };
  } finally {
    control.dispose();
  }
}

function snapshotConfiguration(c: Config): string {
  return fingerprint({
    ...c,
    mailboxes: c.mailboxes.map((m) => ({
      ...m,
      folders: { exclude: [], overrides: {}, labelStrategy: 'unresolved' },
    })),
  });
}

export function planFromSnapshot(
  c: Config,
  snapshot: DiscoverySnapshot,
  scope: Plan['scope'] = {},
  migration = snapshot.inventory.migration,
): Plan {
  if (snapshot.configuration !== snapshotConfiguration(c))
    throw new Fault('discovery_settings_changed');
  if (scope.mailbox && !snapshot.inventory.pairs.some((p) => p.id === scope.mailbox))
    throw new Fault('discovery_scope_missing');
  const plan: Plan = {
    ...snapshot.inventory,
    id: randomUUID(),
    created: new Date().toISOString(),
    discoveredAt: snapshot.created,
    migration,
    fingerprint: fingerprint(c),
    hash: '',
    scope: { ...scope },
    pairs: [],
    blockers: [],
  };
  let remaining = scope.pilot ?? Infinity;
  for (const original of snapshot.inventory.pairs.filter(
    (p) => !scope.mailbox || p.id === scope.mailbox,
  )) {
    const configured = c.mailboxes.find((m) => m.id === original.id)!;
    const mapped = mappings(
      original.mappings.map((m) => ({ ...m.source })),
      snapshot.destinations[original.id]!,
      configured.folders,
      c.defaults.includeSpamAndTrash,
    );
    if (
      (original.capabilities.source.includes('X-GM-EXT-1') ||
        original.mappings.some((m) => ['\\All', '\\Flagged'].includes(m.source.special ?? ''))) &&
      configured.folders.labelStrategy !== 'explicit-folders'
    )
      plan.blockers.push(original.id + ':explicit_label_strategy_required');
    for (const folder of mapped) {
      if (folder.excluded) continue;
      const scanned = original.mappings.find((m) => m.source.path === folder.source.path)!;
      if (scanned.boundary === undefined) {
        plan.blockers.push(`${original.id}:refresh_discovery_required:${folder.source.path}`);
        continue;
      }
      folder.boundary = scanned.boundary;
      folder.messages = scanned.messages.slice(0, remaining);
      remaining -= folder.messages.length;
      folder.bytes = folder.messages.reduce((sum, message) => sum + message.size, 0);
      folder.oversized = folder.messages.filter(
        (m) => m.size > Math.min(c.defaults.maxMessageBytes, original.appendLimit ?? Infinity),
      ).length;
    }
    plan.pairs.push({
      ...original,
      mappings: mapped,
      warnings: [
        ...original.warnings.filter((w) => w !== 'pilot_excludes_remaining_occurrences'),
        ...(scope.pilot ? ['pilot_excludes_remaining_occurrences'] : []),
      ],
    });
  }
  return seal(plan);
}

export async function makePlan(
  c: Config,
  values: Map<Endpoint, string>,
  factory: Factory,
  scope: Plan['scope'] = {},
  migration: string = randomUUID(),
  options: DiscoveryOptions = {},
): Promise<Plan> {
  return planFromSnapshot(
    c,
    await discoverSnapshot(c, values, factory, scope, migration, options),
    scope,
    migration,
  );
}
