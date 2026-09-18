import { createHash } from 'node:crypto';
export const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export type ValidationIssue = { path: string; message: string };
export class Fault extends Error {
  constructor(
    public category: string,
    public exit = 2,
    public issues?: ValidationIssue[],
  ) {
    super(category);
  }
}
export function errorPayload(error: unknown): { error: string; issues?: ValidationIssue[] } {
  return {
    error: category(error),
    ...(error instanceof Fault && error.issues ? { issues: error.issues } : {}),
  };
}
export function category(error: unknown): string {
  if (error instanceof Fault) return error.category;
  const e = error as { code?: string; serverResponseCode?: string; authenticationFailed?: boolean };
  if (e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED')
    return 'authentication';
  if (['OVERQUOTA', 'LIMIT', 'APPENDLIMIT', 'TOOBIG'].includes(e?.serverResponseCode ?? ''))
    return 'quota_or_size';
  if (
    [
      'EAI_AGAIN',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'SocketTimeout',
      'NoConnection',
    ].includes(e?.code ?? '')
  )
    return 'network';
  if (['ENOSPC', 'SQLITE_FULL', 'SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(e?.code ?? ''))
    return 'state_failure';
  if (/CERT|TLS|SELF_SIGNED/.test(e?.code ?? '')) return 'tls';
  return 'access_or_provider'; // Never expose arbitrary server messages, subjects or credentials.
}
export async function readRetry<T>(action: () => Promise<T>, stop = () => false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (e) {
      if (category(e) !== 'network' || attempt >= 2 || stop()) throw e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.random() * 100));
    }
  }
}
