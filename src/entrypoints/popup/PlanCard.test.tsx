import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { ActiveEntitlement } from '@/lib/entitlement';
import type { QuotaStatus } from '@/lib/quota';
import { PlanCard } from './PlanCard';

// The card is a view over the cached entitlement + allowance; both are mocked so
// each plan/quota/team combination is deterministic.
const { entValue, getActiveEntitlement, getAnonymizeStatus, getActiveBundle } = vi.hoisted(() => ({
  entValue: { current: {} as unknown },
  getActiveEntitlement: vi.fn(),
  getAnonymizeStatus: vi.fn(),
  getActiveBundle: vi.fn(),
}));

vi.mock('@/lib/entitlement', () => ({
  entitlementItem: { getValue: async () => entValue.current },
  getActiveEntitlement,
}));
vi.mock('@/lib/quota', () => ({ getAnonymizeStatus }));
vi.mock('@/lib/config', () => ({ getActiveBundle }));
vi.mock('@/lib/clerkConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/clerkConfig')>()),
  isAuthEnabled: () => true,
}));

/** A bundle as the Worker serves it: default patterns bare, team ones marked. */
const bundleWith = (teamPatterns: number) => ({
  version: 9,
  killSwitch: false,
  sites: {},
  patterns: [
    { type: 'known-key', label: 'AWS access key ID', regex: 'AKIA[0-9A-Z]{16}' },
    ...Array.from({ length: teamPatterns }, (_, i) => ({
      type: 'known-key' as const,
      label: `Acme rule ${i}`,
      regex: `ACME${i}-[A-Z0-9]{6}`,
      origin: 'team' as const,
    })),
  ],
});

const FREE: ActiveEntitlement = {
  plan: 'developer',
  tier: 'free',
  trial: { state: 'none', endsAt: null },
  pro: false,
  features: [],
  source: 'none',
  businessDomain: null,
  email: null,
  org: null,
};
const seat = (role: string, name: string | null = 'Acme Corp'): ActiveEntitlement => ({
  ...FREE,
  plan: 'business_pro',
  tier: 'business',
  pro: true,
  features: ['rehydrate', 'ghost', 'session_lock'],
  source: 'org_seat',
  org: { id: 'org_1', name, role },
});
const QUOTA: QuotaStatus = { used: 1, remaining: 9, limit: 10, unlimited: false };

beforeEach(() => {
  fakeBrowser.reset();
  entValue.current = null;
  getActiveEntitlement.mockReset().mockResolvedValue(FREE);
  getAnonymizeStatus.mockReset().mockResolvedValue(QUOTA);
  getActiveBundle.mockReset().mockResolvedValue(bundleWith(0));
});
afterEach(() => cleanup());

