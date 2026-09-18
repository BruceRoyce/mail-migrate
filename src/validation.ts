import type { ZodError } from 'zod';
import type { ValidationIssue } from './safety.js';

// Never forward Zod messages, input values, unknown field names or record keys.
// Those can contain credentials or arbitrary text from a malformed document.
const fields = new Set([
  'version',
  'stateDirectory',
  'reportDirectory',
  'defaults',
  'mailboxes',
  'id',
  'source',
  'destination',
  'host',
  'port',
  'tlsMode',
  'username',
  'auth',
  'type',
  'secretRef',
  'caFile',
  'folders',
  'exclude',
  'overrides',
  'labelStrategy',
  'mailboxConcurrency',
  'messageConcurrency',
  'verification',
  'sourceWrites',
  'existingDestinationPolicy',
  'includeSpamAndTrash',
  'maxMessageBytes',
  'memoryBudgetMiB',
  'maxOccurrences',
  'timeoutSeconds',
  'candidateLimit',
  'password',
  'maxMessageMiB',
  'pilot',
  'mailbox',
  'migration',
  'hash',
  'confirm',
  'mode',
  'item',
  'link',
  'appendAgain',
  'retryRead',
  'acceptDuplicateRisk',
]);
const hints: Record<string, string> = {
  host: 'Enter only the IMAP hostname or IP address, without a URL scheme, path or spaces. Set the port separately.',
  port: 'Use an integer port from 1 to 65535 (usually 993 for implicit TLS or 143 for STARTTLS). In YAML, do not quote the number.',
  tlsMode: 'Choose implicit or starttls.',
  username: 'Enter a nonempty username without control characters.',
  password: 'Enter the password or app password in this password field.',
  caFile: 'Omit this optional field or provide a nonempty path to a trusted CA file.',
  id: 'Use 1–64 letters, digits, underscores or hyphens for the mailbox identifier; spaces and email-address punctuation are not allowed.',
  secretRef:
    'Use env:VARIABLE_NAME or file:./account.secret. Do not put a password directly in the configuration.',
  type: 'Only password authentication (including app passwords) is supported.',
  version: 'Use configuration version 1 as a number, not a quoted string.',
  mailboxConcurrency: 'Only 1 mailbox pair at a time is supported.',
  messageConcurrency: 'Only 1 message at a time is supported.',
  verification: 'Only full verification is supported.',
  sourceWrites: 'Must be false; source modifications are not supported.',
  existingDestinationPolicy: 'Must be preserve.',
  labelStrategy: 'Use unresolved or explicit-folders.',
};
export function validationIssues(error: ZodError, root = 'config'): ValidationIssue[] {
  return error.issues.map((issue) => {
    let path = root;
    let recordKey = false;
    for (const segment of issue.path) {
      path +=
        typeof segment === 'number'
          ? `[${segment}]`
          : recordKey || !fields.has(String(segment))
            ? '[entry]'
            : '.' + String(segment);
      recordKey = segment === 'overrides';
    }
    const field = String(issue.path.at(-1) ?? '');
    let message = 'Invalid value; check the example configuration.';
    if (issue.code === 'unrecognized_keys')
      message =
        'Contains unsupported fields. Compare this section with migration.example.yaml; direct password fields are not allowed in YAML.';
    else if (hints[field] && !issue.path.includes('overrides')) message = hints[field]!;
    else if (issue.code === 'invalid_type') {
      const types: Record<string, string> = {
        string: 'text',
        number: 'a number',
        boolean: 'true or false',
        object: 'an object',
        array: 'a list',
      };
      message = 'Required value must be ' + (types[issue.expected] ?? 'the documented type') + '.';
    } else if (issue.code === 'too_small' && typeof issue.minimum === 'number')
      message = `Value is too small; minimum is ${issue.minimum}.`;
    else if (issue.code === 'too_big' && typeof issue.maximum === 'number')
      message = `Value is too large; maximum is ${issue.maximum}.`;
    else if (issue.code === 'custom') message = 'Use nonempty text without control characters.';
    return { path, message };
  });
}
