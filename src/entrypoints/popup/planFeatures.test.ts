import { describe, expect, it } from 'vitest';
import type { QuotaStatus } from '@/lib/quota';
import { buildPlanView } from './planFeatures';

const usage = (remaining: number, limit = 10): QuotaStatus => ({
  used: limit - remaining,
  remaining,
  limit,
  unlimited: false,
});
const unlimited: QuotaStatus = { used: 0, remaining: -1, limit: 10, unlimited: true };

const TOOLKIT = ['rehydrate', 'ghost', 'session_lock'];
const TEAM = ['team_policy'];
const AUGUST = Date.parse('2026-08-09T12:00:00Z');

describe('buildPlanView', () => {
  it('free plan: detection active, anonymise shows the monthly count', () => {
    const v = buildPlanView({ tier: 'free', pro: false, quota: usage(9) });
    expect(v.planLabel).toBe('Browser Free');
    expect(v.isPro).toBe(false);
    expect(v.rows[0]).toMatchObject({ key: 'detection', state: 'active', detail: 'Active' });
    expect(v.rows[1]).toMatchObject({ key: 'anonymise', state: 'usage', detail: '9 / 10 left' });
  });

  it('free plan: toolkit is locked (Pro), not active', () => {
    const v = buildPlanView({ tier: 'free', pro: false, quota: usage(9) });
    const toolkit = v.rows.filter((r) => TOOLKIT.includes(r.key));
    expect(toolkit).toHaveLength(3);
    expect(toolkit.every((r) => r.state === 'locked' && r.detail === 'Pro')).toBe(true);
  });

  it('pro plan: anonymise unlimited and toolkit active', () => {
    const v = buildPlanView({ tier: 'browser_pro', pro: true, quota: unlimited });
    expect(v.planLabel).toBe('Browser Pro');
    expect(v.isPro).toBe(true);
    expect(v.rows[1]).toMatchObject({ key: 'anonymise', state: 'active', detail: 'Unlimited' });
    const toolkit = v.rows.filter((r) => TOOLKIT.includes(r.key));
    expect(toolkit.every((r) => r.state === 'active' && r.detail === 'Active')).toBe(true);
  });

  // P1-15: Team Policy Sync ships today, so nothing may present it as future work.
  it('Business gets the team features as included, not "Soon"', () => {
    const v = buildPlanView({ tier: 'business', pro: true, quota: unlimited });
    expect(v.planLabel).toBe('Business');
    const team = v.rows.filter((r) => TEAM.includes(r.key));
    expect(team).toHaveLength(1);
    expect(team.every((r) => r.state === 'active' && r.detail === 'Active')).toBe(true);
  });

  it('lower tiers see the team features locked behind Business, never "Soon"', () => {
    for (const tier of ['free', 'browser_pro'] as const) {
      const v = buildPlanView({ tier, pro: tier !== 'free', quota: unlimited });
      const team = v.rows.filter((r) => TEAM.includes(r.key));
      expect(team).toHaveLength(1);
      // A Browser Pro user already has Pro, so "Pro" would be a dead end here.
      expect(team.every((r) => r.state === 'locked' && r.detail === 'Business')).toBe(true);
    }
  });

  // Product decision (Oct 2026): alerts arrive with the desktop app. It is the
  // only upcoming row, and it reads the same on every plan.
  it('only Security-Team Alerts is upcoming, on every plan', () => {
    for (const tier of ['free', 'browser_pro', 'desktop_pro', 'business'] as const) {
      const v = buildPlanView({ tier, pro: tier !== 'free', quota: usage(3) });
      expect(v.rows.filter((r) => r.state === 'soon').map((r) => r.key)).toEqual(['team_alerts']);
      expect(v.rows.find((r) => r.key === 'team_alerts')).toMatchObject({ detail: 'Coming soon' });
    }
  });

  // P1-18: 0 of 10 must not read like a user who never had the feature.
  it('spent allowance says when it resets instead of counting down', () => {
    const v = buildPlanView({
      tier: 'free',
      pro: false,
      quota: usage(0),
      nowMs: AUGUST,
    });
    const anon = v.rows.find((r) => r.key === 'anonymise')!;
    expect(anon.state).toBe('locked');
    expect(anon.detail).toBe('Resets Sep 1');
    expect(anon.note).toMatch(/used all 10 free anonymised pastes this month/i);
    expect(anon.note).toMatch(/Sep 1 \(UTC\)/);
  });

  it('signed out after launch: the row asks for sign-in, not a reset date', () => {
    const v = buildPlanView({
      tier: 'free',
      pro: false,
      quota: { ...usage(0), signInRequired: true },
      nowMs: AUGUST,
    });
    const anon = v.rows.find((r) => r.key === 'anonymise')!;
    expect(anon).toMatchObject({ state: 'locked', detail: 'Sign in' });
    expect(anon.note).toMatch(/free account includes 10/i);
  });

  // P1-16: a seat holder must be told the plan is their team's.
  it('carries the team through so the card can say who provides the seat', () => {
    const member = buildPlanView({
      tier: 'business',
      pro: true,
      quota: unlimited,
      org: { name: 'Acme Corp', role: 'org:member' },
    });
    expect(member.org).toEqual({ name: 'Acme Corp', isAdmin: false });

    const admin = buildPlanView({
      tier: 'business',
      pro: true,
      quota: unlimited,
      org: { name: null, role: 'org:admin' },
    });
    expect(admin.org).toEqual({ name: 'your team', isAdmin: true });
  });

  it("has no team when the plan is the user's own", () => {
    expect(buildPlanView({ tier: 'browser_pro', pro: true, quota: unlimited }).org).toBeNull();
  });

  // Team rules: the count the card uses to say the team's own rules are running.
  it('reports no team rules by default, so nothing about teams is shown', () => {
    expect(buildPlanView({ tier: 'free', pro: false, quota: usage(9) }).teamRules).toBe(0);
    expect(
      buildPlanView({ tier: 'free', pro: false, quota: usage(9), teamRules: 0 }).teamRules,
    ).toBe(0);
  });

  it("carries the team's own pattern count through to the view", () => {
    const v = buildPlanView({ tier: 'business', pro: true, quota: unlimited, teamRules: 3 });
    expect(v.teamRules).toBe(3);
  });

  it('clamps a nonsensical count rather than rendering it', () => {
    const at = (teamRules: number) =>
      buildPlanView({ tier: 'business', pro: true, quota: unlimited, teamRules }).teamRules;
    expect(at(-2)).toBe(0);
    expect(at(2.7)).toBe(2);
    expect(at(Number.NaN)).toBe(0);
  });

  // P2: one spelling per feature, shared with the overlay.
  it('uses the canonical feature names', () => {
    const v = buildPlanView({ tier: 'free', pro: false, quota: usage(9) });
    const labels = v.rows.map((r) => r.label);
    expect(labels).toContain('Rehydrate Vault');
    expect(labels).toContain('Ghost Log Sanitiser');
    expect(labels).toContain('Session Lock');
    expect(labels).toContain('Anonymise & Paste');
  });
});

