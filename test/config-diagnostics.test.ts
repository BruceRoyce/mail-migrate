import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fake.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { Fault, errorPayload } from '../src/safety.js';

test('configuration diagnostics identify invalid fields without printing their values', () => {
  const f = fixture(),
    config = structuredClone(f.c);
  config.mailboxes[0]!.id = 'sensitive@example.invalid';
  config.mailboxes[0]!.source.host = 'https://private.invalid/password-secret';
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => {
      assert.ok(error instanceof Fault);
      const payload = errorPayload(error);
      assert.equal(payload.error, 'invalid_configuration');
      assert.ok(
        payload.issues?.some(
          (i) => i.path === 'config.mailboxes[0].id' && i.message.includes('hyphens'),
        ),
      );
      assert.ok(
        payload.issues?.some(
          (i) => i.path === 'config.mailboxes[0].source.host' && i.message.includes('hostname'),
        ),
      );
      assert.doesNotMatch(JSON.stringify(payload), /sensitive@|private\.invalid|password-secret/);
      return true;
    },
  );
});
test('schema unknown keys and dynamic record keys never enter diagnostics', () => {
  const f = fixture();
  const c = { ...f.c, 'password-as-a-key': true };
  assert.throws(
    () => validateConfig(c),
    (error: unknown) => {
      assert.doesNotMatch(JSON.stringify(errorPayload(error)), /password-as-a-key/);
      return true;
    },
  );
  const config = structuredClone(f.c);
  config.mailboxes[0]!.folders.overrides = { 'sensitive-record-key': 123 as unknown as string };
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => {
      const payload = errorPayload(error);
      assert.ok(payload.issues?.[0]?.path.includes('[entry]'));
      assert.doesNotMatch(JSON.stringify(payload), /sensitive-record-key/);
      return true;
    },
  );
});
test('missing configuration file differs from malformed YAML; syntax errors report positions, not snippets', () => {
  const f = fixture(),
    file = join(f.base, 'bad.yaml');
  assert.throws(
    () => loadConfig(file),
    (e: unknown) => e instanceof Fault && e.category === 'configuration_file_not_found',
  );
  writeFileSync(file, 'version: 1\nmailboxes: [private-password-marker\n');
  assert.throws(
    () => loadConfig(file),
    (error: unknown) => {
      const payload = errorPayload(error);
      assert.equal(payload.error, 'invalid_configuration');
      assert.match(payload.issues![0]!.path, /line \d+, column \d+/);
      assert.doesNotMatch(JSON.stringify(payload), /private-password-marker/);
      return true;
    },
  );
});
test('insufficient memory reports the required allowance without dumping configuration', () => {
  const f = fixture();
  f.c.defaults.maxOccurrences = 20000;
  assert.throws(
    () => validateConfig(f.c),
    (error: unknown) => {
      const payload = errorPayload(error);
      assert.equal(payload.error, 'memory_budget_too_small');
      assert.match(payload.issues![0]!.message, /at least 655 MiB/);
      return true;
    },
  );
});
