# Verification evidence — 19 September 2026

Environment: Windows, PowerShell, Node 24.11.0, npm 11.19.0, ImapFlow 2.0.5. The workspace was initially empty and was not a Git checkout. No production credentials or real mailboxes were used.

| Check actually run                              | Result                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `npm run check`                                 | TypeScript backend and React UI passed                             |
| `npm run build`                                 | Backend and production UI bundle built                             |
| `npm test`                                      | **52 passed**, 0 failed, 0 skipped                                 |
| `npm run test:ui` with installed Microsoft Edge | **10 passed**                                                      |
| CLI `--help` and example `validate`             | Passed                                                             |
| `npm run integration` without opt-in            | **1 explicitly skipped**, 0 passed                                 |
| Docker availability                             | CLI installed; Linux engine named pipe missing, daemon unavailable |

The synthetic suite covers duplicate multiplicity, unrelated destination content, ledger reruns, before/after-APPEND disconnects, lost-response/crash intent, absent APPENDUID, manual evidence linking, quota/size failures, source/destination UIDVALIDITY changes, source and destination disappearance, mismatch, metadata drift, cancellation, catch-up, nested international names, pilots, source immutability, mapping collisions, configuration/fingerprint validation, locking, error redaction, per-mailbox failure isolation, TLS/EXAMINE adapter settings, truncated downloads and the local UI API confirmation/security boundary.

Two additional scope regressions are covered: narrowing a plan must not copy older unresolved occurrences outside the approved pilot list; read-only verification must still revisit the entire migration ledger after a narrower plan.

The Edge test fills the form, tests both connections, discovers folders, checks that copying is disabled without confirmation, starts a synthetic copy, waits for verified results and downloads a report. A screenshot is generated at `test-results/workflow.png` and was visually inspected. The UI has no remote font or analytics dependencies.

Follow-up regressions cover field-specific validation without credential leakage, session refresh/reconnection, asynchronous discovery progress, cancellation of a stalled read, overlap rejection, safe retry and explicit inventory-limit failures. A sparse-UID adapter test enumerates 501 occurrences near UID 4,000,000,000 using one SEARCH and three FETCH batches, preserves a vanished member as a gap, and asserts that no per-message FETCH is used. Timeout and progress-renewal tests use synthetic readers. The Edge discovery tests use a deliberately slow synthetic folder and verify visible progress and cancellation; `test-results/discovery-progress.png` was visually inspected. None of these are real-provider performance measurements.

Folder-selection regressions verify that policy controls are in section 2, checkboxes and exact-name exclusions stay synchronized, prior exclusions and non-selectable folders are preserved, and selections remain independent across mailbox pairs. Editing invalidates confirmation even after session polling; rebuilding restores eligibility without another connection test. The backend test checks changed plan hashes, old-hash rejection, retained credentials, policy validation, exclusion from scanning and copying, saved-plan loading and re-inclusion. `test-results/folder-selection.png` was visually inspected.

Migration ID regressions verify automatic field population, stable IDs across plan rebuilds, ledger ID recovery after backend restart, rejection of an unrelated ID, and resume without recopying verified messages. All ten browser tests passed, including changing selections and resuming after the first copy.

Snapshot regressions verify that full pilot inventory is retained, local selection changes do not mutate the snapshot, selected byte totals are recalculated, newly arrived mail is not silently added, mapping and label rules are revalidated, and never-inventoried folders require refresh. The API test counts transport adapters to prove that local rebuilding makes zero IMAP calls, rejects old approval hashes and refuses invalidated snapshots. Browser tests assert a single discovery request across checkbox and pilot edits, delay a rebuild response to exercise polling races, preserve per-pair exclusions and verify the explicit refresh path for an unscanned folder. The updated folder-selection screenshot was visually inspected.

## Measured synthetic memory test

The isolated application test transferred and verified one **26,214,400-byte (25 MiB)** message at concurrency one. On the originally recorded baseline run:

| Measurement          |                         Value |
| -------------------- | ----------------------------: |
| RSS before transfer  |             151,293,952 bytes |
| RSS after transfer   |             230,359,040 bytes |
| Peak RSS             | 224,960 KiB (about 219.7 MiB) |
| Configured allowance |                       512 MiB |

This includes synthetic server buffers and application hashing/ledger work, but **does not measure ImapFlow parser, TLS or real-server buffering**. It is a smoke test, not proof of the production memory bound. Measurements vary by runtime and machine.

## Still unverified

The runnable two-Dovecot TLS harness is in `test/integration/`. It exercises the actual ImapFlow adapter and records RSS while handling the maximum-size fixture. It was **not executed against running servers here**. Its skip must not be counted as interoperability evidence. The CI definition includes the harness, but no remote CI run has been claimed.

Real-provider behavior, OAuth, real TLS/authentication failure scenarios, rate limiting, disk exhaustion, cross-process power-loss durability, exact special-use semantics and maximum-message RSS over actual IMAP remain unproven in this environment. Disk-full/state-corruption failures are fatal by implementation policy, but destructive fault tests for them have not been run. The synthetic crash test reconstructs the durable pending-intent state rather than killing a live process mid-system-call. The lock unit test uses independent lock acquisitions; an OS-level two-process contention test is not part of this evidence.

Do not call this release production-validated until the two-server harness and an explicitly authorised provider pilot have passed. The [runbook](RUNBOOK.md) explains safe operator recovery and the remaining source-generation reconciliation limitation.
