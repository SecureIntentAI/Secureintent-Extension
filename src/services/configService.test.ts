import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { getPolicy } from '@/lib/config/policy';
import { getActiveBundle, saveBundle } from '@/lib/config/store';
import type { BundlePolicy } from '@/lib/config/types';
import { syncConfig } from './configService';

// The Worker resolves the caller's org from the Clerk session token, so config
// sync carries it when there is one. Mocked: real minting needs the Clerk SDK.
const { getClerkTokenMock } = vi.hoisted(() => ({ getClerkTokenMock: vi.fn() }));
vi.mock('./entitlementBackground', () => ({ getClerkToken: getClerkTokenMock }));

beforeEach(() => {
  fakeBrowser.reset();
  getClerkTokenMock.mockReset();
  getClerkTokenMock.mockResolvedValue(null); // default: signed out
});
afterEach(() => vi.restoreAllMocks());

const PRIV = 'MC4CAQAwBQYDK2VwBCIEIDil5s2qLmnKUY2O5xpX+QTAWz58ZgCXmw6jxnzmxlBm';
async function sign(bundle: unknown): Promise<string> {
  const priv = Uint8Array.from(atob(PRIV), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', priv, { name: 'Ed25519' }, false, ['sign']);
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    key,
    new TextEncoder().encode(JSON.stringify(bundle)),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function mockConfig(bundle: unknown, signature: string | null, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ bundle, signature }), { status })),
  );
}

