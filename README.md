# Reliable Mail Migration

A local TypeScript application for copying IMAP mail between providers, with a browser UI and Windows/PowerShell CLI. It tests both connections, produces a reviewable folder plan, and only copies after explicit approval. SQLite records each source occurrence and raw-content verification evidence.

**Source deletion is excluded from this release.** Existing destination mail is preserved. No SMTP, DNS changes, mailbox provisioning, contacts, calendars, rules, aliases, shared-mailbox permissions or bidirectional synchronisation are implemented. Password/app-password IMAP is supported; OAuth token acquisition/refresh is not.

This is an initial implementation, not a claim of production readiness. Synthetic recovery tests and the browser flow have passed. The supplied real two-server test and maximum-message memory measurement still need execution: Docker's daemon was unavailable in the development environment. Pilot against the intended providers before bulk use.

## Start on Windows

Install Node.js **24 LTS**. From PowerShell in the project folder:

```powershell
npm ci
npm run build
npm run web
```

Open the **private localhost session link printed in PowerShell**, including the full `#…` suffix. Keep that terminal running. The link is a capability for this local session; do not share it. The UI removes its token from the address bar and keeps only that local access token in the tab's session storage, so refreshing retains access while the same backend is running. Mailbox settings and passwords are never saved in browser storage and must be re-entered after a page reload.

If the backend restarts, its old session links expire. The page will show **Reconnect to the local app**: paste the new full PowerShell link there and choose **Reconnect this tab**. This preserves existing form entries and only reconnects the local UI—it does not test mailboxes or start a migration. You can also reopen the new link directly. Opening the bare address without its suffix in a fresh tab requires this reconnect step.

The browser form uses its own entries; it does **not** load `migration.yaml`. That file is for CLI commands. Validation errors now identify the failing field and explain the expected format without displaying entered values. A mailbox identifier is a short label such as `support`, not an email address; put the account address in Username. After updating the application, rebuild it and restart the backend before reopening its session link.

1. Enter separate source and destination hostnames, ports, TLS modes, usernames and passwords. Add mailbox pairs as needed. No real provider hostnames or credentials are built in.
2. Click **Test both connections**. Both must pass before discovery is enabled.
3. In section 2, click **Discover folders & build plan** to see the actual source folders. Review mappings, counts, estimated bytes, size blockers and existing destination content. Each folder row has an **Include** checkbox: eligible folders start checked, existing exclusions stay unchecked, and non-selectable folders are disabled.
4. Review the confirmation statement and click **Start migration**. No folder creation or APPEND occurs during connection tests or planning.
5. Inspect verified/unresolved outcomes and download the private report. Retain the migration ID and state directory for resume and catch-up. After restarting, re-enter the same settings and credentials, test connections, enter the migration ID and click **Load saved migration**.

The **Existing migration ID** field fills automatically from the current plan and is preserved when rebuilding. If the state directory already contains a migration, that recorded ID takes priority and is recovered after backend restart. A first copy still uses **Start migration**; once recorded, subsequent passes use **Resume / run catch-up**. For catch-up, keep the auto-filled ID and click **Refresh discovery** (or **Discover folders & build plan** if there is no snapshot), then confirm the new plan. Clear any pilot limit for a full pass. The UI also supports read-only reverification and explicit linking of ambiguous destination UIDs. Advanced pre-append retry is available through the CLI.

**Folder policy** is in section 2, beneath the pilot limit and existing migration ID, with separate settings for each mailbox pair. Unchecking a discovered folder adds its exact source path to that pair's exclusions textarea; checking it again removes that name. Manual textarea edits also update the checkboxes. Matching remains exact and case-sensitive, with no wildcards or recursive parent exclusion. Non-selectable folders and other fixed policy exclusions cannot be selected through the table.

Changes to checkboxes, exclusions, destination overrides, label acknowledgement or the pilot limit automatically rebuild the plan locally from the retained discovery snapshot. There are no IMAP calls during this update and no connection retest is needed. Counts, selected bytes, size blockers and the plan hash are recalculated; the migration ID stays the same. Approval is cleared immediately, and copying stays disabled until the latest update finishes and you explicitly approve again. Excluded folders remain visible as `explicit_exclusion`, with no selected messages. A detected label/aggregate view requires the explicit physical-copy acknowledgement under Folder policy.

