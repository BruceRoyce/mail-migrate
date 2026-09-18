#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, secrets } from './config.js';
import { makePlan, checkPlan } from './plan.js';
import { imapFactory } from './transport.js';
import { Store, lock, unlock, privateDir, writePrivate } from './store.js';
import { execute, report, resolveItem } from './engine.js';
import { Fault, errorPayload } from './safety.js';
import type { Plan } from './model.js';

const program = new Command()
  .name('mail-migrate')
  .description('Local, source-read-only IMAP migration with SQLite recovery. Never sends SMTP.')
  .version('0.1.0');
let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
});
process.on('SIGTERM', () => {
  interrupted = true;
});
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function approve(plan: Plan, token?: string) {
  if (token === plan.hash) return;
  if (token) throw new Fault('confirmation_hash_mismatch', 3);
  if (!process.stdin.isTTY) throw new Fault('confirmation_required_use_approve_plan_hash', 3);
  output({
    plan: plan.id,
    hash: plan.hash,
    scope: plan.scope,
    pairs: plan.pairs,
    effects: 'Create missing folders and append messages; never modify source.',
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if ((await rl.question('Type the complete plan hash to approve: ')) !== plan.hash)
      throw new Fault('not_confirmed', 3);
  } finally {
    rl.close();
  }
}
const configCommand = (name: string) =>
  program
    .command(name)
    .requiredOption(
      '-c, --config <path>',
      'YAML configuration; relative paths resolve beside this file',
    );
configCommand('validate')
  .description('Offline strict configuration validation; does not resolve secrets')
  .action((o) => {
    loadConfig(o.config);
    output({ valid: true });
  });
for (const name of ['preflight', 'plan'])
  configCommand(name)
    .description('Read-only discovery and finite UID selection; zero remote writes')
    .option('--out <path>', 'New private JSON plan file')
    .option('--migration <id>', 'Existing migration ID for a catch-up plan')
    .option('--mailbox <id>', 'Select one mailbox pair')
    .option('--pilot <count>', 'Limit the entire pass to this many occurrences')
    .action(async (o) => {
      const c = loadConfig(o.config);
      const pilot = o.pilot === undefined ? undefined : Number(o.pilot);
      if (pilot !== undefined && (!Number.isSafeInteger(pilot) || pilot < 1))
        throw new Fault('invalid_pilot', 3);
      const p = await makePlan(
        c,
        secrets(c),
        imapFactory,
        { mailbox: o.mailbox, pilot },
        o.migration,
      );
      if (o.out) {
        privateDir(resolve(o.out, '..'));
        writePrivate(resolve(o.out), p);
      }
      output(p);
      if (p.blockers.length) process.exitCode = 2;
    });
for (const name of ['run', 'resume', 'catch-up', 'verify'])
  configCommand(name)
    .description(
      name === 'catch-up'
        ? 'Execute a newly reviewed plan for an existing migration'
        : 'Execute or verify a recorded scope',
    )
    .option('--plan <path>', 'Reviewed plan; required for run and catch-up')
    .option('--migration <id>', 'Existing migration identifier')
    .option('--approve <hash>', 'Explicit write approval of the complete plan SHA-256')
    .option('--dry-run', 'Validate and refresh read-only discovery without remote writes')
    .option('--json', 'Print JSON progress (default final report is JSON)')
    .action(async (o) => {
      const c = loadConfig(o.config);
      if ((name === 'run' || name === 'catch-up') && !o.plan) throw new Fault('plan_required', 3);
      const release = lock(c.stateDirectory);
      let store: Store | undefined;
      try {
        let p: Plan;
        if (o.plan) p = JSON.parse(readFileSync(o.plan, 'utf8')) as Plan;
        else {
          if (!o.migration) throw new Fault('migration_required', 3);
          store = new Store(c.stateDirectory);
          p = store.plan(o.migration);
        }
        checkPlan(p, c);
        if (o.migration && o.migration !== p.migration) throw new Fault('migration_mismatch', 3);
        const values = secrets(c);
        if (o.dryRun) {
          output(await makePlan(c, values, imapFactory, p.scope, p.migration));
          return;
        }
        if (name !== 'verify') await approve(p, o.approve);
        store ??= new Store(c.stateDirectory, name === 'run');
        const result = await execute(c, values, imapFactory, store, p, {
          existing: name !== 'run',
          verifyOnly: name === 'verify',
          stop: () => interrupted,
          progress: (line) => {
            if (o.json) output(line);
            else console.error(`${line.mailbox} ${line.item?.slice(0, 12)} ${line.state}`);
          },
        });
        privateDir(c.reportDirectory);
        const file = join(c.reportDirectory, `${p.migration}-${Date.now()}.json`);
        writePrivate(file, result);
        output(result);
        process.exitCode = interrupted ? 130 : result.status === 'incomplete' ? 2 : 0;
      } finally {
        store?.close();
        release();
      }
    });
for (const name of ['status', 'report'])
  program
    .command(name)
    .description('Offline ledger report, including unresolved occurrences')
    .requiredOption('--migration <id>')
    .option('--state-dir <path>', 'Private state directory', './private-migration-state')
    .option('--format <format>', 'Only json is supported', 'json')
    .action((o) => {
      if (o.format !== 'json') throw new Fault('unsupported_report_format', 3);
      const release = lock(resolve(o.stateDir));
      let store: Store | undefined;
      try {
        store = new Store(resolve(o.stateDir));
        output(report(store, o.migration));
      } finally {
        store?.close();
        release();
      }
    });
configCommand('resolve')
  .description(
    'Inspect evidence, link a UID after exact comparison, or record explicit duplicate-risk acceptance',
  )
  .requiredOption('--migration <id>')
  .requiredOption('--item <id>')
  .option('--link <uid>', 'Specific destination UID; full content must match')
  .option('--retry-read', 'Retry a corrected pre-append failure on the next approved pass')
  .option(
    '--append-again',
    'Allow a subsequent approved run to append an uncertain occurrence again',
  )
  .option('--accept-duplicate-risk', 'Required with --append-again')
  .action(async (o) => {
    const c = loadConfig(o.config),
      release = lock(c.stateDirectory);
    let store: Store | undefined;
    try {
      store = new Store(c.stateDirectory);
      checkPlan(store.plan(o.migration), c);
      if ([o.link, o.appendAgain, o.retryRead].filter(Boolean).length > 1)
        throw new Fault('choose_one_resolution', 3);
      if (o.appendAgain && !o.acceptDuplicateRisk)
        throw new Fault('duplicate_risk_acknowledgement_required', 3);
      if (o.link || o.appendAgain || o.retryRead)
        await resolveItem(c, secrets(c), imapFactory, store, o.migration, o.item, {
          link: o.link,
          appendAgain: o.appendAgain,
          retryRead: o.retryRead,
        });
      output(store.item(o.item));
    } finally {
      store?.close();
      release();
    }
  });
program
  .command('unlock')
  .description('Remove a stale lock only if its recorded local PID is no longer running')
  .option('--state-dir <path>', 'State directory', './private-migration-state')
  .action((o) => {
    unlock(resolve(o.stateDir));
    output({ unlocked: true });
  });
program
  .command('web')
  .description('Start the localhost browser UI; credentials remain in server memory')
  .option('--port <number>', 'Loopback port', '8787')
  .option('--state-dir <path>', 'State directory', './private-migration-state')
  .option('--report-dir <path>', 'Report directory', './private-migration-reports')
  .action(async (o) => {
    const { startWeb } = await import('./server.js');
    await startWeb(Number(o.port), resolve(o.stateDir), resolve(o.reportDir));
  });
program.parseAsync().catch((e) => {
  output(errorPayload(e));
  process.exitCode = e instanceof Fault ? e.exit : 4;
});
