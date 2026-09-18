import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import {
  getSessionToken,
  setSessionToken,
  SessionExpired,
  rejectSession,
  tokenFromLink,
  takeFragment,
} from './session';
type Endpoint = {
  host: string;
  port: number;
  tlsMode: 'implicit' | 'starttls';
  username: string;
  password: string;
  caFile?: string;
};
type Pair = {
  id: string;
  source: Endpoint;
  destination: Endpoint;
  folders: {
    exclude: string[];
    overrides: Record<string, string>;
    labelStrategy: 'unresolved' | 'explicit-folders';
  };
};
type Plan = {
  id: string;
  hash: string;
  migration: string;
  blockers: string[];
  scope: { pilot?: number };
  pairs: {
    id: string;
    source: Endpoint;
    destination: Endpoint;
    appendLimit: number | null;
    quota: unknown;
    warnings: string[];
    mappings: {
      source: { path: string; count?: number };
      target: string;
      excluded?: string;
      existing?: object;
      messages: unknown[];
      bytes: number;
      oversized: number;
    }[];
  }[];
};
type Report = {
  migration: string;
  status: string;
  unresolved: number;
  occurrences: number;
  verifiedBytes: number;
  counts: Record<string, number>;
  items: {
    id: string;
    mailbox: string;
    folder: string;
    state: string;
    category?: string;
    deviations: string[];
    candidates?: { uid: string }[];
  }[];
};
type Session = {
  running: boolean;
  plan?: Plan;
  report?: Report;
  error?: string;
  progress: { mailbox: string; item: string; state: string }[];
  discovery?: Discovery;
};
type Discovery = {
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  phase: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  mailbox?: string;
  folder?: string;
  foldersDone: number;
  foldersTotal: number;
  messages: number;
  bytes: number;
  folderScanned: number;
  folderMessages?: number;
  error?: string;
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const token = getSessionToken();
  if (!token) throw new SessionExpired();
  const r = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Session-Token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: ['session', 'plan', 'cancel'].includes(path) ? AbortSignal.timeout(15000) : undefined,
  });
  const data = await r.json();
  if (!r.ok && data.error === 'session_rejected') throw rejectSession(token);
  if (!r.ok) {
    const details = Array.isArray(data.issues)
      ? data.issues
          .map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`)
          .join('\n')
      : '';
    throw new Error(details || data.error || 'request_failed');
  }
  return data as T;
}
const endpoint = (): Endpoint => ({
  host: '',
  port: 993,
  tlsMode: 'implicit',
  username: '',
  password: '',
});
const pair = (n: number): Pair => ({
  id: 'mailbox-' + n,
  source: endpoint(),
  destination: endpoint(),
  folders: { exclude: [], overrides: {}, labelStrategy: 'unresolved' },
});
function App() {
  const [pairs, setPairs] = useState<Pair[]>([pair(1)]),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [tests, setTests] = useState<{ mailbox: string; side: string; ok: boolean; error?: string }[]>(
      [],
    ),
    [session, setSession] = useState<Session>({ running: false, progress: [] }),
    [confirm, setConfirm] = useState(false),
    [pilot, setPilot] = useState(''),
    [migration, setMigration] = useState(''),
    [limit, setLimit] = useState(25),
    [budget, setBudget] = useState(512),
    [maxOccurrences, setMaxOccurrences] = useState(5000),
    [overrideDrafts, setOverrideDrafts] = useState<Record<number, string>>({}),
    [needsSession, setNeedsSession] = useState(!getSessionToken()),
    [sessionLink, setSessionLink] = useState(''),
    [sessionRevision, setSessionRevision] = useState(0),
    [startingPlan, setStartingPlan] = useState(false),
    [discoveryError, setDiscoveryError] = useState('');
  const plan = session.plan,
    report = session.report;
  const discovering = startingPlan || session.discovery?.status === 'running';
  const disabled = busy || session.running || needsSession || discovering;
  function handleFailure(e: unknown) {
    if (e instanceof SessionExpired) {
      if (e.obsolete) return;
      setNeedsSession(true);
      setReady(false);
      setConfirm(false);
      setError('');
    } else setError((e as Error).message);
  }
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      handleFailure(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (needsSession || !getSessionToken()) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      api<Session>('session')
        .then((s) => {
          if (live) setSession(s);
        })
        .catch((e) => {
          if (live) handleFailure(e);
        })
        .finally(() => {
          if (live) timer = setTimeout(poll, 1000);
        });
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [needsSession, sessionRevision]);
  async function reconnect(link: string) {
    const candidate = tokenFromLink(link);
    setSessionToken(candidate);
    const current = await api<Session>('session');
    setSession(current);
    setNeedsSession(false);
    setSessionLink('');
    setError('');
    setReady(false);
    setConfirm(false);
    setTests([]);
    setSessionRevision((n) => n + 1);
  }
  useEffect(() => {
    const onFragment = () => {
      const value = takeFragment();
      if (value !== undefined) void perform(() => reconnect(value));
    };
    window.addEventListener('hashchange', onFragment);
    return () => window.removeEventListener('hashchange', onFragment);
  }, []);
  function edit(index: number, change: Partial<Pair>) {
    setPairs((old) => old.map((p, i) => (i === index ? { ...p, ...change } : p)));
    setReady(false);
    setConfirm(false);
  }
  async function download(path: string, name: string) {
    const value = await api(path);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <main>
      <header>
        <span className="eyebrow">LOCAL · SOURCE READ-ONLY</span>
        <h1>Mail migration</h1>
        <p>
          Connect both hosts, review the folders, then approve the copy. Every verified message has
          destination evidence.
        </p>
      </header>
      <nav aria-label="Workflow">
        <span>1 · Connect</span>
        <span>2 · Review</span>
        <span>3 · Confirm</span>
        <span>4 · Verify</span>
      </nav>
      {needsSession && (
        <section aria-labelledby="session-heading">
          <h2 id="session-heading">Reconnect to the local app</h2>
          <p>
            The session is missing or has expired, usually because the backend restarted. Your
            current form entries are still here.
          </p>
          <p>
            Paste the full private link printed in the current PowerShell window, including the part
            after #. Keep this link private.
          </p>
          <label>
            Private session link from PowerShell
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={sessionLink}
              onChange={(e) => setSessionLink(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !sessionLink.trim()}
            onClick={() => void perform(() => reconnect(sessionLink))}
          >
            Reconnect this tab
          </button>
          <p>Reconnecting does not contact mail servers or start a migration.</p>
        </section>
      )}
      {(error || session.error) && (
        <div role="alert" className="error">
          {error || session.error}
        </div>
      )}
      <section>
        <h2>1. Test your connections</h2>
        <p>
          Credentials stay in the local backend’s memory. No mailbox passwords are saved to disk.
          Use an app password if required by your provider.
        </p>
        <p>
          This form uses the settings entered below. It does not load migration.yaml; that file is
          used by CLI commands.
        </p>
        <fieldset disabled={disabled}>
          <legend className="sr-only">Connection settings</legend>
          {pairs.map((p, index) => (
            <article key={index}>
              <div className="row">
                <label>
                  Mailbox identifier
                  <input
                    aria-label={`Mailbox identifier ${index + 1}`}
                    value={p.id}
                    onChange={(e) => edit(index, { id: e.target.value })}
                  />
                  <small>
                    Short label, e.g. support. Letters, digits, underscores and hyphens only.
                  </small>
                </label>
                {pairs.length > 1 && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setPairs(pairs.filter((_, i) => i !== index));
                      setOverrideDrafts({});
                      setReady(false);
                    }}
                  >
                    Remove pair
                  </button>
                )}
              </div>
              <div className="columns">
                {(['source', 'destination'] as const).map((side) => (
                  <div key={side}>
                    <h3>{side === 'source' ? 'Source · old host' : 'Destination · new host'}</h3>
                    {(['host', 'username', 'password'] as const).map((field) => (
                      <label key={field}>
                        {field === 'host'
                          ? 'IMAP hostname'
                          : field === 'username'
                            ? 'Username'
                            : 'Password / app password'}
                        <input
                          aria-label={`${p.id} ${side} ${field}`}
                          type={field === 'password' ? 'password' : 'text'}
                          autoComplete="off"
                          spellCheck={false}
                          value={p[side][field]}
                          onChange={(e) =>
                            edit(index, { [side]: { ...p[side], [field]: e.target.value } })
                          }
                        />
                      </label>
                    ))}
                    <div className="columns">
                      <label>
                        Port
                        <input
                          aria-label={`${p.id} ${side} port`}
                          type="number"
                          value={p[side].port}
                          onChange={(e) =>
                            edit(index, { [side]: { ...p[side], port: Number(e.target.value) } })
                          }
                        />
                      </label>
                      <label>
                        TLS mode
                        <select
                          value={p[side].tlsMode}
                          onChange={(e) =>
                            edit(index, {
                              [side]: {
                                ...p[side],
                                tlsMode: e.target.value as Endpoint['tlsMode'],
                              },
                            })
                          }
                        >
                          <option value="implicit">Implicit TLS</option>
                          <option value="starttls">Mandatory STARTTLS</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      Custom CA file (optional, local path)
                      <input
                        value={p[side].caFile ?? ''}
                        onChange={(e) =>
                          edit(index, {
                            [side]: { ...p[side], caFile: e.target.value || undefined },
                          })
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>
              <details>
                <summary>Folder policy</summary>
                <label>
                  Exclude exact folder names (one per line)
                  <textarea
                    value={p.folders.exclude.join('\n')}
                    onChange={(e) =>
                      edit(index, {
                        folders: {
                          ...p.folders,
                          exclude: e.target.value.split('\n').filter(Boolean),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Folder overrides (JSON object)
                  <textarea
                    value={overrideDrafts[index] ?? JSON.stringify(p.folders.overrides)}
                    onChange={(e) => {
                      setOverrideDrafts((d) => ({ ...d, [index]: e.target.value }));
                      setReady(false);
                      setConfirm(false);
                    }}
                    onBlur={(e) => {
                      try {
                        const overrides = JSON.parse(e.target.value) as Record<string, string>;
                        if (
                          Array.isArray(overrides) ||
                          typeof overrides !== 'object' ||
                          overrides === null ||
                          Object.values(overrides).some((v) => typeof v !== 'string')
                        )
                          throw Error();
                        edit(index, { folders: { ...p.folders, overrides } });
                      } catch {
                        setError(
                          'Folder overrides must be a JSON object of source names to destination names.',
                        );
                      }
                    }}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={p.folders.labelStrategy === 'explicit-folders'}
                    onChange={(e) =>
                      edit(index, {
                        folders: {
                          ...p.folders,
                          labelStrategy: e.target.checked ? 'explicit-folders' : 'unresolved',
                        },
                      })
                    }
                  />
                  I reviewed virtual / label folders and accept the selected physical-copy scope.
                </label>
              </details>
            </article>
          ))}
          <div className="row">
            <button
              className="secondary"
              onClick={() => {
                setPairs([...pairs, pair(pairs.length + 1)]);
                setReady(false);
              }}
            >
              Add mailbox pair
            </button>
            <label>
              Message ceiling (MiB)
              <input
                type="number"
                min="1"
                max="100"
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setReady(false);
                }}
              />
            </label>
            <label>
              Memory allowance (MiB)
              <input
                type="number"
                min="256"
                value={budget}
                onChange={(e) => {
                  setBudget(Number(e.target.value));
                  setReady(false);
                }}
              />
            </label>
            <label>
              Inventory occurrence ceiling
              <input
                type="number"
                min="1"
                max="100000"
                value={maxOccurrences}
                onChange={(e) => {
                  setMaxOccurrences(Number(e.target.value));
                  setReady(false);
                  setConfirm(false);
                }}
              />
            </label>
          </div>
          <button
            onClick={() =>
              void perform(async () => {
                const checkedPairs = pairs.map((p, index) => {
                  const overrides = JSON.parse(
                    overrideDrafts[index] ?? JSON.stringify(p.folders.overrides),
                  );
                  if (
                    !overrides ||
                    Array.isArray(overrides) ||
                    typeof overrides !== 'object' ||
                    Object.values(overrides).some((v) => typeof v !== 'string')
                  )
                    throw new Error('Folder overrides must map source names to destination names.');
                  return { ...p, folders: { ...p.folders, overrides } };
                });
                const result = await api<{ ready: boolean; results: typeof tests }>('test', {
                  mailboxes: checkedPairs,
                  maxMessageMiB: limit,
                  memoryBudgetMiB: budget,
                  maxOccurrences,
                });
                setTests(result.results);
                setReady(result.ready);
                setSession({ running: false, progress: [] });
                setConfirm(false);
              })
            }
          >
            Test both connections
          </button>
        </fieldset>
        <div aria-live="polite">
          {tests.map((r) => (
            <p key={r.mailbox + r.side} className={r.ok ? 'success' : 'error'}>
              {r.mailbox} · {r.side}:{' '}
              {r.ok ? 'TLS, authentication and folder access passed' : r.error}
            </p>
          ))}
        </div>
      </section>
      <section>
        <h2>2. Review the migration plan</h2>
        <p>
          Discovery is read-only. Existing destination mail will be preserved. New source
          occurrences are copied even if matching mail already exists.
        </p>
        <div className="row">
          <label>
            Pilot message limit (blank = all)
            <input
              type="number"
              min="1"
              value={pilot}
              disabled={disabled}
              onChange={(e) => {
                setPilot(e.target.value);
                setConfirm(false);
              }}
            />
          </label>
          <label>
            Existing migration ID (resume / catch-up)
            <input
              value={migration}
              disabled={disabled}
              onChange={(e) => {
                setMigration(e.target.value);
                setConfirm(false);
              }}
            />
          </label>
        </div>
        <div className="row">
          <button
            disabled={!ready || disabled}
            onClick={() =>
              void perform(async () => {
                setStartingPlan(true);
                setConfirm(false);
                setDiscoveryError('');
                setSession((s) => ({ ...s, plan: undefined, discovery: undefined }));
                try {
                  const result = await api<{ discovery: Discovery }>('plan', {
                    ...(pilot ? { pilot: Number(pilot) } : {}),
                    ...(migration ? { migration } : {}),
                  });
                  setSession((s) => ({
                    ...s,
                    discovery: result.discovery,
                    plan: undefined,
                    report: undefined,
                  }));
                } catch (e) {
                  setDiscoveryError(
                    e instanceof SessionExpired
                      ? 'Reconnect to the local app before retrying discovery.'
                      : (e as Error).message,
                  );
                  throw e;
                } finally {
                  setStartingPlan(false);
                }
              })
            }
          >
            {discovering ? 'Discovering folders…' : 'Discover folders & build plan'}
          </button>
          <button
            className="secondary"
            disabled={!ready || !migration || disabled}
            onClick={() =>
              void perform(async () => {
                const loaded = await api<{ plan: Plan; report: Report }>('load', { migration });
                setSession((s) => ({ ...s, ...loaded }));
                setConfirm(false);
              })
            }
          >
            Load saved migration
          </button>
        </div>
        {discoveryError && (
          <p role="alert" className="error">
            {discoveryError}
          </p>
        )}
        {(startingPlan || session.discovery) && (
          <DiscoveryStatus
            value={session.discovery}
            starting={startingPlan}
            cancelDisabled={busy || needsSession}
            onCancel={() =>
              void perform(async () => {
                await api('cancel', {});
                setSession((s) => ({
                  ...s,
                  discovery:
                    s.discovery?.status === 'running'
                      ? { ...s.discovery, phase: 'cancelling' }
                      : s.discovery,
                }));
              })
            }
          />
        )}
        {plan && (
          <>
            <p className="mono">
              Migration: {plan.migration}
              <br />
              Plan: {plan.id}
            </p>
            {plan.scope.pilot && (
              <p className="warning">
                Pilot scope: at most {plan.scope.pilot} messages. This is not complete mailbox
                coverage.
              </p>
            )}
            {plan.blockers.map((b) => (
              <p className="error" key={b}>
                {b}
              </p>
            ))}
            {plan.pairs.map((p) => (
              <div key={p.id}>
                <h3>{p.id}</h3>
                <p>
                  {p.source.username} @ {p.source.host}:{p.source.port} → {p.destination.username} @{' '}
                  {p.destination.host}:{p.destination.port}
                </p>
                <p>
                  Destination APPEND limit:{' '}
                  {p.appendLimit === null ? 'unknown' : `${p.appendLimit} bytes`}. Quota:{' '}
                  <code>{JSON.stringify(p.quota)}</code>
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Source folder</th>
                        <th>Destination</th>
                        <th>Observed</th>
                        <th>Selected</th>
                        <th>Estimated bytes</th>
                        <th>Over size limit</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.mappings.map((m, i) => (
                        <tr key={i}>
                          <td>{m.source.path}</td>
                          <td>{m.target}</td>
                          <td>{m.source.count ?? 'unknown'}</td>
                          <td>{m.messages.length}</td>
                          <td>{m.bytes.toLocaleString()}</td>
                          <td>{m.oversized}</td>
                          <td>
                            {m.excluded ??
                              (m.existing ? 'Append; preserve existing' : 'Create and append')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            <button
              className="secondary"
              onClick={() => void perform(() => download('plan/download', 'migration-plan.json'))}
            >
              Download private plan
            </button>
          </>
        )}
      </section>
      <section>
        <h2>3. Confirm the copy</h2>
        <p>
          Read-only tests cannot establish that every future write will succeed. Confirm that these
          are independent source and destination accounts, even if hostnames differ.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={confirm}
            disabled={!ready || !plan || disabled}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          I reviewed this plan’s accounts, folders and scope. I approve creating required
          destination folders and copying the selected messages.
        </label>
        <div className="row">
          <button
            disabled={!ready || !plan || !confirm || !!plan.blockers.length || disabled}
            onClick={() =>
              void perform(async () => {
                await api('run', {
                  hash: plan!.hash,
                  confirm: true,
                  mode: migration ? 'resume' : 'run',
                });
                setSession((s) => ({ ...s, running: true }));
                setConfirm(false);
              })
            }
          >
            {migration ? 'Resume / run catch-up' : 'Start migration'}
          </button>
          <button
            className="secondary"
            disabled={!ready || !plan || disabled}
            onClick={() =>
              void perform(async () => {
                await api('run', { hash: plan!.hash, confirm: true, mode: 'verify' });
                setSession((s) => ({ ...s, running: true }));
              })
            }
          >
            Reverify destination (read-only)
          </button>
          {session.running && (
            <button
              className="secondary"
              onClick={() =>
                void perform(async () => {
                  await api('cancel', {});
                })
              }
            >
              Stop after current operation
            </button>
          )}
        </div>
      </section>
      <section>
        <h2>4. Progress &amp; evidence</h2>
        <p aria-live="polite">
          {discovering
            ? 'Discovering folders. See progress in the plan review above.'
            : session.running
              ? 'Migration running. Keep the PowerShell backend open.'
              : busy
                ? 'Working…'
                : 'Ready.'}
        </p>
        <ul className="progress">
          {session.progress.slice(-8).map((p, i) => (
            <li key={i}>
              {p.mailbox} · {p.item.slice(0, 12)} · {p.state}
            </li>
          ))}
        </ul>
        {report && (
          <>
            <h3>{report.status.replaceAll('_', ' ')}</h3>
            <p>
              {report.occurrences} recorded occurrences · {report.unresolved} unresolved ·{' '}
              {report.verifiedBytes.toLocaleString()} verified bytes
            </p>
            <p className="mono">{report.migration}</p>
            <button
              className="secondary"
              onClick={() => void perform(() => download('report', 'migration-report.json'))}
            >
              Download private report
            </button>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Mailbox / folder</th>
                    <th>Item</th>
                    <th>Outcome</th>
                    <th>Evidence / resolution</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items
                    .filter((i) => i.state !== 'verified' || i.deviations.length)
                    .map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.mailbox}
                          <br />
                          {i.folder}
                        </td>
                        <td className="mono">{i.id.slice(0, 12)}</td>
                        <td>
                          {i.state}
                          <br />
                          {i.category}
                          <br />
                          {i.deviations.join(', ')}
                        </td>
                        <td>
                          <Resolution
                            item={i.id}
                            candidates={i.candidates?.map((c) => c.uid) ?? []}
                            disabled={disabled}
                            onResolve={(link, appendAgain) =>
                              void perform(async () => {
                                const r = await api<Report>('resolve', {
                                  migration: report.migration,
                                  item: i.id,
                                  ...(link ? { link } : {}),
                                  ...(appendAgain
                                    ? { appendAgain: true, acceptDuplicateRisk: true }
                                    : {}),
                                });
                                setSession((s) => ({ ...s, report: r }));
                              })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <footer>
        No source deletion · No SMTP · No telemetry · Full raw-content verification
        <br />
        Reports contain sensitive mailbox metadata. Completion is limited to the recorded scope and
        observation window.
      </footer>
    </main>
  );
}
function DiscoveryStatus({
  value,
  starting,
  onCancel,
  cancelDisabled,
}: {
  value?: Discovery;
  starting: boolean;
  onCancel: () => void;
  cancelDisabled: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const active = starting || value?.status === 'running';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const phases: Record<string, string> = {
    starting: 'Starting discovery',
    connecting_source: 'Connecting to the source host',
    connecting_destination: 'Connecting to the destination host',
    listing_source: 'Listing source folders',
    listing_destination: 'Listing destination folders',
    opening_folder: 'Opening source folder',
    searching: 'Finding message UIDs',
    fetching: 'Reading message metadata',
    quota: 'Checking destination quota',
    complete: 'Discovery complete',
    cancelling: 'Cancelling discovery',
  };
  const problems: Record<string, string> = {
    discovery_timeout:
      'Discovery stopped because a read made no progress before its timeout. Check the connection and retry.',
    occurrence_ceiling:
      'This inventory exceeds the configured occurrence ceiling. Increase the inventory ceiling and memory allowance together, or exclude folders. A pilot still inventories all selected folders.',
    source_uidvalidity_changed:
      'The source folder identity changed during discovery. Rebuild the plan before proceeding.',
  };
  const elapsed = value
    ? Math.max(
        0,
        Math.floor(
          ((value.finishedAt ? Date.parse(value.finishedAt) : now) - Date.parse(value.startedAt)) /
            1000,
        ),
      )
    : 0;
  return (
    <div className="discovery-status" aria-label="Folder discovery progress">
      <div role="status" aria-live="polite">
        <strong>
          {starting
            ? 'Starting discovery…'
            : value?.status === 'cancelled'
              ? 'Discovery cancelled'
              : value?.status === 'failed'
                ? 'Discovery failed'
                : (phases[value?.phase ?? 'starting'] ?? 'Discovering folders')}
        </strong>
        {value?.mailbox && (
          <p>
            {value.mailbox}
            {value.folder ? ` · ${value.folder}` : ''}
          </p>
        )}
        {value && (
          <p>
            {value.foldersDone} / {value.foldersTotal || 'unknown'} folders scanned ·{' '}
            {value.messages.toLocaleString()} messages inventoried · {value.bytes.toLocaleString()}{' '}
            estimated bytes
          </p>
        )}
        {value?.folderMessages !== undefined && active && (
          <p>
            Current folder: {value.folderScanned.toLocaleString()} /{' '}
            {value.folderMessages.toLocaleString()} messages
          </p>
        )}
      </div>
      {active && (
        <progress
          aria-label="Folders scanned"
          max={value?.foldersTotal || 1}
          value={value?.foldersTotal ? value.foldersDone : undefined}
        />
      )}
      <p>
        {elapsed}s elapsed. Discovery reads folder information and message metadata; it does not
        copy mail.
      </p>
      {value?.status === 'failed' && (
        <p role="alert" className="error">
          {problems[value.error ?? ''] ??
            `Discovery could not finish (${value.error ?? 'unknown error'}). Check the connection settings and retry.`}
        </p>
      )}
      {value?.status === 'cancelled' && (
        <p>No partial plan will be used. You can retry discovery.</p>
      )}
      {active && (
        <button
          className="secondary"
          disabled={starting || cancelDisabled || value?.phase === 'cancelling'}
          onClick={onCancel}
        >
          {value?.phase === 'cancelling' ? 'Cancelling…' : 'Cancel discovery'}
        </button>
      )}
    </div>
  );
}

function Resolution({
  item,
  candidates,
  disabled,
  onResolve,
}: {
  item: string;
  candidates: string[];
  disabled: boolean;
  onResolve: (uid?: string, appendAgain?: boolean) => void;
}) {
  const [uid, setUid] = useState(''),
    [risk, setRisk] = useState(false);
  return (
    <details>
      <summary>Review / resolve</summary>
      <p>
        Matching candidate UIDs: {candidates.join(', ') || 'none recorded'}. A match alone cannot
        prove who created it.
      </p>
      <label>
        Destination UID
        <input
          aria-label={`Destination UID ${item}`}
          value={uid}
          onChange={(e) => setUid(e.target.value)}
        />
      </label>
      <button disabled={disabled || !uid} onClick={() => onResolve(uid)}>
        Verify &amp; link UID
      </button>
      <label className="check">
        <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} />I accept
        that another append may create a duplicate.
      </label>
      <button
        className="secondary"
        disabled={disabled || !risk}
        onClick={() => onResolve(undefined, true)}
      >
        Permit a new append on resume
      </button>
    </details>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