The snapshot retains all inventoried metadata, including messages outside an initial pilot and folders deselected after discovery. Rechecking those folders does not rescan them. If a folder was excluded before the original scan, selecting it produces a clear blocker: click **Refresh discovery** to inventory it, or uncheck it. Refresh is also required to include new arrivals or new folders. The displayed snapshot timestamp identifies when the inventory completed; local replanning does not refresh server observations.

Snapshots exist only in backend memory and are discarded on connection retest, discovery refresh, saved-plan loading or backend restart. Saved plans contain only their selected message scope and are not treated as complete snapshots. After loading a saved plan, run discovery before changing its selections. Loading still requires matching policy settings and accounts.

Discovery starts as a background read-only job. The plan review section immediately shows activity, the current mailbox/folder, inventoried message counts, estimated bytes and elapsed time. **Cancel discovery** closes the discovery connections and discards partial results; you can retry. A stalled discovery read stops after the configured `timeoutSeconds` (60 seconds by default); completed metadata batches renew that deadline. A failed or cancelled discovery never enables migration approval. Restart the backend after updating the application to use this workflow.

Large, sparsely numbered mailboxes are searched using the selected folder's count to bound the UID response; message metadata is then fetched in groups of at most 250 UIDs. An inventory above the configured occurrence ceiling fails explicitly before an unbounded scan. A pilot limits copying, not the inventory needed to review the selected folders; raise the inventory and memory allowances together or exclude folders explicitly.

Default directories are `private-migration-state` and `private-migration-reports` beneath the launch directory. Override them with:

```powershell
node dist/cli.js web --state-dir C:\PrivateMail\state --report-dir C:\PrivateMail\reports --port 8787
```

The local UI uses React/Vite and a Fastify backend bound to `127.0.0.1` by default. Docker uses an explicit `--host 0.0.0.0` override inside the container with a loopback-only published port. Credentials remain in browser form/backend memory, not browser persistent storage or SQLite. Password fields, RAM, process dumps and swap are not a secure vault. Protect the machine and private directories; see the [operator runbook](docs/RUNBOOK.md).

## Run with Docker

The root Dockerfile uses `node:24`, builds the backend and browser assets, and runs the compiled app as the non-root `node` user with production dependencies only. The build context excludes local configuration, secrets, migration state, reports and Windows `node_modules`.

Run these commands from the project directory (PowerShell or a Linux shell):

```sh
docker build -t email-migrator .
docker volume create email-migrator-data
docker run -d --name email-migrator --init --stop-timeout 120 -p 127.0.0.1:8787:8787 -v email-migrator-data:/data email-migrator
docker logs email-migrator
```

Stop the native app first if it is using port 8787. Open the full private `http://127.0.0.1:8787/#…` link from the container logs on the Docker host. Use `127.0.0.1`, not `localhost`: the Host and Origin checks still require that exact address and port. Access from another computer requires an SSH tunnel forwarding port 8787 to the Docker host's loopback port; this deployment does not enable a public or LAN web service. Keep the host-side `127.0.0.1` in the port mapping.

The named volume persists the SQLite ledger under `/data/state` and reports under `/data/reports`. Use one container per state volume. It starts with a separate empty ledger; it does not import an existing Windows migration automatically. For custom CA files, mount a separate directory read-only and enter the container path in the UI. Bind mounts used instead of the named volume must be writable by the image's `node` user (UID/GID 1000).

```sh
docker stop email-migrator
docker start email-migrator
docker logs email-migrator
```

Every process restart creates a new session link and clears in-memory mailbox credentials. Re-enter credentials, test connections and use the saved migration ID to resume. Stop gracefully before replacing the container; retain the named volume. A forced stop can leave a stale writer lock requiring investigation, especially after container replacement changes its hostname or process IDs. Never remove a lock while another process may still be using that ledger.

The container launch uses Node directly and forwards termination signals through Docker's `--init`. The 120-second stop grace allows the current mail operation to settle; if it is forcibly terminated, recovery uses the durable ledger. The Docker image has not yet been built or run in this development environment because the Linux Docker daemon is unavailable.

