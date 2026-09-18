# Operator runbook

1. Provision destination accounts. Identify actual stored mailboxes versus aliases. Obtain explicit IMAP endpoints, TLS modes and authentication requirements privately; do not derive source endpoints from current MX records. Confirm size limits, storage, connection limits and who controls DNS. OAuth-only accounts are not supported by this release.
2. Start the local UI or create the YAML configuration. Test both connections. Authentication and TLS failures must be resolved before proceeding. Check that different hostnames do not alias the same underlying mailbox.
3. Build the read-only plan. Review folder mappings, destination content, special/virtual folders, exclusions, counts, oversized occurrences and unknown quotas. Resolve collisions using exact folder overrides. Spam and Trash are included by default; `\\Deleted` messages retain their content but lose that flag.
4. Pilot one mailbox or a small message limit. Approve the exact plan. Inspect full-content verification and metadata deviations. A successful pilot is not a complete migration.
5. Create and approve a full-scope plan using the **same migration ID** and state directory. Run the bulk transfer. Keep the backend process running; the browser may close without stopping it. Do not delete or edit SQLite to bypass an error.
6. The responsible administrator changes mail delivery, client settings and related records. This program performs no DNS operations. There is no universal propagation wait, automatic rollback or automatic service cancellation.
7. Build fresh catch-up plans with the same migration ID, removing a pilot limit if necessary. New folders and UIDs are discovered; failed earlier occurrences remain in the ledger. Approve every new plan. Ordinary resume retries the existing recorded scope, not a fresh source snapshot. Later flag changes, moves and deletions are not mirrored.
8. Arrange a quiet window where practical. Run the final catch-up and then read-only verification. Record the pass boundaries, exclusions, timestamp and report. Inspect potential arrivals/new folders outside the boundary. The program cannot prove that the old host will never receive more mail.
9. Resolve failures, ambiguity and metadata deviations. Retain the old service until the responsible operator accepts the evidence and makes a retention decision. **Source deletion is not implemented.** Back up the ledger and private reports before retirement.

## Recovery

- Connection/read failure: correct access/network issues, then resume against the same approved plan. Persistent provider/read errors may need a reviewed new plan; permanent failures do not loop automatically.
- Oversized messages: increase local limits and memory budget if the provider permits, then create and execute a newly approved plan to record those limits. Use CLI `resolve --retry-read` for the pre-append failure, then approve resume. No truncation or MIME reconstruction is allowed.
- Quota/APPEND failure or lost response: inspect the ambiguous item and candidates. Restore quota first. Link a known destination UID after exact comparison or explicitly accept duplicate risk for a new append. Never infer absence from a missing reply.
- Content mismatch: retain the source. A provider may rewrite bytes. There is no canonicalised verification fallback and no success by matching subject, Message-ID or size alone.
- Source disappearance: it remains a reported gap. Do not call the pass fully covered.
- Destination disappearance: read-only verify detects it. The application does not silently repair it; explicit evidence linking or a separately reviewed migration is required.
- Source UIDVALIDITY reset: ordinary copying is blocked. Preserve the old ledger and reconcile the new source generation before planning a separate migration. Automatic source-generation re-identification is outside this release.
- Destination UIDVALIDITY reset: link each surviving exact occurrence to its new UID. New copying stays blocked until all recorded occurrences in that folder are reconciled.
- Crash/cancellation: restart and provide credentials again. A completed remote write with no ledger result becomes ambiguous. Use `unlock` only when the saved local PID is dead; PID reuse or an owner file missing after a crash requires manual process/lock investigation. Never remove a live lock.
- Lost ledger: `resume` refuses. Restoring its backup is preferred. A new migration deliberately preserves pre-existing destination messages and can create duplicates; it is not ordinary safe resume.

## Backup and local privacy

Stop the backend and all CLI commands before backing up. Copy the **whole state directory**, including any SQLite WAL/SHM files, using your normal private backup tool. Keep the config and reports with the backup but protect secret files separately. Do not copy only a live SQLite main file. There is no application backup command.

Use a private, encrypted local volume. On Windows, review the state/report/secret directories in Properties → Security or with `icacls`; restrict access to the account operating the migration and necessary administrators. This release does not automatically rewrite existing ACLs. Environment variables are convenient but can be inherited by child processes or exposed to local administrators. Protected secret files avoid shell history but remain plaintext on disk. UI password fields avoid putting credentials in command arguments or history.

Reports contain sensitive account and folder metadata even without message bodies. Plans and report files are created without overwriting existing files. No raw spool files are used. Ordinary file deletion is not guaranteed secure erasure. Do not send private reports or mailbox data to AI services.
