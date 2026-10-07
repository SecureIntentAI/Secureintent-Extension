import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { browser } from '#imports';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { configItem } from '@/lib/config/store';
import { type ActiveEntitlement, getActiveEntitlement } from '@/lib/entitlement';
import type { RefreshResult } from '@/lib/entitlement/refresh';
import { AccountSection } from './AccountSection';

// Which browser path is under test. Chrome runs the Clerk SDK bar; Firefox runs
// the cookie-driven bar — both have to show the same team information.
const { sdkEnabled } = vi.hoisted(() => ({ sdkEnabled: { value: true } }));

vi.mock('@/lib/clerkConfig', () => ({
  ACCOUNT_URL: 'https://secureintent.ai/account.html',
  TEAM_URL: 'https://secureintent.ai/team.html#/overview',
  SHADOW_DASHBOARD_URL: 'https://secureintent.ai/team.html#/shadow',
  isAuthEnabled: () => true,
  isClerkSdkEnabled: () => sdkEnabled.value,
}));

// Stand-in for the Clerk SDK: `Show when="signed-in"` renders, signed-out doesn't.
vi.mock('@clerk/chrome-extension', () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }) =>
    when === 'signed-in' ? children : null,
  useUser: () => ({
    user: { id: 'user_member', primaryEmailAddress: { emailAddress: 'dev@acme.com' } },
  }),
}));

vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlement')>()),
  getActiveEntitlement: vi.fn(),
}));

const FREE: ActiveEntitlement = {
  plan: 'developer',
  pro: false,
  features: [],
  source: 'none',
  businessDomain: null,
  email: 'dev@acme.com',
  org: null,
};
const seat = (role: string): ActiveEntitlement => ({
  ...FREE,
  plan: 'business_pro',
  pro: true,
  source: 'org_seat',
  org: { id: 'org_1', name: 'Acme Corp', role },
});

function mockRefresh(result: RefreshResult | Error) {
  const spy = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
  if (result instanceof Error) spy.mockRejectedValue(result);
  else spy.mockResolvedValue(result);
  return spy;
}

