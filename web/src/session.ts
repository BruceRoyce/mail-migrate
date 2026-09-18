const storageKey = 'mail-migrate.session-token';
const validToken = (value: string) => /^[a-f0-9]{64}$/.test(value);
let token = '';

function remember(value: string): void {
  try {
    if (value) sessionStorage.setItem(storageKey, value);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Restricted browser storage must not prevent use of the original session link.
  }
}

export function setSessionToken(value: string): void {
  if (!validToken(value))
    throw new Error('Use the complete private session link printed in PowerShell.');
  token = value;
  remember(value);
}

export function getSessionToken(): string {
  return token;
}

export class SessionExpired extends Error {
  constructor(public obsolete = false) {
    super(
      'The local session has expired or is missing. Reconnect using the current PowerShell session link.',
    );
  }
}

export function rejectSession(usedToken: string): SessionExpired {
  const obsolete = usedToken !== token;
  if (!obsolete) {
    token = '';
    remember('');
  }
  return new SessionExpired(obsolete);
}

export function tokenFromLink(link: string): string {
  let value = link.trim();
  if (!validToken(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        'Paste the complete private session link from PowerShell, including the part after #.',
      );
    }
    if (url.origin !== location.origin || url.username || url.password)
      throw new Error(
        'Use the PowerShell session link for this address and port. Open a different address in a separate tab.',
      );
    value = url.hash.slice(1);
  }
  if (!validToken(value))
    throw new Error('The session link must include the complete token after #.');
  return value;
}

export function takeFragment(): string | undefined {
  if (!location.hash) return undefined;
  const value = location.hash.slice(1);
  history.replaceState(null, '', location.pathname + location.search);
  return value;
}

const fragment = takeFragment();
if (fragment !== undefined) {
  // A new explicit link wins over any saved token, including an invalid new link.
  remember('');
  if (validToken(fragment)) setSessionToken(fragment);
} else {
  try {
    const saved = sessionStorage.getItem(storageKey) ?? '';
    if (validToken(saved)) token = saved;
  } catch {
    /* Continue without a token; show the reconnect form. */
  }
}
