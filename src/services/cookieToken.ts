import { browser } from '#imports';
import { API_BASE } from '@/lib/api/client';
import { withDeadline } from '@/lib/async';
import { CLERK_PUBLISHABLE_KEY, CLERK_SYNC_HOST, WEB_APP_URL } from '@/lib/clerkConfig';

type Session = { token: string; sub: string; sid: string; exp: number };
type Snapshot = { session: Session | null; proof: string; key: string };
const FRESH_MARGIN_MS = 10_000;
let suffix: Promise<string> | undefined;
let generation = 0;
let cached: { key: string; session: Session } | undefined;
let pending:
  | { key: string; controller: AbortController; promise: Promise<string | null> }
  | undefined;
let failure: { key: string; until: number; denied: boolean } | undefined;

function cookieSuffix(): Promise<string> {
  suffix ??= crypto.subtle
    .digest('SHA-1', new TextEncoder().encode(CLERK_PUBLISHABLE_KEY))
    .then((digest) =>
      btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .slice(0, 8),
    );
  return suffix;
}

// Decode only for routing/binding. The API verifies every token and the returned
// entitlement/policy is separately signature checked by the extension.
function sessionHint(token: string): Session | null {
  if (token.length > 8_192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const value = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (
      typeof value.sub !== 'string' ||
      typeof value.sid !== 'string' ||
      !Number.isFinite(value.exp)
    )
      return null;
    return { token, sub: value.sub, sid: value.sid, exp: value.exp };
  } catch {
    return null;
  }
}

async function cookie(url: string, name: string): Promise<string> {
  return (await browser.cookies.get({ url, name }))?.value ?? '';
}

async function snapshot(): Promise<Snapshot> {
  const instance = await cookieSuffix();
  const candidates: Session[] = [];
  // Suffixed cookies take precedence. Never select another Clerk instance by
  // prefix alone. __client_uat=0 is Clerk's explicit signed-out marker.
  const uat =
    (await cookie(WEB_APP_URL, `__client_uat_${instance}`)) ||
    (await cookie(WEB_APP_URL, '__client_uat'));
  if (uat === '0') return { session: null, proof: '', key: 'signed-out' };
  for (const url of [WEB_APP_URL, CLERK_SYNC_HOST]) {
    const value = (await cookie(url, `__session_${instance}`)) || (await cookie(url, '__session'));
    const session = sessionHint(value);
    if (session) candidates.push(session);
  }
  const first = candidates[0];
  // A fresh FAPI cookie for this session must not be masked by the web app's
  // expired copy. A different account never silently replaces the app account.
  const session = first
    ? candidates
        .filter((s) => s.sub === first.sub && s.sid === first.sid)
        .sort((a, b) => b.exp - a.exp)[0]
    : null;
  const proof =
    (await cookie(CLERK_SYNC_HOST, `__client_${instance}`)) ||
    (await cookie(CLERK_SYNC_HOST, '__client'));
  return { session, proof, key: JSON.stringify([session?.token, proof, uat]) };
}

/** Cancel old-account work immediately. No client proof or JWT is persisted. */
export function invalidateCookieSession(): void {
  generation++;
  cached = undefined;
  failure = undefined;
  const old = pending;
  pending = undefined;
  old?.controller.abort();
}

/** Who is signed in, ignoring the token itself: Clerk rotates that every minute. */
async function identity(): Promise<string> {
  const { session, key } = await snapshot();
  if (key === 'signed-out') return 'signed-out';
  return session ? `${session.sub}:${session.sid}` : 'none';
}

/**
 * Install only in the Firefox background; web sign-out/account switches sync live.
 * Clerk's page script rewrites the session cookie every few seconds while a
 * secureintent.ai tab is open. Only a change of account, session or sign-in
 * state counts: reacting to every rotation cancelled plan checks mid-flight
 * and showed "Couldn't check your plan" for a healthy session.
 */
export function watchCookieSession(onChange: () => void): void {
  const hosts = [WEB_APP_URL, CLERK_SYNC_HOST].map((url) => new URL(url).hostname);
  let known: Promise<string> = identity().catch(() => 'unknown');
  browser.cookies.onChanged.addListener((change) => {
    const domain = change.cookie.domain.replace(/^\./, '');
    if (!hosts.some((host) => host === domain || host.endsWith(`.${domain}`))) return;
    // Serialised, so a burst of cookie writes is compared in order.
    known = known.then(async (previous) => {
      try {
        const instance = await cookieSuffix();
        if (
          !['__session', '__client', '__client_uat'].some(
            (name) => change.cookie.name === name || change.cookie.name === `${name}_${instance}`,
          )
        )
          return previous;
        const current = await identity();
        if (current !== previous) {
          invalidateCookieSession();
          onChange();
        }
        return current;
      } catch {
        return previous;
      }
    });
  });
}

/** Renew an expired Firefox JWT using the verified HttpOnly Clerk client proof. */
export async function getClerkTokenFromCookie(): Promise<string | null> {
  const version = generation;
  const current = await snapshot();
  if (version !== generation) throw new Error('Session changed');
  if (!current.session) return null;
  const session = current.session;
  if (current.session.exp * 1_000 > Date.now() + FRESH_MARGIN_MS) return current.session.token;
  if (cached?.key === current.key && cached.session.exp * 1_000 > Date.now() + FRESH_MARGIN_MS)
    return cached.session.token;
  if (failure?.key === current.key && failure.until > Date.now()) {
    if (failure.denied) return null;
    throw new Error('Session renewal temporarily unavailable');
  }
  if (!current.proof)
    throw new Error('Sign in on the SecureIntent account page to renew this session');
  if (pending?.key === current.key) return pending.promise;
  pending?.controller.abort();
  const controller = new AbortController();
  const promise = withDeadline(
    async (signal) => {
      const response = await fetch(`${API_BASE}/v1/auth/session/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: session.token, clientToken: current.proof }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal,
      });
      if (version !== generation || (await snapshot()).key !== current.key)
        throw new Error('Session changed');
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) {
        failure = { key: current.key, until: Number.POSITIVE_INFINITY, denied: true };
        cached = undefined;
        return null;
      }
      if (!response.ok) {
        const retry = Number(response.headers.get('Retry-After'));
        failure = {
          key: current.key,
          until:
            Date.now() + (Number.isFinite(retry) ? Math.min(300, Math.max(30, retry)) : 30) * 1_000,
          denied: false,
        };
        throw new Error('Session renewal temporarily unavailable');
      }
      const data = (await response.json()) as { token?: unknown };
      const fresh = typeof data.token === 'string' ? sessionHint(data.token) : null;
      if (
        !fresh ||
        fresh.sub !== session.sub ||
        fresh.sid !== session.sid ||
        fresh.exp * 1_000 <= Date.now() + FRESH_MARGIN_MS
      )
        throw new Error('Invalid renewed session');
      if (version !== generation || (await snapshot()).key !== current.key)
        throw new Error('Session changed');
      signal.throwIfAborted();
      cached = { key: current.key, session: fresh };
      failure = undefined;
      return fresh.token;
    },
    controller,
    9_000,
  )
    .catch((error) => {
      if (version === generation && !failure)
        failure = { key: current.key, until: Date.now() + 30_000, denied: false };
      throw error;
    })
    .finally(() => {
      if (pending?.controller === controller) pending = undefined;
    });
  pending = { key: current.key, controller, promise };
  return promise;
}

/** Identity hint remains available during outages; this does not grant access. */
export async function getClerkUserIdFromCookie(): Promise<string | null> {
  return (await snapshot()).session?.sub ?? null;
}