// KAU-58: the 30-day Desktop Pro trial, read from the signed plan.
describe('buildPlanView: the Desktop Pro trial', () => {
  const NOW = Date.parse('2026-11-04T12:00:00Z');
  const sec = (ms: number) => Math.floor(ms / 1000);

  it('names all four packages', () => {
    const label = (tier: 'free' | 'browser_pro' | 'desktop_pro' | 'business') =>
      buildPlanView({ tier, pro: tier !== 'free', quota: unlimited }).planLabel;
    expect([label('free'), label('browser_pro'), label('desktop_pro'), label('business')]).toEqual([
      'Browser Free',
      'Browser Pro',
      'Desktop Pro',
      'Business',
    ]);
  });

  it('a running trial shows the days left, rounded up, and the end date', () => {
    const v = buildPlanView({
      tier: 'desktop_pro',
      pro: true,
      quota: unlimited,
      trial: { state: 'active', endsAt: sec(NOW + 20.5 * 86_400_000) },
      nowMs: NOW,
    });
    expect(v.planLabel).toBe('Desktop Pro');
    expect(v.trial?.daysLeft).toBe(21);
    expect(v.trial?.endsOn).toMatch(/25/);
    expect(v.canStartTrial).toBe(false);
  });

  it('an ended or used trial shows nothing', () => {
    for (const trial of [
      { state: 'active' as const, endsAt: sec(NOW - 1000) },
      { state: 'used' as const, endsAt: sec(NOW - 86_400_000) },
    ]) {
      const v = buildPlanView({ tier: 'free', pro: false, quota: usage(5), trial, nowMs: NOW });
      expect(v.trial).toBeNull();
      expect(v.canStartTrial).toBe(false);
    }
  });

  it('Start trial is offered only when the plan says the trial is available', () => {
    const offer = (state: 'none' | 'available' | 'active' | 'used') =>
      buildPlanView({ tier: 'free', pro: false, quota: usage(5), trial: { state, endsAt: null } })
        .canStartTrial;
    expect(offer('available')).toBe(true);
    expect(offer('none')).toBe(false);
    expect(offer('used')).toBe(false);
  });

  it('never offers a personal trial on a team seat', () => {
    const v = buildPlanView({
      tier: 'business',
      pro: true,
      quota: unlimited,
      trial: { state: 'available', endsAt: null },
      org: { name: 'Acme', role: 'org:member' },
    });
    expect(v.canStartTrial).toBe(false);
  });
});
