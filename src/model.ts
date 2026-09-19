export type Meta = { uid: string; size: number; date: string | null; flags: string[] };
export type ScanProgress = {
  phase: 'searching' | 'fetching';
  scanned: number;
  total?: number;
  bytes: number;
};
export type ScanControl = { signal?: AbortSignal; progress?: (value: ScanProgress) => void };
export type Folder = {
  path: string;
  delimiter: string;
  special?: string;
  selectable: boolean;
  validity?: string;
  next?: string;
  count?: number;
};
export type View = { validity: string; next: string; flags: string[]; count: number };
export type Evidence = {
  folder: string;
  validity: string;
  uid: string;
  hash: string;
  size: number;
  at: string;
  method: 'raw-sha256';
};
export type State =
  | 'discovered'
  | 'prepared'
  | 'append_pending'
  | 'appended_unverified'
  | 'verified'
  | 'retryable_failure'
  | 'permanent_failure'
  | 'ambiguous'
  | 'source_missing'
  | 'content_mismatch'
  | 'destination_missing'
  | 'identity_changed';
export type Item = {
  id: string;
  mailbox: string;
  folder: string;
  target: string;
  validity: string;
  meta: Meta;
  state: State;
  hash?: string;
  evidence?: Evidence;
  destination?: { validity: string; uid: string };
  baseline?: View;
  deviations: string[];
  category?: string;
  candidates?: Evidence[];
};
export type Mapping = {
  source: Folder;
  target: string;
  existing?: Folder;
  excluded?: string;
  messages: Meta[];
  boundary?: string;
  bytes: number;
  oversized: number;
};
export type PairPlan = {
  id: string;
  source: object;
  destination: object;
  mappings: Mapping[];
  capabilities: { source: string[]; destination: string[] };
  quota: unknown;
  appendLimit: number | null;
  warnings: string[];
};
export type Plan = {
  version: 1;
  id: string;
  migration: string;
  created: string;
  discoveredAt?: string;
  fingerprint: string;
  hash: string;
  scope: { mailbox?: string; pilot?: number };
  pairs: PairPlan[];
  blockers: string[];
  limitations: string[];
};
// Kept only in backend memory. The inventory retains every scanned UID, including
// messages outside a pilot; plans select from it without mutating it.
export type DiscoverySnapshot = {
  id: string;
  created: string;
  configuration: string;
  inventory: Plan;
  destinations: Record<string, Folder[]>;
};
export interface Reader {
  connect(): Promise<void>;
  close(): Promise<void>;
  list(): Promise<Folder[]>;
  open(folder: string): Promise<View>;
  scan(boundary: string, ceiling: number, from?: string, control?: ScanControl): Promise<Meta[]>;
  meta(uid: string): Promise<Meta | null>;
  raw(uid: string, ceiling: number): Promise<Buffer>;
  capabilities(): string[];
  quota(): Promise<unknown>;
  appendLimit(): number | null;
}
export interface Writer extends Reader {
  create(folder: string): Promise<void>;
  append(
    folder: string,
    bytes: Buffer,
    flags: string[],
    date: string,
  ): Promise<{ validity: string; uid: string } | null>;
}