## CLI: configuration, plan and dry run

```powershell
Copy-Item migration.example.yaml migration.yaml
# Edit migration.yaml: explicit endpoints, accounts and secret references.
node dist/cli.js validate --config migration.yaml
```

The annotated example contains only fictional `.example` domains. Unknown fields and unsupported authentication modes fail validation. Config-relative paths resolve beside the YAML file. `validate` is offline and does not resolve secrets.

Supply passwords locally. With PowerShell 7, a masked prompt can populate an environment variable without placing its value in command history:

```powershell
$env:OLD_SUPPORT_PASSWORD = Read-Host 'Source app password' -MaskInput
$env:NEW_SUPPORT_PASSWORD = Read-Host 'Destination app password' -MaskInput
```

Environment variables are inherited by child processes and are not a secure vault. Alternatively use `file:./account.secret` references to protected UTF-8 files; one trailing newline is removed. Password arguments and literal passwords in configuration are rejected. Implicit TLS and mandatory STARTTLS both validate certificates and hostnames. `caFile` adds a trusted CA; there is no insecure TLS bypass.

```powershell
node dist/cli.js preflight --config migration.yaml
node dist/cli.js plan --config migration.yaml --out migration-plan.json
node dist/cli.js run --config migration.yaml --plan migration-plan.json --dry-run
```

These operations have **zero remote mutations**. The dry run validates the existing plan and prints a refreshed read-only inventory, without changing the approved plan. Stats are observations/estimates; preflight cannot guarantee write permissions or future quota availability.

## Approved execution

```powershell
$plan = Get-Content migration-plan.json -Raw | ConvertFrom-Json
# Run only after reviewing this specific plan:
node dist/cli.js run --config migration.yaml --plan migration-plan.json --approve $plan.hash
```

Without `--approve`, an interactive terminal asks you to type the full plan hash. A noninteractive run fails instead of assuming approval. `--json` adds JSON progress; otherwise progress goes to stderr and the final JSON report to stdout. Reports are also written privately beneath reportDirectory. Reusing an intact ledger skips already verified occurrences; content is freshly fetched only by explicit `verify` or when verification is pending. Old evidence is timestamped and is not a guarantee that destination mail still exists.

```powershell
node dist/cli.js resume --config migration.yaml --migration $plan.migration --approve $plan.hash
node dist/cli.js verify --config migration.yaml --migration $plan.migration
node dist/cli.js status --state-dir ./private-migration-state --migration $plan.migration
node dist/cli.js report --state-dir ./private-migration-state --migration $plan.migration --format json
```

Status and report work offline. They acquire the same local lock and therefore do not run concurrently with a migration. `verify` can update local evidence but cannot create folders or append/repair messages. SIGINT requests graceful cancellation; exit code 130 indicates interruption. A crash can leave a stale lock:

```powershell
node dist/cli.js unlock --state-dir ./private-migration-state
```

Unlock refuses if the recorded local PID is alive. The lock does not govern other mail clients or migrations in separate state directories. Only one migration ID is accepted per state directory. Never delete a database to resume; restore its backup or explicitly review a new migration and its duplicate risk.

## Pilot and catch-up

```powershell
node dist/cli.js plan --config migration.yaml --mailbox support --pilot 20 --out migration-plan-pilot.json
# Review and run the pilot; retain its migration ID.
node dist/cli.js plan --config migration.yaml --migration $plan.migration --out migration-plan-catchup.json
$next = Get-Content migration-plan-catchup.json -Raw | ConvertFrom-Json
node dist/cli.js catch-up --config migration.yaml --migration $next.migration --plan migration-plan-catchup.json --approve $next.hash
```

Use the actual pilot ID, not an ID from a different plan. Resume uses the saved scope; catch-up requires a fresh plan. Source folders are observed separately, not as one atomic account snapshot. New arrivals outside the finite UID boundary are not silently counted as covered. No automatic DNS or old-service retirement actions exist.

## Resolve uncertainty

