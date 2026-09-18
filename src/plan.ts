import { randomUUID } from 'node:crypto';
import { type Config, type Endpoint, fingerprint, identity } from './config.js';
import { hash, canonical, Fault } from './safety.js';
import type { Folder, Mapping, Plan, Reader } from './model.js';
import type { Factory } from './transport.js';
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
export async function makePlan(
  c: Config,
  values: Map<Endpoint, string>,
  factory: Factory,
  scope: Plan['scope'] = {},
  migration: string = randomUUID(),
): Promise<Plan> {
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
  let remaining = c.defaults.maxOccurrences,
    pilot = scope.pilot ?? Infinity;
  for (const m of c.mailboxes.filter((m) => !scope.mailbox || m.id === scope.mailbox)) {
    const s = factory(m.source, values.get(m.source)!, false, c),
      d = factory(m.destination, values.get(m.destination)!, false, c);
    try {
      await s.connect();
      await d.connect();
      const sf = await s.list(),
        df = await d.list();
      const map = mappings(sf, df, m.folders, c.defaults.includeSpamAndTrash);
      if (
        (s.capabilities().includes('X-GM-EXT-1') ||
          sf.some((f) => ['\\All', '\\Flagged'].includes(f.special ?? ''))) &&
        m.folders.labelStrategy !== 'explicit-folders'
      )
        p.blockers.push(m.id + ':explicit_label_strategy_required');
      for (const f of map) {
        if (f.excluded) continue;
        const v = await s.open(f.source.path);
        f.source.validity = v.validity;
        f.boundary = String(BigInt(v.next) - 1n);
        const messages = await s.scan(f.boundary, remaining);
        remaining -= messages.length;
        f.bytes = messages.reduce((n, m) => n + m.size, 0);
        f.messages = messages.slice(0, pilot);
        pilot -= f.messages.length;
        f.oversized = f.messages.filter(
          (msg) => msg.size > Math.min(c.defaults.maxMessageBytes, d.appendLimit() ?? Infinity),
        ).length;
        f.source.count = messages.length;
      }
      p.pairs.push({
        id: m.id,
        source: identity(m.source),
        destination: identity(m.destination),
        mappings: map,
        capabilities: { source: s.capabilities(), destination: d.capabilities() },
        quota: await d.quota(),
        appendLimit: d.appendLimit(),
        warnings: [
          'endpoint_alias_identity_unconfirmed',
          'no_future_delivery_guarantee',
          ...(scope.pilot ? ['pilot_excludes_remaining_occurrences'] : []),
        ],
      });
    } finally {
      await s.close();
      await d.close();
    }
  }
  return seal(p);
}
