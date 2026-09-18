import type { Reader } from './model.js';
import { Fault } from './safety.js';

export type DiscoveryProgress = {
  phase:
    | 'starting'
    | 'connecting_source'
    | 'connecting_destination'
    | 'listing_source'
    | 'listing_destination'
    | 'opening_folder'
    | 'searching'
    | 'fetching'
    | 'quota'
    | 'complete'
    | 'cancelling';
  mailbox?: string;
  folder?: string;
  foldersDone: number;
  foldersTotal: number;
  messages: number;
  bytes: number;
  folderScanned: number;
  folderMessages?: number;
};
export type Discovery = DiscoveryProgress & {
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
};
export type DiscoveryOptions = {
  signal?: AbortSignal;
  progress?: (progress: DiscoveryProgress) => void;
  operationTimeoutMs?: number;
};

// A timeout aborts the whole read-only plan and closes its connections. Progress
// from a completed scan batch resets this deadline; TCP keepalives do not.
export class DiscoveryControl {
  private controller = new AbortController();
  private readers = new Set<Reader>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private externalAbort = () => this.controller.abort(new Fault('discovery_cancelled', 130));
  private closeOnAbort = () => {
    void Promise.allSettled([...this.readers].map((reader) => reader.close()));
  };
  constructor(
    private timeoutMs: number,
    private external?: AbortSignal,
  ) {
    external?.addEventListener('abort', this.externalAbort, { once: true });
    this.signal.addEventListener('abort', this.closeOnAbort, { once: true });
    if (external?.aborted) this.externalAbort();
  }
  get signal() {
    return this.controller.signal;
  }
  add(reader: Reader) {
    this.readers.add(reader);
  }
  remove(reader: Reader) {
    this.readers.delete(reader);
  }
  check() {
    if (this.signal.aborted) throw this.signal.reason;
  }
  touch() {
    if (this.timer === undefined || this.signal.aborted) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.controller.abort(new Fault('discovery_timeout')),
      this.timeoutMs,
    );
  }
  async read<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    let rejectAbort: (() => void) | undefined;
    this.timer = setTimeout(
      () => this.controller.abort(new Fault('discovery_timeout')),
      this.timeoutMs,
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.check();
          return action();
        }),
        aborted,
      ]);
      this.check();
      return result;
    } catch (error) {
      this.check();
      throw error;
    } finally {
      clearTimeout(this.timer);
      this.timer = undefined;
      if (rejectAbort) this.signal.removeEventListener('abort', rejectAbort);
    }
  }
  dispose() {
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.externalAbort);
    this.signal.removeEventListener('abort', this.closeOnAbort);
  }
}