```powershell
node dist/cli.js resolve --config migration.yaml --migration $plan.migration --item ITEM_ID
node dist/cli.js resolve --config migration.yaml --migration $plan.migration --item ITEM_ID --link DESTINATION_UID
# Alternative only when you accept possible duplication:
node dist/cli.js resolve --config migration.yaml --migration $plan.migration --item ITEM_ID --append-again --accept-duplicate-risk
# After correcting a known failure before APPEND, retry on the next approved pass:
node dist/cli.js resolve --config migration.yaml --migration $plan.migration --item ITEM_ID --retry-read
```

Linking requires an exact raw hash match and a destination occurrence not already claimed by another source item. Identical source messages remain distinct. Candidate hashes alone do not identify the writer when other clients are active. `--append-again` changes local permission only; a separately approved resume performs the write. `--retry-read` applies only to source_missing/permanent_failure before an append, never ambiguous writes. If configuration limits changed, first execute the newly approved plan to record that policy, then resolve the old pre-append failure and resume.

UIDVALIDITY changes block stale assumptions. Destination generations can be manually relinked; automatic source-generation reconciliation is unsupported. Do not use a new ledger as a shortcut around reconciliation. Existing destination content is never deleted, reused automatically or merged by Message-ID.

## Limits and outcomes

- Default: one mailbox pair, one message, 25 MiB message ceiling, 5,000 selected/observed source occurrences per plan, 512 MiB planning allowance. All limits are validated. Increase occurrence/memory limits explicitly for larger mailboxes.
- APPEND buffers a complete message; this is not end-to-end streaming. The allowance formula is 192 MiB + 6 × message ceiling + 16 KiB × occurrence ceiling. It is not an OS RSS guarantee. No raw-message spool is created.
- Supported flags and INTERNALDATE are attempted. `\\Recent` is ignored; `\\Deleted` is omitted; unsupported flags and changed metadata are reported separately from content equality. No subscription changes occur.
- Missing, mismatched, failed, ambiguous or unverified occurrences yield an incomplete report. Known metadata loss yields `content_complete_with_metadata_deviations`. Completion always means the recorded scope, not future mail or the whole domain.
- Plans/reports contain private metadata. Logs omit subjects, raw messages and arbitrary server errors. No ETA is shown because no robust estimate is implemented.

| Exit | Meaning                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| 0    | Command succeeded; completed recorded scope may include explicitly reported metadata deviations     |
| 2    | Incomplete, ambiguous, blocked or unresolved work                                                   |
| 3    | Invalid configuration, plan, confirmation, local state selection or lock                            |
| 4    | Unhandled connection/authentication/provider or local operation failure; inspect sanitised category |
| 130  | Interrupted execution                                                                               |

Per-mailbox failures during an established pass produce exit 2 and appear in the aggregate report; an initial preflight connection failure returns 4. `--help` is available on every command.

## Tests

```powershell
npm run lint
npm run check
npm test
npm run build
$env:PLAYWRIGHT_CHANNEL = 'msedge'   # Or install bundled Chromium below.
npm run test:ui
# For bundled Chromium: npx playwright install chromium
```

Unit/fault tests use synthetic in-memory adapters plus actual SQLite. Browser tests use the same synthetic servers. The two-server test uses actual TLS Dovecot containers and the real ImapFlow adapter:

```powershell
# Start Docker Desktop first. This creates only disposable synthetic accounts.
pwsh -File test/integration/run.ps1
```

It verifies MIME fixtures, duplicate occurrences, unrelated destination mail, source immutability, reruns and an exact 25 MiB message. Signed/encrypted fixtures contain synthetic opaque payloads, not actual cryptographic signatures. Without `IMAP_INTEGRATION=1`, `npm run integration` explicitly skips the test; a skip is not a pass. The CI workflow runs it against Docker on Linux, plus unit/UI checks on Windows and Linux.

See [architecture and recovery policy](docs/ARCHITECTURE.md), [operator runbook](docs/RUNBOOK.md), [test evidence](docs/TESTING.md), and [synthetic reports](docs/samples/).

Before a live migration, the owner still needs to confirm provider endpoints/authentication, mailbox mappings versus aliases, provisioning, volumes/largest messages/quotas, active-user behaviour, folder scope and DNS/cutover ownership. **Building this application does not authorise operating on real mailboxes.**

# mail-migrate

## License

Licensed under the [MIT License](LICENSE).
