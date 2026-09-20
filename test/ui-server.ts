import { writeFileSync } from 'node:fs';
import { createWeb } from '../src/server.js';
import { fixture, Mailbox } from './fake.js';
import type { Factory } from '../src/transport.js';
const f = fixture();
f.source.folders.get('INBOX')!.add();
const folder = new Mailbox();
folder.add();
f.source.folders.set('Clients/日本語', folder);
const factory: Factory = (endpoint, secret, writable, config) => {
  const reader = f.factory(endpoint, secret, writable, config);
  if (endpoint.host === 'old.example') {
    const list = reader.list.bind(reader);
    reader.list = async () => [
      ...(await list()),
      { path: 'Container only', delimiter: '/', selectable: false },
    ];
  }
  if (endpoint.host === 'old.example' && endpoint.username === 'slow@business.example') {
    const scan = reader.scan.bind(reader);
    reader.scan = async (boundary, ceiling, from, control) => {
      control?.progress?.({ phase: 'fetching', scanned: 0, total: 1, bytes: 0 });
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(control?.signal?.reason);
        };
        const timer = setTimeout(() => {
          control?.signal?.removeEventListener('abort', abort);
          resolve();
        }, 10000);
        control?.signal?.addEventListener('abort', abort, { once: true });
        if (control?.signal?.aborted) abort();
      });
      return scan(boundary, ceiling, from, control);
    };
  }
  return reader;
};
const w = await createWeb(8788, f.c.stateDirectory, f.c.reportDirectory, factory);
writeFileSync('test/ui-session.json', JSON.stringify({ token: w.token, archiveRoot: f.base }));
await w.app.listen({ port: 8788, host: '127.0.0.1' });
