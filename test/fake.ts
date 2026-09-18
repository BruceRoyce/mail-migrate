import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Reader, Writer, Folder, Meta, View } from '../src/model.js';
import type { Factory } from '../src/transport.js';
import { validateConfig, type Config, type Endpoint } from '../src/config.js';
import { Fault } from '../src/safety.js';
export const raw = Buffer.from(
  'From: sender@business.example\r\nTo: receiver@business.example\r\nSubject: synthetic\r\n\r\nTest body\r\n',
);
type Message = { bytes: Buffer; flags: string[]; date: string };
export class Mailbox {
  validity = '9007199254740993';
  next = 1;
  messages = new Map<string, Message>();
  flags = ['\\Seen', '\\Answered', '\\Flagged', '\\Draft', '\\*'];
  add(bytes = raw, flags: string[] = []) {
    const uid = String(this.next++);
    this.messages.set(uid, { bytes: Buffer.from(bytes), flags, date: '2020-01-02T03:04:05.000Z' });
    return uid;
  }
}
export class Server {
  folders = new Map<string, Mailbox>([['INBOX', new Mailbox()]]);
  caps = ['IMAP4rev1', 'UIDPLUS'];
  writes: string[] = [];
  fault?: 'before' | 'after' | 'no_uid' | 'corrupt' | 'quota' | 'date';
  connectError?: string;
  limit: number | null = null;
  vanish = false;
  onAppend?: () => void;
}
export class FakeReader implements Reader {
  selected?: Mailbox;
  constructor(
    public server: Server,
    public writable = false,
  ) {}
  async connect() {
    if (this.server.connectError) throw new Fault(this.server.connectError);
  }
  async close() {}
  async list(): Promise<Folder[]> {
    return [...this.server.folders].map(([path, m]) => ({
      path,
      delimiter: '/',
      selectable: true,
      validity: m.validity,
      next: String(m.next),
      count: m.messages.size,
    }));
  }
  async open(path: string): Promise<View> {
    const m = this.server.folders.get(path);
    if (!m) throw new Fault('folder_missing');
    this.selected = m;
    return { validity: m.validity, next: String(m.next), flags: m.flags, count: m.messages.size };
  }
  async scan(boundary: string, ceiling: number, from = '1'): Promise<Meta[]> {
    const ids = [...this.selected!.messages.keys()].filter(
      (id) => BigInt(id) <= BigInt(boundary) && BigInt(id) >= BigInt(from),
    );
    if (ids.length > ceiling) throw new Fault('occurrence_ceiling');
    return Promise.all(ids.map((id) => this.meta(id) as Promise<Meta>));
  }
  async meta(uid: string): Promise<Meta | null> {
    if (this.server.vanish) {
      this.selected!.messages.delete(uid);
      this.server.vanish = false;
    }
    const m = this.selected!.messages.get(uid);
    return m ? { uid, size: m.bytes.length, date: m.date, flags: [...m.flags] } : null;
  }
  async raw(uid: string, ceiling: number) {
    const m = this.selected!.messages.get(uid);
    if (!m) throw new Fault('source_missing');
    if (m.bytes.length > ceiling) throw new Fault('quota_or_size');
    return Buffer.from(m.bytes);
  }
  capabilities() {
    return this.server.caps;
  }
  async quota() {
    return { status: 'unknown' };
  }
  appendLimit() {
    return this.server.limit;
  }
}
export class FakeWriter extends FakeReader implements Writer {
  async create(path: string) {
    this.server.writes.push('create');
    this.server.folders.set(path, new Mailbox());
  }
  async append(folder: string, bytes: Buffer, flags: string[], date: string) {
    this.server.writes.push('append');
    if (this.server.fault === 'before') throw new Fault('network');
    if (this.server.fault === 'quota') throw new Fault('quota_or_size');
    const m = this.server.folders.get(folder)!;
    const uid = m.add(
      this.server.fault === 'corrupt' ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes,
      flags,
    );
    m.messages.get(uid)!.date = this.server.fault === 'date' ? '2021-01-01T00:00:00.000Z' : date;
    this.server.onAppend?.();
    if (this.server.fault === 'after') throw new Fault('network');
    if (this.server.fault === 'no_uid') return null;
    return { validity: m.validity, uid };
  }
}
export function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mail-migrate-'));
  const c = validateConfig({
    version: 1,
    stateDirectory: join(base, 'state'),
    reportDirectory: join(base, 'reports'),
    mailboxes: [
      {
        id: 'test',
        source: {
          host: 'old.example',
          port: 993,
          tlsMode: 'implicit',
          username: 'a@business.example',
          auth: { type: 'password', secretRef: 'env:SOURCE' },
        },
        destination: {
          host: 'new.example',
          port: 993,
          tlsMode: 'implicit',
          username: 'a@business.example',
          auth: { type: 'password', secretRef: 'env:DEST' },
        },
        folders: {},
      },
    ],
  });
  const source = new Server(),
    destination = new Server();
  const values = new Map<Endpoint, string>([
    [c.mailboxes[0]!.source, 'synthetic'],
    [c.mailboxes[0]!.destination, 'synthetic'],
  ]);
  const factory: Factory = (e, _s, w) => {
    const server = e.host === 'old.example' ? source : destination;
    return w ? new FakeWriter(server, true) : new FakeReader(server);
  };
  return { c, source, destination, values, factory, base };
}
