import { mkdirSync, writeFileSync } from 'node:fs';
import { fixture } from './fake.js';
import { makePlan } from '../src/plan.js';
import { Store } from '../src/store.js';
import { execute } from '../src/engine.js';
mkdirSync('docs/samples', { recursive: true });
for (const scenario of ['complete', 'ambiguous', 'incomplete'] as const) {
  const f = fixture();
  f.source.folders.get('INBOX')!.add();
  const p = await makePlan(f.c, f.values, f.factory);
  if (scenario === 'ambiguous') f.destination.fault = 'after';
  if (scenario === 'incomplete') f.source.folders.get('INBOX')!.messages.clear();
  mkdirSync(f.c.stateDirectory);
  const s = new Store(f.c.stateDirectory, true);
  try {
    const r = await execute(f.c, f.values, f.factory, s, p);
    writeFileSync(
      `docs/samples/${scenario}.json`,
      JSON.stringify({ ...r, synthetic: true }, null, 2) + '\n',
    );
  } finally {
    s.close();
  }
}
