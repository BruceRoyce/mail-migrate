import { z } from 'zod';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, parse as parsePath, relative, isAbsolute } from 'node:path';
import { parse } from 'yaml';
import { canonical, hash, Fault } from './safety.js';
const safe = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s));
const endpoint = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535),
    tlsMode: z.enum(['implicit', 'starttls']),
    username: safe,
    caFile: safe.optional(),
    auth: z
      .object({
        type: z.literal('password'),
        secretRef: z.string().regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/),
      })
      .strict(),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    stateDirectory: safe,
    reportDirectory: safe,
    defaults: z
      .object({
        mailboxConcurrency: z.literal(1).default(1),
        messageConcurrency: z.literal(1).default(1),
        verification: z.literal('full').default('full'),
        sourceWrites: z.literal(false).default(false),
        existingDestinationPolicy: z.literal('preserve').default('preserve'),
        includeSpamAndTrash: z.boolean().default(true),
        maxMessageBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024)
          .default(25 * 1024 * 1024),
        memoryBudgetMiB: z.number().int().min(256).max(8192).default(512),
        maxOccurrences: z.number().int().min(1).max(100000).default(5000),
        timeoutSeconds: z.number().int().min(5).max(300).default(60),
        candidateLimit: z.number().int().min(1).max(1000).default(100),
      })
      .strict()
      .default(
        () =>
          ({
            mailboxConcurrency: 1,
            messageConcurrency: 1,
            verification: 'full',
            sourceWrites: false,
            existingDestinationPolicy: 'preserve',
            includeSpamAndTrash: true,
            maxMessageBytes: 26214400,
            memoryBudgetMiB: 512,
            maxOccurrences: 5000,
            timeoutSeconds: 60,
            candidateLimit: 100,
          }) as const,
      ),
    mailboxes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            source: endpoint,
            destination: endpoint,
            folders: z
              .object({
                exclude: z.array(safe).default([]),
                overrides: z.record(safe, safe).default({}),
                labelStrategy: z.enum(['unresolved', 'explicit-folders']).default('unresolved'),
              })
              .strict()
              .default(() => ({
                exclude: [] as string[],
                overrides: {},
                labelStrategy: 'unresolved' as const,
              })),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Config = z.infer<typeof schema>;
export type Endpoint = Config['mailboxes'][number]['source'];
export const identity = (e: Endpoint) => ({
  host: e.host.toLowerCase().replace(/\.$/, ''),
  port: e.port,
  tlsMode: e.tlsMode,
  username: e.username,
});
function physical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : resolve(physical(parent), relative(parent, path));
}
export function validateConfig(data: unknown, base = process.cwd()): Config {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Fault('invalid_configuration', 3);
  const c = parsed.data;
  c.stateDirectory = physical(resolve(base, c.stateDirectory));
  c.reportDirectory = physical(resolve(base, c.reportDirectory));
  for (const path of [c.stateDirectory, c.reportDirectory])
    if (
      path === parsePath(path).root ||
      path === physical(base) ||
      /(^|[\\/])(\.git|\.codex|node_modules)([\\/]|$)/i.test(path)
    )
      throw new Fault('unsafe_directory', 3);
  const inside = (a: string, b: string) => {
    const r = relative(a, b);
    return !r || (!r.startsWith('..') && !isAbsolute(r));
  };
  if (inside(c.stateDirectory, c.reportDirectory) || inside(c.reportDirectory, c.stateDirectory))
    throw new Fault('overlapping_directories', 3);
  if (
    c.defaults.memoryBudgetMiB * 1024 * 1024 <
    192 * 1024 * 1024 + 6 * c.defaults.maxMessageBytes + 16384 * c.defaults.maxOccurrences
  )
    throw new Fault('memory_budget_too_small', 3);
  const ids = new Set<string>(),
    targets = new Set<string>(),
    sources = new Set<string>();
  for (const m of c.mailboxes) {
    if (ids.has(m.id)) throw new Fault('duplicate_mailbox_id', 3);
    ids.add(m.id);
    const s = canonical(identity(m.source)),
      d = canonical(identity(m.destination));
    if (
      s === d ||
      (m.source.host.toLowerCase() === m.destination.host.toLowerCase() &&
        m.source.username.toLowerCase() === m.destination.username.toLowerCase())
    )
      throw new Fault('self_copy', 3);
    if (targets.has(d) || sources.has(s)) throw new Fault('overlapping_mailbox_jobs', 3);
    targets.add(d);
    sources.add(s);
    for (const e of [m.source, m.destination]) {
      if (e.caFile) e.caFile = resolve(base, e.caFile);
      if (e.auth.secretRef.startsWith('file:'))
        e.auth.secretRef = 'file:' + resolve(base, e.auth.secretRef.slice(5));
    }
  }
  for (const s of sources) if (targets.has(s)) throw new Fault('source_is_destination', 3);
  return c;
}
export function loadConfig(path: string): Config {
  try {
    return validateConfig(parse(readFileSync(path, 'utf8')), dirname(resolve(path)));
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault('invalid_configuration', 3);
  }
}
export function fingerprint(c: Config): string {
  return hash(
    canonical({
      version: c.version,
      defaults: c.defaults,
      mailboxes: c.mailboxes.map((m) => ({
        id: m.id,
        source: identity(m.source),
        destination: identity(m.destination),
        folders: m.folders,
      })),
    }),
  );
}
export function secrets(c: Config): Map<Endpoint, string> {
  const values = new Map<Endpoint, string>();
  for (const m of c.mailboxes)
    for (const e of [m.source, m.destination]) {
      let value: string | undefined;
      try {
        value = e.auth.secretRef.startsWith('env:')
          ? process.env[e.auth.secretRef.slice(4)]
          : readFileSync(e.auth.secretRef.slice(5), 'utf8').replace(/\r?\n$/, '');
      } catch {
        throw new Fault('missing_secret', 3);
      }
      if (!value) throw new Fault('missing_secret', 3);
      if (e.caFile)
        try {
          readFileSync(e.caFile);
        } catch {
          throw new Fault('invalid_ca_file', 3);
        }
      values.set(e, value);
    }
  return values;
}
