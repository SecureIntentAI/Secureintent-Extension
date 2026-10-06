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
    const v = buildPlanView({ plan: 'developer', pro: false, quota: usage(9) });
    expect(v.planLabel).toBe('Free');
    expect(v.isPro).toBe(false);
    expect(v.rows[0]).toMatchObject({ key: 'detection', state: 'active', detail: 'Active' });
    expect(v.rows[1]).toMatchObject({ key: 'anonymise', state: 'usage', detail: '9 / 10 left' });
  });

  it('free plan: toolkit is locked (Pro), not active', () => {
    const v = buildPlanView({ plan: 'developer', pro: false, quota: usage(9) });
    const toolkit = v.rows.filter((r) => TOOLKIT.includes(r.key));
    expect(toolkit).toHaveLength(3);
    expect(toolkit.every((r) => r.state === 'locked' && r.detail === 'Pro')).toBe(true);
  });

  it('pro plan: anonymise unlimited and toolkit active', () => {
    const v = buildPlanView({ plan: 'developer_pro', pro: true, quota: unlimited });
    expect(v.planLabel).toBe('Developer Pro');
    expect(v.isPro).toBe(true);
    expect(v.rows[1]).toMatchObject({ key: 'anonymise', state: 'active', detail: 'Unlimited' });
    const toolkit = v.rows.filter((r) => TOOLKIT.includes(r.key));
    expect(toolkit.every((r) => r.state === 'active' && r.detail === 'Active')).toBe(true);
  });

  // P1-15: Team Policy Sync ships today, so nothing may present it as future work.
  it('business_pro gets the team features as included, not "Soon"', () => {
    const v = buildPlanView({ plan: 'business_pro', pro: true, quota: unlimited });
    expect(v.planLabel).toBe('Business Pro');
    const team = v.rows.filter((r) => TEAM.includes(r.key));
    expect(team).toHaveLength(1);
    expect(team.every((r) => r.state === 'active' && r.detail === 'Active')).toBe(true);
  });

  it('lower tiers see the team features locked behind Business, never "Soon"', () => {
    for (const plan of ['developer', 'developer_pro'] as const) {
      const v = buildPlanView({ plan, pro: plan !== 'developer', quota: unlimited });
      const team = v.rows.filter((r) => TEAM.includes(r.key));
      expect(team).toHaveLength(1);
      // A Developer Pro user already has Pro, so "Pro" would be a dead end here.
      expect(team.every((r) => r.state === 'locked' && r.detail === 'Business')).toBe(true);
    }
  });

  // Product decision (Oct 2026): alerts arrive with the desktop app. It is the
  // only upcoming row, and it reads the same on every plan.
  it('only Security-Team Alerts is upcoming, on every plan', () => {
    for (const plan of ['developer', 'developer_pro', 'business_pro'] as const) {
      const v = buildPlanView({ plan, pro: plan !== 'developer', quota: usage(3) });
      expect(v.rows.filter((r) => r.state === 'soon').map((r) => r.key)).toEqual(['team_alerts']);
      expect(v.rows.find((r) => r.key === 'team_alerts')).toMatchObject({ detail: 'Coming soon' });
    }
  });

  // P1-18: 0 of 10 must not read like a user who never had the feature.
  it('spent allowance says when it resets instead of counting down', () => {
    const v = buildPlanView({
      plan: 'developer',
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

  // P1-16: a seat holder must be told the plan is their team's.
  it('carries the team through so the card can say who provides the seat', () => {
    const member = buildPlanView({
      plan: 'business_pro',
      pro: true,
      quota: unlimited,
      org: { name: 'Acme Corp', role: 'org:member' },
    });
    expect(member.org).toEqual({ name: 'Acme Corp', isAdmin: false });

    const admin = buildPlanView({
      plan: 'business_pro',
      pro: true,
      quota: unlimited,
      org: { name: null, role: 'org:admin' },
    });
    expect(admin.org).toEqual({ name: 'your team', isAdmin: true });
  });

  it("has no team when the plan is the user's own", () => {
    expect(buildPlanView({ plan: 'developer_pro', pro: true, quota: unlimited }).org).toBeNull();
  });

  // Team rules: the count the card uses to say the team's own rules are running.
  it('reports no team rules by default, so nothing about teams is shown', () => {
    expect(buildPlanView({ plan: 'developer', pro: false, quota: usage(9) }).teamRules).toBe(0);
    expect(
      buildPlanView({ plan: 'developer', pro: false, quota: usage(9), teamRules: 0 }).teamRules,
    ).toBe(0);
  });

  it("carries the team's own pattern count through to the view", () => {
    const v = buildPlanView({ plan: 'business_pro', pro: true, quota: unlimited, teamRules: 3 });
    expect(v.teamRules).toBe(3);
  });

  it('clamps a nonsensical count rather than rendering it', () => {
    const at = (teamRules: number) =>
      buildPlanView({ plan: 'business_pro', pro: true, quota: unlimited, teamRules }).teamRules;
    expect(at(-2)).toBe(0);
    expect(at(2.7)).toBe(2);
    expect(at(Number.NaN)).toBe(0);
  });

  // P2: one spelling per feature, shared with the overlay.
  it('uses the canonical feature names', () => {
    const v = buildPlanView({ plan: 'developer', pro: false, quota: usage(9) });
    const labels = v.rows.map((r) => r.label);
    expect(labels).toContain('Rehydrate Vault');
    expect(labels).toContain('Ghost Log Sanitiser');
    expect(labels).toContain('Session Lock');
    expect(labels).toContain('Anonymise & Paste');
  });
});
