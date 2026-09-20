import React, { useEffect, useState } from 'react';

type Job = {
  status: string;
  folder?: string;
  messages?: number;
  bytes?: number;
  directory?: string;
  error?: string;
};
type Folder = { path: string; selectable: boolean; count?: number };
export function ArchiveExport({
  api,
  disabled,
  onError,
  onBusy,
  onOpen,
}: {
  api: <T>(path: string, body?: unknown) => Promise<T>;
  disabled: boolean;
  onError: (error: unknown) => void;
  onBusy: (busy: boolean) => void;
  onOpen: (path: string) => void;
}) {
  const [source, setSource] = useState({
    host: '',
    username: '',
    password: '',
    port: 993,
    tlsMode: 'implicit',
    caFile: '',
  });
  const [folders, setFolders] = useState<Folder[]>([]),
    [excluded, setExcluded] = useState<string[]>([]);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [path, setPath] = useState('');
  const [job, setJob] = useState<Job>({ status: 'idle' });
  const [limits, setLimits] = useState({
    maxMessageMiB: 25,
    maxOccurrences: 5000,
    memoryBudgetMiB: 512,
  });
  const active = job.status === 'running';
  useEffect(() => {
    onBusy(busy || active);
  }, [busy, active, onBusy]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<Job>('archive/status');
        if (live) setJob(value);
      } catch (error) {
        if (live) onError(error);
      } finally {
        if (live) timer = setTimeout(poll, 1000);
      }
    };
    if (!disabled) void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [disabled]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="archive-heading">
      <h2 id="archive-heading">Store emails locally</h2>
      <p>
        Save raw messages and a manifest for import later. No destination account is needed and
        source mail is never modified.
      </p>
      <fieldset disabled={disabled || busy || active}>
        <legend>Source IMAP account</legend>
        <div className="columns">
          {(['host', 'username', 'password'] as const).map((field) => (
            <label key={field}>
              {field === 'host'
                ? 'IMAP hostname'
                : field === 'username'
                  ? 'Username'
                  : 'Password / app password'}
              <input
                aria-label={`Archive source ${field}`}
                autoComplete="off"
                type={field === 'password' ? 'password' : 'text'}
                value={source[field]}
                onChange={(e) => {
                  setSource({ ...source, [field]: e.target.value });
                  setReady(false);
                }}
              />
            </label>
          ))}
          <label>
            Port
            <input
              aria-label="Archive source port"
              type="number"
              value={source.port}
              onChange={(e) => {
                setSource({ ...source, port: Number(e.target.value) });
                setReady(false);
              }}
            />
          </label>
          <label>
            TLS mode
            <select
              aria-label="Archive source TLS"
              value={source.tlsMode}
              onChange={(e) => {
                setSource({ ...source, tlsMode: e.target.value });
                setReady(false);
              }}
            >
              <option value="implicit">Implicit TLS</option>
              <option value="starttls">Mandatory STARTTLS</option>
            </select>
          </label>
          <label>
            Custom CA file
            <input
              value={source.caFile}
              onChange={(e) => {
                setSource({ ...source, caFile: e.target.value });
                setReady(false);
              }}
            />
          </label>
        </div>
        <div className="row">
          {(['maxMessageMiB', 'maxOccurrences', 'memoryBudgetMiB'] as const).map((key) => (
            <label key={key}>
              {
                {
                  maxMessageMiB: 'Message ceiling (MiB)',
                  maxOccurrences: 'Inventory occurrence ceiling',
                  memoryBudgetMiB: 'Memory allowance (MiB)',
                }[key]
              }
              <input
                type="number"
                value={limits[key]}
                onChange={(e) => {
                  setLimits({ ...limits, [key]: Number(e.target.value) });
                  setReady(false);
                }}
              />
            </label>
          ))}
        </div>
        <button
          onClick={() =>
            void perform(async () => {
              setReady(false);
              const result = await api<{ ready: boolean; folders: Folder[] }>('archive/test', {
                source: { ...source, caFile: source.caFile || undefined },
                ...limits,
              });
              setFolders(result.folders);
              setExcluded([]);
              setReady(result.ready);
            })
          }
        >
          Test source and list folders
        </button>
        {ready && (
          <>
            <p className="success">Source connection passed. Choose the folders to store.</p>
            {folders.map((folder) => (
              <label className="check" key={folder.path}>
                <input
                  type="checkbox"
                  aria-label={`Store ${folder.path}`}
                  disabled={!folder.selectable}
                  checked={folder.selectable && !excluded.includes(folder.path)}
                  onChange={(e) =>
                    setExcluded(
                      e.target.checked
                        ? excluded.filter((v) => v !== folder.path)
                        : [...excluded, folder.path],
                    )
                  }
                />
                {folder.path} · {folder.count ?? 'unknown'} messages
              </label>
            ))}
          </>
        )}
        <label>
          New archive folder path
          <input
            aria-label="New archive folder path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\MailArchives\my-mailbox"
          />
        </label>
        <p>
          Enter a new named folder beneath an existing directory. Storage is on the machine running
          this app; in Docker use a persistent mounted path such as /data/archives/my-mailbox.
          Existing folders are never overwritten.
        </p>
        <button
          disabled={!ready || !path.trim()}
          onClick={() =>
            void perform(async () => {
              await api('archive/export', { path, exclude: excluded });
              setJob({ status: 'running', directory: path, messages: 0, bytes: 0 });
            })
          }
        >
          Download and store emails
        </button>
      </fieldset>
      {job.status !== 'idle' && (
        <div className="discovery-status" role="status">
          <strong>
            {job.status === 'complete'
              ? 'Local archive complete'
              : job.status === 'running'
                ? 'Storing emails…'
                : `Export ${job.status}`}
          </strong>
          <p>
            {job.folder} · {job.messages ?? 0} messages stored · {(job.bytes ?? 0).toLocaleString()}{' '}
            bytes
          </p>
          <p>{job.directory}</p>
          {job.error && (
            <p role="alert">
              {job.error}. An incomplete export cannot be imported. Retry into a new folder after
              correcting the cause.
            </p>
          )}
          {active && (
            <button
              disabled={busy || disabled}
              onClick={() =>
                void perform(async () => {
                  await api('cancel', {});
                })
              }
            >
              Cancel local export
            </button>
          )}
          {job.status === 'complete' && (
            <>
              <p>
                Keep archive.json and the messages folder together. This archive contains
                unencrypted email; protect its storage and backups.
              </p>
              <button onClick={() => onOpen(job.directory!)}>
                Open in Append from local storage
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
