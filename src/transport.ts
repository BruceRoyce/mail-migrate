import { ImapFlow } from 'imapflow';
import { readFileSync } from 'node:fs';
import type { Config, Endpoint } from './config.js';
import type { Reader, Writer, Folder, View, Meta } from './model.js';
import { Fault } from './safety.js';
export type Factory = (
  endpoint: Endpoint,
  secret: string,
  writable: boolean,
  config: Config,
) => Reader | Writer;
export class ImapReader implements Reader {
  protected client: ImapFlow;
  constructor(
    endpoint: Endpoint,
    secret: string,
    config: Config,
    protected writable = false,
  ) {
    this.client = new ImapFlow({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.tlsMode === 'implicit',
      ...(endpoint.tlsMode === 'starttls' ? { doSTARTTLS: true } : {}),
      auth: { user: endpoint.username, pass: secret },
      tls: {
        rejectUnauthorized: true,
        ...(endpoint.caFile ? { ca: readFileSync(endpoint.caFile) } : {}),
      },
      logger: false,
      logRaw: false,
      emitLogs: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableBinary: true,
      connectionTimeout: config.defaults.timeoutSeconds * 1000,
      greetingTimeout: config.defaults.timeoutSeconds * 1000,
      socketTimeout: config.defaults.timeoutSeconds * 1000,
    });
    this.client.on('error', () => {}); // Errors are returned by operations; never emit server text.
  }
  async connect(): Promise<void> {
    await this.client.connect();
  }
  async close(): Promise<void> {
    this.client.close();
  } // No CLOSE, EXPUNGE or cleanup writes.
  async list(): Promise<Folder[]> {
    return (
      await this.client.list({ statusQuery: { messages: true, uidNext: true, uidValidity: true } })
    ).map((f) => ({
      path: f.path,
      delimiter: f.delimiter ?? '',
      special: f.specialUse,
      selectable: !f.flags.has('\\Noselect'),
      ...(f.status
        ? {
            count: f.status.messages,
            next: f.status.uidNext?.toString(),
            validity: f.status.uidValidity?.toString(),
          }
        : {}),
    }));
  }
  async open(folder: string): Promise<View> {
    const m = await this.client.mailboxOpen(folder, { readOnly: !this.writable });
    return {
      validity: m.uidValidity.toString(),
      next: m.uidNext.toString(),
      flags: [...(m.permanentFlags ?? [])],
      count: m.exists,
    };
  }
  async scan(boundary: string, ceiling: number, from = '1'): Promise<Meta[]> {
    const end = Number(boundary);
    if (!Number.isSafeInteger(end) || end < 0 || end > 4294967295) throw new Fault('invalid_uid');
    if (!/^\d+$/.test(from) || Number(from) < 1 || Number(from) > 4294967296)
      throw new Fault('invalid_uid');
    const result: Meta[] = [];
    // UID ranges bound each response, including sparse folders. No nested commands in fetch iterators.
    for (let low = Number(from); low <= end; low += 10000) {
      const uids = await this.client.search(
        { uid: `${low}:${Math.min(end, low + 9999)}` },
        { uid: true },
      );
      if (!Array.isArray(uids)) throw new Fault('search_failed');
      if (result.length + uids.length > ceiling) throw new Fault('occurrence_ceiling');
      for (const uid of uids) {
        if (uid < low || uid > Math.min(end, low + 9999)) throw new Fault('invalid_uid');
        const m = await this.meta(String(uid));
        result.push(m ?? { uid: String(uid), size: 0, date: null, flags: [] });
      }
    }
    return result;
  }
  async meta(uid: string): Promise<Meta | null> {
    const m = await this.client.fetchOne(
      uid,
      { uid: true, size: true, internalDate: true, flags: true },
      { uid: true },
    );
    if (!m) return null;
    if (String(m.uid) !== uid) throw new Fault('unexpected_fetch_uid');
    return {
      uid: String(m.uid),
      size: m.size ?? 0,
      date: m.internalDate ? new Date(m.internalDate).toISOString() : null,
      flags: [...(m.flags ?? [])],
    };
  }
  async raw(uid: string, ceiling: number): Promise<Buffer> {
    const m = await this.meta(uid);
    if (!m) throw new Fault('source_missing');
    if (m.size > ceiling) throw new Fault('quota_or_size');
    const { content } = await this.client.download(uid, undefined, {
      uid: true,
      maxBytes: ceiling + 1,
      chunkSize: 64 * 1024,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > ceiling) {
        content.destroy();
        throw new Fault('quota_or_size');
      }
      chunks.push(b);
    }
    if (size !== m.size) throw new Fault('size_changed_or_truncated');
    return Buffer.concat(chunks, size);
  }
  capabilities(): string[] {
    return [...this.client.capabilities.keys()].sort();
  }
  async quota(): Promise<unknown> {
    if (!this.client.capabilities.has('QUOTA')) return { status: 'unknown' };
    try {
      const q = await this.client.getQuota('INBOX');
      return q
        ? JSON.parse(JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
        : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }
  appendLimit(): number | null {
    const n = this.client.capabilities.get('APPENDLIMIT');
    return typeof n === 'number' ? n : null;
  }
}
export class ImapWriter extends ImapReader implements Writer {
  constructor(e: Endpoint, s: string, c: Config) {
    super(e, s, c, true);
  }
  async create(folder: string): Promise<void> {
    await this.client.mailboxCreate(folder);
  }
  async append(
    folder: string,
    bytes: Buffer,
    flags: string[],
    date: string,
  ): Promise<{ validity: string; uid: string } | null> {
    const result = await this.client.append(folder, bytes, flags, new Date(date));
    return result && result.uid && result.uidValidity
      ? { validity: result.uidValidity.toString(), uid: String(result.uid) }
      : null;
  }
}
export const imapFactory: Factory = (e, s, w, c) =>
  w ? new ImapWriter(e, s, c) : new ImapReader(e, s, c);
