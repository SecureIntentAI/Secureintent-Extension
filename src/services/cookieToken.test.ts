import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing';
import { browser } from '#imports';
import {
  getClerkTokenFromCookie,
  getClerkUserIdFromCookie,
  invalidateCookieSession,
  watchCookieSession,
} from './cookieToken';

vi.mock('@/lib/clerkConfig', () => ({
  CLERK_PUBLISHABLE_KEY: 'synthetic-publishable-key',
  WEB_APP_URL: 'https://app.example.test',
  CLERK_SYNC_HOST: 'https://clerk.example.test',
}));
const cookies = new Map<string, string>();
const app = 'https://app.example.test';
const fapi = 'https://clerk.example.test';
const jwt = (sub = 'user_one', sid = 'sess_one', seconds = 60) =>
  `e30.${btoa(JSON.stringify({ sub, sid, exp: Math.floor(Date.now() / 1000) + seconds })).replace(/=/g, '')}.sig`;
const put = (url: string, name: string, value: string) => cookies.set(`${url}/${name}`, value);
const expired = () => {
  put(app, '__session', jwt('user_one', 'sess_one', -60));
  put(fapi, '__client', 'synthetic-client-proof');
};
beforeEach(() => {
  invalidateCookieSession();
  fakeBrowser.reset();
  cookies.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(browser.cookies, 'get').mockImplementation(async ({ url, name }) => {
    const value = cookies.get(`${url}/${name}`);
    return value ? ({ value } as Browser.cookies.Cookie) : null;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ token: jwt() })),
  );
});
afterEach(() => {
  invalidateCookieSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('signed-out and malformed cookies never request a token', async () => {
  expect(await getClerkTokenFromCookie()).toBeNull();
  put(app, '__session', 'not-a-jwt');
  expect(await getClerkTokenFromCookie()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
test('a fresh FAPI copy of the same session wins over an expired app cookie', async () => {
  expired();
  const fresh = jwt();
  put(fapi, '__session', fresh);
  expect(await getClerkTokenFromCookie()).toBe(fresh);
  expect(fetch).not.toHaveBeenCalled();
});
test('a fresh app or FAPI-only session works without a renewal request', async () => {
  const fresh = jwt();
  put(app, '__session', fresh);
  expect(await getClerkTokenFromCookie()).toBe(fresh);
  cookies.clear();
  put(fapi, '__session', fresh);
  expect(await getClerkTokenFromCookie()).toBe(fresh);
  expect(fetch).not.toHaveBeenCalled();
});
test('concurrent renewal shares one request and caches only for this cookie binding', async () => {
  expired();
  const tokens = await Promise.all(Array.from({ length: 20 }, () => getClerkTokenFromCookie()));
  expect(new Set(tokens).size).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await getClerkTokenFromCookie()).toBe(tokens[0]);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toContain('/v1/auth/session/refresh');
  expect(init?.credentials).toBe('omit');
  expect(JSON.parse(init?.body as string)).toEqual({
    sessionToken: cookies.get(`${app}/__session`),
    clientToken: 'synthetic-client-proof',
  });
  expect(await browser.storage.local.get(null)).toEqual({});
});
test('an expired JWT alone does not authorize renewal; identity stays readable offline', async () => {
  expired();
  cookies.delete(`${fapi}/__client`);
  await expect(getClerkTokenFromCookie()).rejects.toThrow('Sign in');
  expect(await getClerkUserIdFromCookie()).toBe('user_one');
  expect(fetch).not.toHaveBeenCalled();
});
test('explicit signout defeats a stale cached renewal', async () => {
  expired();
  await getClerkTokenFromCookie();
  put(app, '__client_uat', '0');
  expect(await getClerkTokenFromCookie()).toBeNull();
  expect(await getClerkUserIdFromCookie()).toBeNull();
});
test('another FAPI account never replaces the web account', async () => {
  expired();
  put(fapi, '__session', jwt('user_other', 'sess_other'));
  expect(await getClerkTokenFromCookie()).toBeTypeOf('string');
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).sessionToken).toBe(
    cookies.get(`${app}/__session`),
  );
});
test.each([
  ['other user', () => jwt('user_other')],
  ['other session', () => jwt('user_one', 'sess_other')],
  ['expired', () => jwt('user_one', 'sess_one', -1)],
  ['malformed', () => 'invalid'],
])('rejects a renewed token with %s', async (_, token) => {
  expired();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ token: token() }));
  await expect(getClerkTokenFromCookie()).rejects.toThrow('Invalid renewed session');
});
test('a revoked proof signs out and is not retried until credentials change', async () => {
  expired();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect(await getClerkTokenFromCookie()).toBeNull();
  expect(await getClerkTokenFromCookie()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  put(fapi, '__client', 'new-synthetic-proof');
  expect(await getClerkTokenFromCookie()).toBeTypeOf('string');
});
test('provider outage backs off and preserves a recoverable session', async () => {
  expired();
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(null, { status: 503, headers: { 'Retry-After': '60' } }),
  );
  await expect(getClerkTokenFromCookie()).rejects.toThrow('temporarily unavailable');
  await expect(getClerkTokenFromCookie()).rejects.toThrow('temporarily unavailable');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await getClerkUserIdFromCookie()).toBe('user_one');
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  expect(await getClerkTokenFromCookie()).toBeTypeOf('string');
});
test('an account change during renewal discards the late response', async () => {
  expired();
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const renewal = getClerkTokenFromCookie();
  const rejected = expect(renewal).rejects.toThrow('Session changed');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  put(app, '__session', jwt('user_other', 'sess_other'));
  finish(Response.json({ token: jwt() }));
  await rejected;
  expect(await getClerkUserIdFromCookie()).toBe('user_other');
});
test('invalidation aborts a pending renewal and permits a new attempt', async () => {
  expired();
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
  const renewal = getClerkTokenFromCookie();
  const rejected = expect(renewal).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  invalidateCookieSession();
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(await getClerkTokenFromCookie()).toBeTypeOf('string');
});
test('a stuck renewal aborts within its deadline and backs off', async () => {
  expired();
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  const request = expect(getClerkTokenFromCookie()).rejects.toThrow('Request timed out');
  await vi.advanceTimersByTimeAsync(9_000);
  await request;
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  await expect(getClerkTokenFromCookie()).rejects.toThrow('temporarily unavailable');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('instance cookies take precedence and unrelated cookie changes are ignored', async () => {
  const digest = await webcrypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode('synthetic-publishable-key'),
  );
  const suffix = Buffer.from(digest).toString('base64url').slice(0, 8);
  put(app, '__session', jwt('user_other', 'sess_other'));
  put(app, `__session_${suffix}`, jwt());
  expect(await getClerkUserIdFromCookie()).toBe('user_one');
  const changed = vi.fn();
  vi.spyOn(browser.cookies.onChanged, 'addListener').mockImplementation(() => {});
  watchCookieSession(changed);
  const listener = vi.mocked(browser.cookies.onChanged.addListener).mock.calls.at(-1)![0];
  const change = (domain: string, name: string) =>
    listener({ cookie: { domain, name } } as Parameters<typeof listener>[0]);
  change('unrelated.test', '__session');
  change('app.example.test', '__session_otherInstance');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(changed).not.toHaveBeenCalled();
  change('app.example.test', `__session_${suffix}`);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
});
