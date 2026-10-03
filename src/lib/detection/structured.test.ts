import { expect, test } from 'vitest';
import { detectSecrets, sanitize, tokenizeSecrets } from './index';
import { PATTERNS } from './patterns';
import { githubTokenChecksum } from './validators';

function base64UrlJson(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function syntheticJwt(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  return `${base64UrlJson(header)}.${base64UrlJson(claims)}.c3ludGhldGljLXNpZw`;
}

test('finds unknown keys in nested JSON and removes only the value', () => {
  const value = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
  const text = JSON.stringify({ settings: { apiKey: value, publicKey: value } });
  const findings = detectSecrets(text);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    type: 'env-credential',
    label: 'JSON credential',
    match: value,
  });
  expect(text.slice(findings[0].start, findings[0].end)).toBe(value);
  expect(text.slice(0, findings[0].start)).toContain('apiKey');
});

test('finds unknown secrets in .env assignments and skips placeholders', () => {
  const value = 'new-provider-8Jc5M9qR2vT6xY4z';
  const text = `SERVICE_CREDENTIAL=${value}\nSERVICE_PASSWORD=changeme\nPUBLIC_KEY=${value}`;
  const findings = detectSecrets(text);
  expect(findings.filter((d) => d.label === 'Structured credential')).toEqual([
    expect.objectContaining({ match: value }),
  ]);
});

test.each([
  ['YAML', `service:\n  apiKey: SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3 # comment`],
  ['XML', '<service><clientSecret>new-provider-8Jc5M9qR2vT6xY4z</clientSecret></service>'],
  ['HTTP authorization', 'Authorization: Bearer SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3'],
])('finds credential values in %s and keeps redaction offsets value-only', (_format, text) => {
  const findings = detectSecrets(text);
  expect(findings).toHaveLength(1);
  expect(findings[0].label).toBe('Structured credential');
  expect(text.slice(findings[0].start, findings[0].end)).toBe(findings[0].match);
  expect(findings[0].match).not.toMatch(/apiKey|clientSecret|Authorization|Bearer/);
});

test('does not promote public identifiers or placeholders in added formats', () => {
  expect(detectSecrets('publicKey: SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3')).toEqual([]);
  expect(detectSecrets('apiKey: "replace me"')).toEqual([]);
  expect(detectSecrets('<clientId>new-provider-8Jc5M9qR2vT6xY4z</clientId>')).toEqual([]);
  expect(detectSecrets('Authorization: Bearer changeme')).toEqual([]);
});

test.each([
  ['password: password', 'password: [#SECRET_1#]', 'password: MASKED'],
  ['password_secret: password', 'password_secret: [#SECRET_1#]', 'password_secret: MASKED'],
  [
    '<password>password</password>',
    '<password>[#SECRET_1#]</password>',
    '<password>MASKED</password>',
  ],
  [
    '<password hint="clientSecretValue12">clientSecretValue12</password>',
    '<password hint="clientSecretValue12">[#SECRET_1#]</password>',
    '<password hint="clientSecretValue12">MASKED</password>',
  ],
])('redacts the credential value when it also occurs in markup: %s', (text, sanitized, anonymized) => {
  const findings = detectSecrets(text);
  expect(findings).toHaveLength(1);
  expect(sanitize(text, findings)).toBe(sanitized);
  expect(tokenizeSecrets(text, findings).text.replace(/⟦SI:[0-9a-f]{8}⟧/g, 'MASKED')).toBe(
    anonymized,
  );
});

test('known provider detector still wins when it overlaps a structured value', () => {
  const value = `sk-${'a'.repeat(30)}`;
  const findings = detectSecrets(JSON.stringify({ apiKey: value }));
  expect(findings).toHaveLength(1);
  expect(findings[0].label).toBe('OpenAI API key');
});

test('validates the offline checksum on current GitHub and npm token formats', () => {
  const payload = 'SyntheticPayload0123456789ABCD';
  const checksum = githubTokenChecksum(payload);
  const githubToken = `ghp_${payload}${checksum}`;
  const npmToken = `npm_${payload}${checksum}`;
  const badChecksum = `${checksum[0] === '0' ? '1' : '0'}${checksum.slice(1)}`;

  expect(detectSecrets(githubToken)).toMatchObject([{ label: 'GitHub token', match: githubToken }]);
  expect(detectSecrets(npmToken)).toMatchObject([{ label: 'npm token', match: npmToken }]);
  expect(detectSecrets(`ghp_${payload}${badChecksum}`)).toEqual([]);
  expect(detectSecrets(`npm_${payload}${badChecksum}`)).toEqual([]);

  // Older GitHub tokens do not carry the newer checksum and remain recognized.
  const legacyGitHubToken = `ghp_${'a'.repeat(40)}`;
  expect(detectSecrets(legacyGitHubToken)).toMatchObject([
    { label: 'GitHub token', match: legacyGitHubToken },
  ]);
});

test('checks JWT compact structure without claiming signature validity', () => {
  const jwt = syntheticJwt(
    { alg: 'HS256', typ: 'JWT' },
    { sub: 'synthetic-user', exp: 2_000_000_000 },
  );
  expect(detectSecrets(jwt)).toMatchObject([{ label: 'JWT', match: jwt }]);

  const encodedHeader = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  expect(detectSecrets(`${encodedHeader}.bm90LWpzb24.c3ludGhldGljLXNpZw`)).toEqual([]);
  expect(detectSecrets(`${encodedHeader}.${base64UrlJson({ sub: 'synthetic-user' })}.`)).toEqual(
    [],
  );
});

test('detects GitHub stateless installation tokens as a whole opaque token', () => {
  const jwt = syntheticJwt({ alg: 'RS256', typ: 'JWT' }, { iss: 'synthetic-app' });
  const token = `ghs_12345_${jwt}`;
  expect(detectSecrets(token)).toMatchObject([
    { label: 'GitHub App installation token', match: token },
  ]);
});

test('a team-only replacement catalogue suppresses built-in structured detection', () => {
  const value = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
  const teamRules = [
    {
      type: 'known-key' as const,
      label: 'Team only',
      regex: /ACME-[0-9]+/g,
      origin: 'team' as const,
    },
  ];
  expect(detectSecrets(JSON.stringify({ apiKey: value }), teamRules)).toEqual([]);
  expect(detectSecrets(JSON.stringify({ apiKey: value }), PATTERNS)).toHaveLength(1);
});

test('flags a standalone unfamiliar URL-safe token only in aggressive mode', () => {
  const value = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
  expect(detectSecrets(value).some((d) => d.label === 'Possible unknown token')).toBe(true);
  expect(
    detectSecrets(
      value,
      PATTERNS.filter((p) => p.validate !== 'entropy'),
    ),
  ).toEqual([]);
  expect(
    detectSecrets(`https://example.com/${value}`).some((d) => d.label === 'Possible unknown token'),
  ).toBe(false);
});