/** Headers the last fetch went out with (undefined when none were set). */
function lastRequestHeaders(): Record<string, string> | undefined {
  const call = vi.mocked(fetch).mock.calls.at(-1);
  return (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers;
}

const TEAM_POLICY: BundlePolicy = {
  blockInsteadOfWarn: true,
  requireSessionLock: true,
  extraPatterns: [],
  blockedSites: ['pastebin.com'],
  aiServices: [],
};

describe('syncConfig', () => {
  test('stores a newer valid bundle', async () => {
    const b = { ...DEFAULT_BUNDLE, version: 50 };
    mockConfig(b, await sign(b));
    const r = await syncConfig();
    expect(r.status).toBe('updated');
    expect((await getActiveBundle()).version).toBe(50);
  });
  test('ignores a bundle whose version is not newer', async () => {
    const b = { ...DEFAULT_BUNDLE, version: 50 };
    await saveBundle(b);
    mockConfig(b, await sign(b));
    const r = await syncConfig();
    expect(r.status).toBe('unchanged');
  });
  test('keeps the cached bundle when the fetch fails', async () => {
    await saveBundle({ ...DEFAULT_BUNDLE, version: 50 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const r = await syncConfig();
    expect(r.status).toBe('error');
    expect((await getActiveBundle()).version).toBe(50);
  });
  test('rejects an invalid bundle without overwriting cache', async () => {
    await saveBundle({ ...DEFAULT_BUNDLE, version: 50 });
    mockConfig({ version: 'bad' }, 'x');
    const r = await syncConfig();
    expect(r.status).toBe('error');
    expect((await getActiveBundle()).version).toBe(50);
  });
  test('rejects a bundle with a bad signature', async () => {
    await saveBundle({ ...DEFAULT_BUNDLE, version: 50 });
    const b = { ...DEFAULT_BUNDLE, version: 60 };
    mockConfig(b, 'AAAA');
    const r = await syncConfig();
    expect(r.status).toBe('error');
    expect(r.error).toBe('signature verification failed');
    expect((await getActiveBundle()).version).toBe(50);
  });
});

describe('syncConfig — org resolution', () => {
  test('sends the Clerk session token when one is available', async () => {
    getClerkTokenMock.mockResolvedValue('jwt-abc');
    const b = { ...DEFAULT_BUNDLE, version: 51 };
    mockConfig(b, await sign(b));

    expect((await syncConfig()).status).toBe('updated');
    expect(lastRequestHeaders()).toEqual({ Authorization: 'Bearer jwt-abc' });
  });

  test('signed out: the same anonymous request as before (no auth header)', async () => {
    getClerkTokenMock.mockResolvedValue(null);
    const b = { ...DEFAULT_BUNDLE, version: 52 };
    mockConfig(b, await sign(b));

    expect((await syncConfig()).status).toBe('updated');
    expect(lastRequestHeaders()).toBeUndefined();
  });

  test('a failure to mint the token never blocks config sync', async () => {
    // Config sync also carries the kill switch — it must survive a broken session.
    getClerkTokenMock.mockRejectedValue(new Error('clerk down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = { ...DEFAULT_BUNDLE, version: 53 };
    mockConfig(b, await sign(b));

    expect((await syncConfig()).status).toBe('updated');
    expect(lastRequestHeaders()).toBeUndefined();
    expect((await getActiveBundle()).version).toBe(53);
  });
});

describe('syncConfig — team policy', () => {
  test('stores the policy from a bundle whose signature verifies', async () => {
    getClerkTokenMock.mockResolvedValue('signed-in-test-session');
    const b = { ...DEFAULT_BUNDLE, version: 60, policy: TEAM_POLICY, policyVersion: 3 };
    mockConfig(b, await sign(b));

    expect((await syncConfig()).status).toBe('updated');
    const stored = await getActiveBundle();
    expect(stored.policyVersion).toBe(3);
    expect(getPolicy(stored)).toEqual(TEAM_POLICY);
  });

  test('a policy on an UNVERIFIED bundle is never honoured', async () => {
    // The signature is the whole trust anchor: no valid signature, no policy.
    await saveBundle({ ...DEFAULT_BUNDLE, version: 50 });
    mockConfig({ ...DEFAULT_BUNDLE, version: 61, policy: TEAM_POLICY }, 'AAAA');

    expect((await syncConfig()).error).toBe('signature verification failed');
    const stored = await getActiveBundle();
    expect(stored.policy).toBeUndefined();
    expect(getPolicy(stored).blockInsteadOfWarn).toBe(false);
  });

  test('a policy signed for an OLDER bundle version is not applied', async () => {
    await saveBundle({ ...DEFAULT_BUNDLE, version: 70 });
    const b = { ...DEFAULT_BUNDLE, version: 69, policy: TEAM_POLICY };
    mockConfig(b, await sign(b));

    expect((await syncConfig()).status).toBe('unchanged');
    expect(getPolicy(await getActiveBundle()).requireSessionLock).toBe(false);
  });

  test('a signed-in member stores a policy published at the current catalogue version', async () => {
    getClerkTokenMock.mockResolvedValue('jwt-abc');
    await saveBundle({ ...DEFAULT_BUNDLE, version: 12 });
    const b = {
      ...DEFAULT_BUNDLE,
      version: 12,
      policy: { ...TEAM_POLICY, orgId: 'org_acme' },
      policyVersion: 2,
    };
    mockConfig(b, await sign(b));

    expect((await syncConfig()).status).toBe('updated');
    expect(getPolicy(await getActiveBundle()).blockedSites).toEqual(['pastebin.com']);
    expect((await getActiveBundle()).policyVersion).toBe(2);
  });

  test('a signed-out refresh does not install or drop team rules at the same version', async () => {
    await saveBundle({
      ...DEFAULT_BUNDLE,
      version: 12,
      policy: { ...TEAM_POLICY, orgId: 'org_acme' },
      policyVersion: 2,
    });
    const plain = { ...DEFAULT_BUNDLE, version: 12 };
    mockConfig(plain, await sign(plain));

    expect((await syncConfig()).status).toBe('unchanged');
    expect(getPolicy(await getActiveBundle()).requireSessionLock).toBe(true);
  });

  test('leaving the team drops the policy when the signed-in bundle no longer carries one', async () => {
    getClerkTokenMock.mockResolvedValue('jwt-abc');
    await saveBundle({
      ...DEFAULT_BUNDLE,
      version: 12,
      policy: { ...TEAM_POLICY, orgId: 'org_acme' },
      policyVersion: 4,
    });
    const plain = { ...DEFAULT_BUNDLE, version: 12 };
    mockConfig(plain, await sign(plain));

    expect((await syncConfig()).status).toBe('updated');
    expect((await getActiveBundle()).policy).toBeUndefined();
  });

  test('regression: a bundle with no policy stores and reads back with none', async () => {
    const b = { ...DEFAULT_BUNDLE, version: 62 };
    mockConfig(b, await sign(b));

    expect((await syncConfig()).status).toBe('updated');
    const stored = await getActiveBundle();
    expect(stored.policy).toBeUndefined();
    expect(getPolicy(stored)).toEqual({
      blockInsteadOfWarn: false,
      requireSessionLock: false,
      extraPatterns: [],
      blockedSites: [],
      aiServices: [],
    });
  });
});
