import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { type Config, type Endpoint, identity } from './config.js';
import type { Factory } from './transport.js';
import type { Reader, Folder, Meta, ScanControl, View } from './model.js';
import { DiscoveryControl } from './discovery.js';
import { Fault, hash } from './safety.js';

const safe = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v));
const uid = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((v) => BigInt(v) <= 4294967295n);
const validity = z.string().regex(/^[1-9]\d{0,19}$/);
const messageSchema = z
  .object({
    uid,
    size: z
      .number()
      .int()
      .min(0)
      .max(100 * 1024 * 1024),
    date: z.string().datetime().nullable(),
    flags: z.array(safe).max(100),
    file: z.string().regex(/^messages\/[0-9]+-[1-9][0-9]*\.eml$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal('mail-migrate-archive'),
    version: z.literal(1),
    complete: z.literal(true),
    id: z.string().uuid(),
    created: z.string().datetime(),
    source: z
      .object({
        host: safe,
        port: z.number().int().positive(),
        tlsMode: z.enum(['implicit', 'starttls']),
        username: safe,
      })
      .strict(),
    exclusions: z.array(safe).max(10000),
    folders: z
      .array(
        z
          .object({
            path: safe,
            delimiter: z.string().max(10),
            special: safe.optional(),
            validity,
            next: z
              .string()
              .regex(/^[1-9]\d{0,9}$/)
              .refine((v) => BigInt(v) <= 4294967296n),
            messages: z.array(messageSchema).max(100000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type ArchiveManifest = z.infer<typeof manifestSchema>;
export type OpenArchive = { directory: string; digest: string; manifest: ArchiveManifest };
export type ArchiveProgress = {
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  folder?: string;
  messages: number;
  bytes: number;
  directory: string;
  error?: string;
};

// Never follow links from a manifest or allocate from an unbounded file size.
function readBounded(directory: string, file: string, limit: number): Buffer {
  const path = join(directory, file);
  const rel = relative(directory, realpathSync(path));
  if (rel.startsWith('..') || isAbsolute(rel) || lstatSync(path).isSymbolicLink())
    throw new Fault('archive_unsafe_path');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Fault('archive_file_too_large_or_invalid');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!n) break;
      offset += n;
    }
    if (offset !== stat.size) throw new Fault('archive_file_changed');
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
export function openArchive(path: string): OpenArchive {
  try {
    const directory = realpathSync(resolve(path));
    if (existsSync(join(directory, 'INCOMPLETE.txt'))) throw new Fault('archive_incomplete');
    if (!lstatSync(directory).isDirectory()) throw new Fault('archive_folder_required');
    const bytes = readBounded(directory, 'archive.json', 32 * 1024 * 1024);
    const parsed = manifestSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) throw new Fault('archive_manifest_invalid');
    const manifest = parsed.data;
    const names = new Set<string>(),
      files = new Set<string>();
    let count = 0;
    for (const folder of manifest.folders) {
      if (names.has(folder.path)) throw new Fault('archive_duplicate_folder');
      names.add(folder.path);
      const ids = new Set<string>();
      for (const message of folder.messages) {
        if (
          ids.has(message.uid) ||
          files.has(message.file) ||
          BigInt(message.uid) >= BigInt(folder.next)
        )
          throw new Fault('archive_duplicate_or_invalid_message');
        ids.add(message.uid);
        files.add(message.file);
        if (++count > 100000) throw new Fault('archive_inventory_limit');
      }
    }
    return { directory, digest: hash(bytes), manifest };
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault('archive_cannot_open_complete_manifest');
  }
}
export function archiveSummary(a: OpenArchive) {
  return {
    id: a.manifest.id,
    directory: a.directory,
    created: a.manifest.created,
    source: a.manifest.source,
    folders: a.manifest.folders.map((f) => ({
      path: f.path,
      messages: f.messages.length,
      bytes: f.messages.reduce((n, m) => n + m.size, 0),
    })),
    exclusions: a.manifest.exclusions,
  };
}
export function archiveSource(a: OpenArchive): Endpoint {
  return {
    host: 'local-archive.invalid',
    port: 993,
    tlsMode: 'implicit',
    username: `${a.manifest.id}:${a.digest}`,
    auth: { type: 'password', secretRef: 'env:LOCAL_ARCHIVE' },
  };
}
function durableWrite(path: string, value: Buffer | string) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function exportArchive(
  c: Config,
  source: Endpoint,
  secret: string,
  factory: Factory,
  directory: string,
  exclude: string[],
  onProgress: (p: ArchiveProgress) => void,
  signal?: AbortSignal,
) {
  const target = resolve(directory);
  const reader = factory(source, secret, false, c);
  const control = new DiscoveryControl(c.defaults.timeoutSeconds * 1000, signal);
  control.add(reader);
  const progress: ArchiveProgress = { status: 'running', messages: 0, bytes: 0, directory: target };
  try {
    // A new directory only: never overwrite an archive or unrelated local files.
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Fault('archive_target_already_exists');
      throw new Fault('archive_target_parent_missing_or_not_writable');
    }
    mkdirSync(join(target, 'messages'), { mode: 0o700 });
    durableWrite(
      join(target, 'INCOMPLETE.txt'),
      'This export is incomplete. It cannot be imported. Keep it for investigation or retry into a new folder.\n',
    );
    await control.read(() => reader.connect());
    const folders = await control.read(() => reader.list());
    const manifest: ArchiveManifest = {
      format: 'mail-migrate-archive',
      version: 1,
      complete: true,
      id: randomUUID(),
      created: new Date().toISOString(),
      source: identity(source),
      exclusions: exclude,
      folders: [],
    };
    let remaining = c.defaults.maxOccurrences;
    for (const [index, folder] of folders.entries()) {
      control.check();
      if (!folder.selectable || exclude.includes(folder.path)) continue;
      progress.folder = folder.path;
      onProgress({ ...progress });
      const view = await control.read(() => reader.open(folder.path));
      if (view.count > remaining) throw new Fault('occurrence_ceiling');
      const meta = await control.read(() =>
        reader.scan(String(BigInt(view.next) - 1n), remaining, '1', {
          signal: control.signal,
          progress: () => control.touch(),
        }),
      );
      remaining -= meta.length;
      const archived: ArchiveManifest['folders'][number] = {
        path: folder.path,
        delimiter: folder.delimiter,
        special: folder.special,
        validity: view.validity,
        next: view.next,
        messages: [],
      };
      for (const message of meta) {
        control.check();
        if (message.size > c.defaults.maxMessageBytes) throw new Fault('quota_or_size');
        const raw = await control.read(() => reader.raw(message.uid, c.defaults.maxMessageBytes));
        if (raw.length !== message.size) throw new Fault('source_message_changed');
        const file = `messages/${index}-${message.uid}.eml`;
        durableWrite(join(target, file), raw);
        archived.messages.push({ ...message, file, sha256: hash(raw) });
        progress.messages++;
        progress.bytes += raw.length;
        onProgress({ ...progress });
      }
      if ((await control.read(() => reader.open(folder.path))).validity !== view.validity)
        throw new Fault('source_uidvalidity_changed');
      manifest.folders.push(archived);
    }
    control.check();
    const encoded = JSON.stringify(manifestSchema.parse(manifest), null, 2) + '\n';
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024)
      throw new Fault('archive_manifest_too_large');
    durableWrite(join(target, 'archive.json.tmp'), encoded);
    renameSync(join(target, 'archive.json.tmp'), join(target, 'archive.json'));
    unlinkSync(join(target, 'INCOMPLETE.txt'));
    onProgress({ ...progress, status: 'complete' });
  } finally {
    await reader.close();
    control.dispose();
  }
}

export class ArchiveReader implements Reader {
  private selected?: ArchiveManifest['folders'][number];
  constructor(private archive: OpenArchive) {}
  async connect() {
    if (openArchive(this.archive.directory).digest !== this.archive.digest)
      throw new Fault('archive_manifest_changed');
  }
  async close() {}
  async list(): Promise<Folder[]> {
    return this.archive.manifest.folders.map((f) => ({
      path: f.path,
      delimiter: f.delimiter,
      special: f.special,
      selectable: true,
      validity: f.validity,
      next: f.next,
      count: f.messages.length,
    }));
  }
  async open(path: string): Promise<View> {
    const folder = this.archive.manifest.folders.find((f) => f.path === path);
    if (!folder) throw new Fault('folder_missing');
    this.selected = folder;
    return {
      validity: folder.validity,
      next: folder.next,
      count: folder.messages.length,
      flags: ['\\*'],
    };
  }
  async scan(
    boundary: string,
    ceiling: number,
    from = '1',
    control?: ScanControl,
  ): Promise<Meta[]> {
    control?.signal?.throwIfAborted();
    const messages = this.selected!.messages.filter(
      (m) => BigInt(m.uid) >= BigInt(from) && BigInt(m.uid) <= BigInt(boundary),
    );
    if (messages.length > ceiling) throw new Fault('occurrence_ceiling');
    return messages.map(({ uid, size, date, flags }) => ({ uid, size, date, flags: [...flags] }));
  }
  async meta(uid: string): Promise<Meta | null> {
    const m = this.selected!.messages.find((m) => m.uid === uid);
    return m ? { uid: m.uid, size: m.size, date: m.date, flags: [...m.flags] } : null;
  }
  async raw(uid: string, ceiling: number): Promise<Buffer> {
    const m = this.selected!.messages.find((m) => m.uid === uid);
    if (!m) throw new Fault('source_missing');
    if (m.size > ceiling) throw new Fault('quota_or_size');
    try {
      const raw = readBounded(this.archive.directory, m.file, ceiling);
      if (raw.length !== m.size || hash(raw) !== m.sha256)
        throw new Fault('archive_checksum_mismatch');
      return raw;
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault('archive_message_missing_or_unreadable');
    }
  }
  capabilities() {
    return ['IMAP4rev1'];
  }
  async quota() {
    return { status: 'not_applicable' };
  }
  appendLimit() {
    return null;
  }
}
