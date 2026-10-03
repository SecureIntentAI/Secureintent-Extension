import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { type ActiveEntitlement, getActiveEntitlement } from '@/lib/entitlement';
import type { RefreshResult } from '@/lib/entitlement/refresh';
import { AccountSection } from './AccountSection';

// Which browser path is under test. Chrome runs the Clerk SDK bar; Firefox runs
// the cookie-driven bar — both have to show the same team information.
const { sdkEnabled } = vi.hoisted(() => ({ sdkEnabled: { value: true } }));

vi.mock('@/lib/clerkConfig', () => ({
  ACCOUNT_URL: 'https://secureintent.ai/account.html',
  TEAM_URL: 'https://secureintent.ai/team.html',
  isAuthEnabled: () => true,
  isClerkSdkEnabled: () => sdkEnabled.value,
}));

// Stand-in for the Clerk SDK: `Show when="signed-in"` renders, signed-out doesn't.
vi.mock('@clerk/chrome-extension', () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }) =>
    when === 'signed-in' ? children : null,
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: 'dev@acme.com' } } }),
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
afterEach(() => cleanup());

describe('AccountSection — Chrome (Clerk SDK)', () => {
  test('a team seat names the team on the plan badge', async () => {
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
