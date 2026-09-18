import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { type Config, type Endpoint, validateConfig } from './config.js';
import { makePlan, checkPlan } from './plan.js';
import { imapFactory, type Factory } from './transport.js';
import { Store, lock, privateDir, writePrivate } from './store.js';
import { execute, report, resolveItem, type Progress } from './engine.js';
import { Fault, category, errorPayload } from './safety.js';
import { validationIssues } from './validation.js';
import type { Plan } from './model.js';
import type { Discovery } from './discovery.js';

const inputEndpoint = z
  .object({
    host: z.string(),
    port: z.number(),
    tlsMode: z.enum(['implicit', 'starttls']),
    username: z.string(),
    password: z.string().min(1),
    caFile: z.string().optional(),
  })
  .strict();
function withoutPassword(input: z.infer<typeof inputEndpoint>, ref: string) {
  const { password, ...endpoint } = input;
  return { ...endpoint, auth: { type: 'password', secretRef: 'env:' + ref } };
}
const setup = z
  .object({
    mailboxes: z
      .array(
        z
          .object({
            id: z.string(),
            source: inputEndpoint,
            destination: inputEndpoint,
            folders: z
              .object({
                exclude: z.array(z.string()),
                overrides: z.record(z.string(), z.string()),
                labelStrategy: z.enum(['unresolved', 'explicit-folders']),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    maxMessageMiB: z.number().int().min(1).max(100),
    memoryBudgetMiB: z.number().int().min(256).max(8192),
    maxOccurrences: z.number().int().min(1).max(100000).default(5000),
  })
  .strict();
export async function createWeb(
  port: number,
  stateDirectory: string,
  reportDirectory: string,
  factory: Factory = imapFactory,
) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const token = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  let config: Config | undefined,
    values: Map<Endpoint, string> | undefined,
    plan: Plan | undefined,
    running = false,
    cancelled = false,
    lastReport: unknown,
    error: string | undefined;
  let progress: Progress[] = [];
  let discovery: Discovery | undefined;
  let discoveryController: AbortController | undefined;
  const cancel = () => {
    cancelled = true;
    if (discovery?.status === 'running') {
      discovery = { ...discovery, phase: 'cancelling', updatedAt: new Date().toISOString() };
      discoveryController?.abort();
    }
  };
  let setupRequest: string | undefined;
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (req.headers.host !== `127.0.0.1:${port}`)
      return reply.code(403).send({ error: 'host_rejected' });
    if (
      req.url.startsWith('/api/') &&
      (req.headers['x-session-token'] !== token ||
        (req.headers.origin && req.headers.origin !== origin))
    )
      return reply.code(403).send({ error: 'session_rejected' });
    if (req.method === 'POST' && req.url !== '/api/cancel') {
      if (setupRequest) return reply.code(409).send({ error: 'another_request_in_progress' });
      setupRequest = req.id;
    }
  });
  app.addHook('onResponse', async (req) => {
    if (setupRequest === req.id) setupRequest = undefined;
  });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof z.ZodError) {
      reply
        .code(400)
        .send(errorPayload(new Fault('invalid_request', 3, validationIssues(e, 'request'))));
      return;
    }
    reply.code(e instanceof Fault ? 400 : 500).send(errorPayload(e));
  });
  const idle = () => {
    if (running) throw new Fault('migration_running');
    if (discovery?.status === 'running') throw new Fault('discovery_running');
  };
  const ready = () => {
    if (!config || !values) throw new Fault('test_connections_first');
    return { c: config, v: values };
  };
  app.get('/api/session', async () => ({
    running,
    plan,
    report: lastReport,
    error,
    progress,
    discovery,
  }));
  app.post('/api/test', async (req) => {
    idle();
    config = undefined;
    values = undefined;
    plan = undefined;
    error = undefined;
    lastReport = undefined;
    progress = [];
    discovery = undefined;
    const parsed = setup.safeParse(req.body);
    if (!parsed.success)
      throw new Fault('invalid_connection_form', 3, validationIssues(parsed.error, 'form'));
    const body = parsed.data;
    const c = validateConfig({
      version: 1,
      stateDirectory,
      reportDirectory,
      defaults: {
        maxMessageBytes: body.maxMessageMiB * 1024 * 1024,
        memoryBudgetMiB: body.memoryBudgetMiB,
        maxOccurrences: body.maxOccurrences,
      },
      mailboxes: body.mailboxes.map((m) => ({
        id: m.id,
        source: withoutPassword(m.source, 'UI_SOURCE'),
        destination: withoutPassword(m.destination, 'UI_DESTINATION'),
        folders: m.folders,
      })),
    });
    // Strip passwords before strict validation rather than ever retaining them in config.
    const v = new Map<Endpoint, string>();
    const results: { mailbox: string; side: string; ok: boolean; error?: string }[] = [];
    for (let i = 0; i < c.mailboxes.length; i++)
      for (const side of ['source', 'destination'] as const) {
        const endpoint = c.mailboxes[i]![side];
        v.set(endpoint, body.mailboxes[i]![side].password);
        const client = factory(endpoint, v.get(endpoint)!, false, c);
        try {
          await client.connect();
          await client.list();
          results.push({ mailbox: c.mailboxes[i]!.id, side, ok: true });
        } catch (e) {
          results.push({ mailbox: c.mailboxes[i]!.id, side, ok: false, error: category(e) });
        } finally {
          await client.close();
        }
      }
    if (results.every((r) => r.ok)) {
      config = c;
      values = v;
    }
    return { results, ready: !!config };
  });
  app.post('/api/plan', async (req, reply) => {
    idle();
    const { c, v } = ready();
    const scope = z
      .object({
        pilot: z.number().int().positive().optional(),
        mailbox: z.string().optional(),
        migration: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    plan = undefined;
    error = undefined;
    const now = new Date().toISOString();
    discovery = {
      status: 'running',
      phase: 'starting',
      startedAt: now,
      updatedAt: now,
      foldersDone: 0,
      foldersTotal: 0,
      messages: 0,
      bytes: 0,
      folderScanned: 0,
    };
    discoveryController = new AbortController();
    void makePlan(c, v, factory, { pilot: scope.pilot, mailbox: scope.mailbox }, scope.migration, {
      signal: discoveryController.signal,
      progress: (value) => {
        discovery = { ...discovery!, ...value, updatedAt: new Date().toISOString() };
      },
    })
      .then((result) => {
        plan = result;
        discovery = {
          ...discovery!,
          status: 'complete',
          phase: 'complete',
          finishedAt: new Date().toISOString(),
        };
      })
      .catch((e) => {
        const reason = category(e);
        discovery = {
          ...discovery!,
          status: reason === 'discovery_cancelled' ? 'cancelled' : 'failed',
          error: reason,
          finishedAt: new Date().toISOString(),
        };
      })
      .finally(() => {
        discoveryController = undefined;
      });
    return reply.code(202).send({ discovery });
  });
  app.post('/api/run', async (req) => {
    idle();
    const { c, v } = ready();
    const input = z
      .object({
        hash: z.string(),
        confirm: z.literal(true),
        mode: z.enum(['run', 'resume', 'verify']).default('run'),
      })
      .strict()
      .parse(req.body);
    if (!plan || input.hash !== plan.hash) throw new Fault('confirmation_hash_mismatch');
    checkPlan(plan, c);
    const release = lock(c.stateDirectory);
    let store: Store;
    try {
      store = new Store(c.stateDirectory, input.mode === 'run');
    } catch (e) {
      release();
      throw e;
    }
    const p = plan;
    running = true;
    cancelled = false;
    error = undefined;
    progress = [];
    void execute(c, v, factory, store, p, {
      existing: input.mode !== 'run',
      verifyOnly: input.mode === 'verify',
      stop: () => cancelled,
      progress: (value) => {
        progress.push(value);
        if (progress.length > 100) progress.shift();
      },
    })
      .then((result) => {
        lastReport = result;
        privateDir(c.reportDirectory);
        writePrivate(join(c.reportDirectory, `${p.migration}-${Date.now()}.json`), result);
      })
      .catch((e) => {
        error = category(e);
      })
      .finally(() => {
        store.close();
        release();
        running = false;
      });
    return { started: true, migration: p.migration };
  });
  app.post('/api/load', async (req) => {
    idle();
    const { c } = ready();
    const { migration } = z.object({ migration: z.string().uuid() }).strict().parse(req.body);
    const release = lock(c.stateDirectory);
    let store: Store | undefined;
    try {
      store = new Store(c.stateDirectory);
      plan = store.plan(migration);
      checkPlan(plan, c);
      lastReport = report(store, migration);
      return { plan, report: lastReport };
    } finally {
      store?.close();
      release();
    }
  });
  app.post('/api/resolve', async (req) => {
    idle();
    const { c, v } = ready();
    const input = z
      .object({
        migration: z.string().uuid(),
        item: z.string().regex(/^[a-f0-9]{64}$/),
        link: z.string().regex(/^\d+$/).optional(),
        appendAgain: z.boolean().optional(),
        retryRead: z.boolean().optional(),
        acceptDuplicateRisk: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    if (
      (input.appendAgain && !input.acceptDuplicateRisk) ||
      [input.link, input.appendAgain, input.retryRead].filter(Boolean).length > 1
    )
      throw new Fault('invalid_resolution');
    const release = lock(c.stateDirectory);
    let store: Store | undefined;
    try {
      store = new Store(c.stateDirectory);
      checkPlan(store.plan(input.migration), c);
      await resolveItem(c, v, factory, store, input.migration, input.item, input);
      lastReport = report(store, input.migration);
      return lastReport;
    } finally {
      store?.close();
      release();
    }
  });
  app.post('/api/cancel', async () => {
    cancel();
    return { cancellationRequested: true };
  });
  app.get('/api/report', async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="migration-report.json"');
    return lastReport ?? { status: 'no_report' };
  });
  app.get('/api/plan/download', async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="migration-plan.json"');
    return plan ?? { status: 'no_plan' };
  });
  const root = fileURLToPath(new URL('../web-dist/', import.meta.url));
  if (existsSync(root)) await app.register(fastifyStatic, { root, index: false });
  app.get('/', async (_req, reply) => {
    if (!existsSync(join(root, 'index.html')))
      return reply.code(503).send('Run npm run build before starting the UI.');
    return reply.type('text/html').send(readFileSync(join(root, 'index.html'), 'utf8'));
  });
  return {
    app,
    token,
    cancel,
    isRunning: () => running || discovery?.status === 'running',
  };
}
export async function startWeb(port: number, state: string, reports: string, host = '127.0.0.1') {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Fault('invalid_port', 3);
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Fault('invalid_listen_host', 3);
  const web = await createWeb(port, state, reports);
  await web.app.listen({ host, port });
  console.log(
    `Open http://127.0.0.1:${port}/#${web.token}\nKeep this process running. Treat this local session link as private.`,
  );
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    web.cancel();
    const timer = setInterval(() => {
      if (!web.isRunning()) {
        clearInterval(timer);
        void web.app.close();
      }
    }, 250);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