describe('PlanCard', () => {
  test('renders the plan tag and the feature checklist', async () => {
    render(<PlanCard />);
    expect(await screen.findByText('Browser Free')).toBeTruthy();
    expect(screen.getByText('Ghost Log Sanitiser')).toBeTruthy();
    expect(screen.getByText('9 / 10 left')).toBeTruthy();
  });

  // P1-16: a seat holder is told whose plan this is.
  test("a team member is told the seat is their team's and who manages it", async () => {
    getActiveEntitlement.mockResolvedValue(seat('org:member'));
    render(<PlanCard />);
    expect(await screen.findByText(/Acme Corp/)).toBeTruthy();
    expect(screen.getByText(/managed by your admin/i)).toBeTruthy();
  });

  test('a team admin is told they administer the team', async () => {
    getActiveEntitlement.mockResolvedValue(seat('org:admin'));
    render(<PlanCard />);
    expect(await screen.findByText(/you administer this team/i)).toBeTruthy();
  });

  test('a personal plan says nothing about a team', async () => {
    getActiveEntitlement.mockResolvedValue({
      ...FREE,
      plan: 'developer_pro',
      tier: 'browser_pro',
      pro: true,
    });
    render(<PlanCard />);
    await screen.findByText('Browser Pro');
    expect(screen.queryByText(/managed by your admin/i)).toBeNull();
  });

  // Team rules: quiet reassurance for a member, and nothing at all for everyone else.
  test("a member whose bundle carries team patterns is told the team's rules are active", async () => {
    getActiveEntitlement.mockResolvedValue(seat('org:member'));
    getActiveBundle.mockResolvedValue(bundleWith(3));
    render(<PlanCard />);
    expect(await screen.findByText(/3 rules from your team's admin are active/i)).toBeTruthy();
    expect(screen.getByText('Team rules')).toBeTruthy();
  });

  test('a single team rule reads in the singular', async () => {
    getActiveEntitlement.mockResolvedValue(seat('org:admin'));
    getActiveBundle.mockResolvedValue(bundleWith(1));
    render(<PlanCard />);
    expect(await screen.findByText(/1 rule from your team's admin is active/i)).toBeTruthy();
  });

  test('a user with no team sees nothing about team rules', async () => {
    const { container } = render(<PlanCard />); // FREE + a bundle with no team patterns
    await screen.findByText('Browser Free');
    expect(container.querySelector('.si-plan-team-rules')).toBeNull();
    expect(screen.queryByText('Team rules')).toBeNull();
  });

  test('a team with no patterns of its own sees nothing either', async () => {
    getActiveEntitlement.mockResolvedValue(seat('org:member'));
    const { container } = render(<PlanCard />);
    await screen.findByText(/Acme Corp/);
    expect(container.querySelector('.si-plan-team-rules')).toBeNull();
  });

  test('an unreadable bundle never breaks the card — it just says nothing', async () => {
    getActiveBundle.mockRejectedValue(new Error('storage unavailable'));
    const { container } = render(<PlanCard />);
    expect(await screen.findByText('Browser Free')).toBeTruthy();
    expect(container.querySelector('.si-plan-team-rules')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // P1-17: a failed read used to leave an aria-hidden skeleton on screen forever.
  test('a failed load shows a visible error with a retry, not an endless skeleton', async () => {
    getActiveEntitlement.mockRejectedValueOnce(new Error('storage unavailable'));
    const { container } = render(<PlanCard />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn't load your plan/i);
    expect(container.querySelector('.si-plan--skeleton')).toBeNull();

    // Retry recovers: the next read succeeds and the checklist appears.
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText('Browser Free')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a live-refresh failure keeps the cached plan on screen', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('no background'));
    render(<PlanCard />);
    expect(await screen.findByText('Browser Free')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // KAU-58: the 30-day trial. From the extension it is Browser Pro (15 Nov 2026).
  describe('free trial', () => {
    const NOW_SEC = Math.floor(Date.now() / 1000);

    test('a running trial shows the days left', async () => {
      getActiveEntitlement.mockResolvedValue({
        ...FREE,
        plan: 'developer_pro',
        tier: 'desktop_pro',
        pro: true,
        source: 'trial',
        trial: { state: 'active', endsAt: NOW_SEC + 12 * 86_400 - 60 },
      });
      render(<PlanCard />);
      expect(await screen.findByText('12 days left')).toBeTruthy();
      expect(screen.queryByText(/Start 30-day/)).toBeNull();
    });

    test('an ended Browser Pro trial says so, and Upgrade opens the account page on Browser Pro', async () => {
      getActiveEntitlement.mockResolvedValue({
        ...FREE,
        trial: { state: 'used', endsAt: NOW_SEC - 86_400, product: 'browser_pro' },
      });
      const open = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never);
      render(<PlanCard />);
      expect(await screen.findByText('Your Browser Pro trial has ended.')).toBeTruthy();
      fireEvent.click(screen.getByText('Upgrade to Browser Pro'));
      expect(open).toHaveBeenCalledWith({
        url: expect.stringMatching(/account\.html\?plan=browser_pro&interval=monthly$/),
      });
    });

    test('Start trial asks the background for Browser Pro, then shows the countdown', async () => {
      const available = {
        ...FREE,
        trial: {
          state: 'available' as const,
          endsAt: null,
          available: ['browser_pro' as const, 'desktop_pro' as const],
        },
      };
      getActiveEntitlement.mockResolvedValue(available);
      const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) => {
        if ((msg as { type: string }).type === 'si-start-trial') {
          getActiveEntitlement.mockResolvedValue({
            ...FREE,
            plan: 'developer_pro',
            tier: 'browser_pro',
            pro: true,
            source: 'trial',
            trial: { state: 'active', endsAt: NOW_SEC + 30 * 86_400, product: 'browser_pro' },
          });
          return { ok: true };
        }
        return { status: 'unchanged' };
      });
      render(<PlanCard />);
      fireEvent.click(await screen.findByText('Start 30-day Browser Pro trial'));
      expect(await screen.findByText('30 days left')).toBeTruthy();
      expect(screen.getByText(/Browser Pro trial:/)).toBeTruthy();
      expect(send).toHaveBeenCalledWith({ type: 'si-start-trial', product: 'browser_pro' });
    });

    test('a refused start says why, in plain words', async () => {
      getActiveEntitlement.mockResolvedValue({
        ...FREE,
        trial: { state: 'available', endsAt: null, available: ['browser_pro'] },
      });
      vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) =>
        (msg as { type: string }).type === 'si-start-trial'
          ? { ok: false, reason: 'not_open' }
          : { status: 'unchanged' },
      );
      render(<PlanCard />);
      fireEvent.click(await screen.findByText('Start 30-day Browser Pro trial'));
      expect((await screen.findByRole('alert')).textContent).toMatch(/aren't open yet/);
    });
  });
});