beforeEach(() => {
  fakeBrowser.reset();
  sdkEnabled.value = true;
  vi.mocked(getActiveEntitlement).mockReset().mockResolvedValue(FREE);
  mockRefresh({ status: 'updated', plan: 'developer' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AccountSection — Chrome (Clerk SDK)', () => {
  test('a member sees Developer Pro protection and the team name', async () => {
    vi.mocked(getActiveEntitlement).mockResolvedValue(seat('org:member'));
    render(<AccountSection />);
    expect(await screen.findByText('Developer Pro · Acme Corp')).toBeTruthy();
  });

  test('an admin gets the team console link; a member does not', async () => {
    vi.mocked(getActiveEntitlement).mockResolvedValue(seat('org:admin'));
    const { unmount } = render(<AccountSection />);
    expect(await screen.findByText('Manage team')).toBeTruthy();
    unmount();

    vi.mocked(getActiveEntitlement).mockResolvedValue(seat('org:member'));
    render(<AccountSection />);
    await screen.findByText('Developer Pro · Acme Corp');
    expect(screen.queryByText('Manage team')).toBeNull();
    expect(screen.queryByText('Shadow AI')).toBeNull();
  });

  test('the Manage team row names the organisation and its seats', async () => {
    const admin = seat('org:admin');
    vi.mocked(getActiveEntitlement).mockResolvedValue({
      ...admin,
      org: { id: 'org_1', name: 'Acme Corp', role: 'org:admin', seats: 150 },
    });
    render(<AccountSection />);
    expect(await screen.findByText('Manage team')).toBeTruthy();
    expect(screen.getByText('Acme Corp · 150 seats')).toBeTruthy();
  });

  test('Manage team opens the canonical overview route directly', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create');
    vi.mocked(getActiveEntitlement).mockResolvedValue(seat('org:admin'));
    render(<AccountSection />);

    fireEvent.click(await screen.findByText('Manage team'));

    await waitFor(() =>
      expect(fakeBrowser.tabs.create).toHaveBeenCalledWith({
        url: 'https://secureintent.ai/team.html#/overview',
      }),
    );
  });

  // P1-17: a cleared entitlement used to silently read as "Free".
  test('a cleared entitlement is explained, and retry clears the message', async () => {
    const spy = mockRefresh({ status: 'cleared', error: 'user mismatch' });
    render(<AccountSection />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn't verify your Pro licence/i);

    spy.mockResolvedValue({ status: 'updated', plan: 'developer_pro' });
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('an unreachable background is reported instead of swallowed', async () => {
    mockRefresh(new Error('no receiving end'));
    render(<AccountSection />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn't check your plan/i);
  });

  test('a failed entitlement read still resolves the bar (no endless shimmer)', async () => {
    vi.mocked(getActiveEntitlement).mockRejectedValue(new Error('storage unavailable'));
    const { container } = render(<AccountSection />);
    await screen.findByRole('alert');
    expect(container.querySelector('.si-profile-plan--loading')).toBeNull();
  });
});

describe('AccountSection — Firefox (cookie auth)', () => {
  beforeEach(() => {
    sdkEnabled.value = false;
  });

  // P1-16: the Firefox bar had no org branch at all, so an admin was stranded.
  test('a team seat names the team and gives an admin the console link', async () => {
    vi.mocked(getActiveEntitlement).mockResolvedValue(seat('org:admin'));
    render(<AccountSection />);
    expect(await screen.findByText('Business Pro · Acme Corp')).toBeTruthy();
    expect(screen.getByText('Manage team')).toBeTruthy();
  });

  test('a member sees the team but no console link', async () => {
    vi.mocked(getActiveEntitlement).mockResolvedValue(seat('org:member'));
    render(<AccountSection />);
    await screen.findByText('Developer Pro · Acme Corp');
    expect(screen.queryByText('Manage team')).toBeNull();
    expect(screen.queryByText('Shadow AI')).toBeNull();
  });

  test('signed out shows the sign-in bar', async () => {
    mockRefresh({ status: 'signed-out' });
    render(<AccountSection />);
    expect(await screen.findByText('Not signed in')).toBeTruthy();
  });

  test('a failed refresh is visible and retryable', async () => {
    const spy = mockRefresh(new Error('no receiving end'));
    render(<AccountSection />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn't check your plan/i);

    spy.mockResolvedValue({ status: 'updated', plan: 'developer' });
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

const policyBundle = (version: number, orgId = 'org_1') => ({
  ...DEFAULT_BUNDLE,
  policyVersion: version,
  policy: { orgId, blockInsteadOfWarn: true, requireSessionLock: false, blockedSites: [] },
});

describe.each(['Chrome', 'Firefox'])('policy notice — %s', (browserName) => {
  beforeEach(() => {
    sdkEnabled.value = browserName === 'Chrome';
    vi.mocked(getActiveEntitlement).mockResolvedValue(seat('org:member'));
  });

  test('shows the same downloaded revision, remembers dismissal, then shows the next revision', async () => {
    await configItem.setValue(policyBundle(7));
    const mounted = render(<AccountSection />);
    expect(await screen.findByText('Team policy revision 7 downloaded')).toBeTruthy();
    fireEvent.click(screen.getByText('Got it'));
    await waitFor(() => expect(screen.queryByText('Team policy revision 7 downloaded')).toBeNull());
    const identity = browserName === 'Chrome' ? 'user_member' : 'dev@acme.com';
    await waitFor(async () =>
      expect(
        (await browser.storage.local.get(`si_policy_notice:${identity}:org_1`))[
          `si_policy_notice:${identity}:org_1`
        ],
      ).toBe(7),
    );
    mounted.unmount();
    render(<AccountSection />);
    await screen.findByText('Developer Pro · Acme Corp');
    expect(screen.queryByText('Team policy revision 7 downloaded')).toBeNull();
    await act(() => configItem.setValue(policyBundle(8)));
    expect(await screen.findByText('Team policy revision 8 downloaded')).toBeTruthy();
  });

  test('a policy for another organization is never announced and removing the bundle hides the notice', async () => {
    await configItem.setValue(policyBundle(99, 'org_other'));
    render(<AccountSection />);
    await screen.findByText('Developer Pro · Acme Corp');
    expect(screen.queryByText(/Team policy revision/)).toBeNull();
    await act(() => configItem.setValue(policyBundle(7)));
    await screen.findByText('Team policy revision 7 downloaded');
    await act(() => configItem.setValue(null));
    await waitFor(() => expect(screen.queryByText(/Team policy revision/)).toBeNull());
  });

  test('a slow older storage read cannot replace a newer policy notice', async () => {
    await configItem.setValue(policyBundle(7));
    render(<AccountSection />);
    await screen.findByText('Team policy revision 7 downloaded');
    let release!: (bundle: ReturnType<typeof policyBundle>) => void;
    const read = vi.spyOn(configItem, 'getValue').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await act(() => browser.storage.local.set({ notice_race_probe: 1 }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(() => configItem.setValue(policyBundle(8)));
    await screen.findByText('Team policy revision 8 downloaded');
    await act(async () => {
      release(policyBundle(7));
    });
    expect(screen.queryByText('Team policy revision 7 downloaded')).toBeNull();
    expect(screen.getByText('Team policy revision 8 downloaded')).toBeTruthy();
    read.mockRestore();
  });
});
