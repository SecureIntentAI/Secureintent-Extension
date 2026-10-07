import { expect, test } from 'vitest';
import { isSecureIntentOwnPage } from './createPasteGuard';

test('every page on secureintent.ai and its subdomains is our own and not guarded', () => {
  for (const [host, path] of [
    ['secureintent.ai', '/team.html'], // Users → Invite: admins paste member emails here
    ['secureintent.ai', '/shadow.html'],
    ['secureintent.ai', '/account.html'],
    ['www.secureintent.ai', '/business_promo.html'],
    ['SecureIntent.ai', '/anything'],
    ['accounts.secureintent.ai', '/sign-in'],
  ]) {
    expect(isSecureIntentOwnPage(host, path)).toBe(true);
  }
});

test('look-alike and third-party hosts are still guarded', () => {
  for (const [host, path] of [
    ['notsecureintent.ai', '/team.html'],
    ['secureintent.ai.evil.example', '/team.html'],
    ['chatgpt.com', '/'],
    ['claude.ai', '/new'],
  ]) {
    expect(isSecureIntentOwnPage(host, path)).toBe(false);
  }
});

test('on localhost only our own pages are skipped, so a developer app stays protected', () => {
  expect(isSecureIntentOwnPage('localhost', '/team.html')).toBe(true);
  expect(isSecureIntentOwnPage('127.0.0.1', '/account.html')).toBe(true);
  expect(isSecureIntentOwnPage('localhost', '/')).toBe(false);
  expect(isSecureIntentOwnPage('localhost', '/admin/settings')).toBe(false);
});
