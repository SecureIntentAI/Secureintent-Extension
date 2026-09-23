import { describe, expect, test } from 'vitest';
import { detectSecrets } from './index';

describe('detectSecrets — known keys', () => {
  test('detects an OpenAI API key', () => {
    const text = 'here is my key sk-abcdefghijklmnopqrstuvwxyz012345 use it';
    const dets = detectSecrets(text);

    expect(dets).toHaveLength(1);
    expect(dets[0].type).toBe('known-key');
    expect(dets[0].label).toBe('OpenAI API key');
    expect(dets[0].match).toBe('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(text.slice(dets[0].start, dets[0].end)).toBe(dets[0].match);
  });

  test('detects an AWS access key id', () => {
    const dets = detectSecrets('AWS_ACCESS_KEY_ID AKIAIOSFODNN7EXAMPLE end');
    const aws = dets.find((d) => d.label === 'AWS access key ID');
    expect(aws?.match).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  test('detects temporary AWS keys, JSON secrets, and newer vendor keys', () => {
    const samples = [
      ['ASIAIOSFODNN7EXAMPLE', 'AWS access key ID'],
      ['{"api_key":"wJalrXUtnFEMI7MDENG"}', 'JSON credential'],
      ['pplx-' + 'a'.repeat(32), 'Perplexity API key'],
      ['gsk_' + 'b'.repeat(32), 'Groq API key'],
      ['xai-' + 'c'.repeat(32), 'xAI API key'],
    ] as const;
    for (const [text, label] of samples) {
      expect(detectSecrets(text).some((d) => d.label === label)).toBe(true);
    }
  });

  test('detects a GitHub personal access token', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const dets = detectSecrets(`token=${token}`);
    expect(dets.find((d) => d.label === 'GitHub token')?.match).toBe(token);
  });

  test('detects a Google API key', () => {
    const key = 'AIza' + 'b'.repeat(35);
    const dets = detectSecrets(`key ${key}`);
    expect(dets.find((d) => d.label === 'Google API key')?.match).toBe(key);
  });

  test('detects a Stripe secret key', () => {
    const key = 'sk_live_' + 'c'.repeat(24);
    const dets = detectSecrets(`stripe ${key}`);
    expect(dets.find((d) => d.label === 'Stripe key')?.match).toBe(key);
  });

  test('detects a Slack token', () => {
    const key = 'xoxb-' + '1234567890-1234567890-abcdEFGHijklMNOP';
    const dets = detectSecrets(`slack ${key}`);
    expect(dets.find((d) => d.label === 'Slack token')?.match).toBe(key);
  });

  test('detects a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const dets = detectSecrets(`auth: ${jwt}`);
    expect(dets.find((d) => d.label === 'JWT')?.match).toBe(jwt);
  });

  test('detects an Anthropic API key', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    const dets = detectSecrets(`anthropic ${key}`);
    expect(dets.find((d) => d.label === 'Anthropic API key')?.match).toBe(key);
  });

  test('detects a GitHub fine-grained PAT', () => {
    const key = 'github_pat_11ABCDEFGH0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    const dets = detectSecrets(`token=${key}`);
    expect(dets.find((d) => d.label === 'GitHub fine-grained PAT')?.match).toBe(key);
  });

  test('detects a GitLab PAT', () => {
    const key = 'glpat-abcdefghijklmnopqrstuvwx';
    const dets = detectSecrets(`gitlab ${key}`);
    expect(dets.find((d) => d.label === 'GitLab PAT')?.match).toBe(key);
  });

  test('detects an npm token', () => {
    const key = 'npm_0123456789abcdefghijklmnopqrstuvwxyz';
    const dets = detectSecrets(`npm ${key}`);
    expect(dets.find((d) => d.label === 'npm token')?.match).toBe(key);
  });

  test('detects a Hugging Face token', () => {
    const key = 'hf_abcdefghijklmnopqrstuvwxyz0123456789';
    const dets = detectSecrets(`hf ${key}`);
    expect(dets.find((d) => d.label === 'Hugging Face token')?.match).toBe(key);
  });

  test('detects a SendGrid API key', () => {
    const key = 'SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const dets = detectSecrets(`sendgrid ${key}`);
    expect(dets.find((d) => d.label === 'SendGrid API key')?.match).toBe(key);
  });

  test('detects a Slack webhook URL', () => {
    const key = 'https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrstuvwx';
    const dets = detectSecrets(`slack ${key}`);
    expect(dets.find((d) => d.label === 'Slack webhook URL')?.match).toBe(key);
  });

  test('detects a Twilio account SID', () => {
    const key = 'AC0123456789abcdef0123456789abcdef';
    const dets = detectSecrets(`twilio ${key}`);
    expect(dets.find((d) => d.label === 'Twilio account SID')?.match).toBe(key);
  });

  test('detects a Discord bot token', () => {
    const key = 'Maaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.ccccccccccccccccccccccccccc';
    const dets = detectSecrets(`discord ${key}`);
    expect(dets.find((d) => d.label === 'Discord bot token')?.match).toBe(key);
  });

  test('detects a Dropbox access token', () => {
    const key = 'sl.' + 'A'.repeat(135);
    const dets = detectSecrets(`dropbox ${key}`);
    expect(dets.find((d) => d.label === 'Dropbox access token')?.match).toBe(key);
  });

  test('detects a Notion integration token (secret_ form)', () => {
    const key = 'secret_' + 'a'.repeat(43);
    const dets = detectSecrets(`notion ${key}`);
    expect(dets.find((d) => d.label === 'Notion integration token')?.match).toBe(key);
  });

  test('detects a Notion integration token (ntn_ form)', () => {
    const key = 'ntn_' + 'b'.repeat(46);
    const dets = detectSecrets(`notion ${key}`);
    expect(dets.find((d) => d.label === 'Notion integration token')?.match).toBe(key);
  });

  test('detects a Firebase Cloud Messaging server key', () => {
    const key = 'AAAA' + 'B'.repeat(7) + ':APA91b' + 'C'.repeat(134);
    const dets = detectSecrets(`fcm ${key}`);
    expect(dets.find((d) => d.label === 'Firebase Cloud Messaging server key')?.match).toBe(key);
  });

  test('detects a Google OAuth refresh token', () => {
    const key = '1//0' + 'g'.repeat(40);
    const dets = detectSecrets(`refresh ${key}`);
    expect(dets.find((d) => d.label === 'Google OAuth refresh token')?.match).toBe(key);
  });

  test('detects an Azure storage connection string', () => {
    const key =
      'DefaultEndpointsProtocol=https;AccountName=mystore;AccountKey=abc123def456ghi789==;EndpointSuffix=core.windows.net';
    const dets = detectSecrets(key);
    expect(dets.find((d) => d.label === 'Azure storage connection string')).toBeTruthy();
  });
});

describe('detectSecrets — Anthropic vs OpenAI disambiguation', () => {
  test('labels an sk-ant- key as Anthropic, not OpenAI', () => {
    const dets = detectSecrets('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
    expect(dets).toHaveLength(1);
    expect(dets[0].label).toBe('Anthropic API key');
  });

  test('still labels a plain sk- key as OpenAI', () => {
    const dets = detectSecrets('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(dets).toHaveLength(1);
    expect(dets[0].label).toBe('OpenAI API key');
  });

  test('still labels an sk-proj- key as OpenAI', () => {
    const dets = detectSecrets('sk-proj-abcdefghijklmnopqrstuvwxyz012345');
    expect(dets).toHaveLength(1);
    expect(dets[0].label).toBe('OpenAI API key');
  });
});

describe('detectSecrets — private keys', () => {
  test('detects a PEM private key block', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34Gk\nxuY8Hj+89dQ==\n-----END RSA PRIVATE KEY-----';
    const dets = detectSecrets(`config\n${pem}\nend`);
    const key = dets.find((d) => d.type === 'private-key');
    expect(key?.label).toBe('Private key (PEM)');
    expect(key?.match).toBe(pem);
  });
});

describe('detectSecrets — env credentials', () => {
  test('detects a PASSWORD= assignment', () => {
    const dets = detectSecrets('PASSWORD=hunter2supersecret');
    const env = dets.find((d) => d.type === 'env-credential');
    expect(env?.label).toBe('Credential assignment');
    expect(env?.match).toBe('PASSWORD=hunter2supersecret');
  });

  test('detects a connection string with inline credentials', () => {
    const dets = detectSecrets('DB: postgres://admin:s3cr3tpass@db.example.com:5432/app');
    const conn = dets.find((d) => d.label === 'Connection string with credentials');
    expect(conn?.match).toBe('postgres://admin:s3cr3tpass@db.example.com:5432/app');
  });
});

describe('detectSecrets — credit cards (PII, Luhn-validated)', () => {
  test('detects a valid Visa, formatted with spaces', () => {
    const dets = detectSecrets('card: 4111 1111 1111 1111 exp 12/25');
    const card = dets.find((d) => d.label === 'Credit card number');
    expect(card?.type).toBe('pii');
    expect(card?.match).toBe('4111 1111 1111 1111');
  });

  test('detects an Amex (15 digits)', () => {
    const dets = detectSecrets('378282246310005');
    expect(dets.find((d) => d.label === 'Credit card number')).toBeTruthy();
  });

  test('does not flag a number that fails Luhn', () => {
    expect(detectSecrets('4111 1111 1111 1112')).toEqual([]);
  });

  test('does not flag a 13-digit epoch-ms timestamp', () => {
    expect(detectSecrets('ts=1700000000000')).toEqual([]);
  });

  test('does not flag a long order id with an unknown prefix', () => {
    expect(detectSecrets('order 1234567812345670')).toEqual([]);
  });
});

describe('detectSecrets — AWS secret access key (by context)', () => {
  test('detects a labelled secret access key', () => {
    const dets = detectSecrets('Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(dets.find((d) => d.label === 'AWS secret access key')).toBeTruthy();
  });

  test('detects aws_secret_access_key=… form', () => {
    const dets = detectSecrets('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(dets.find((d) => d.label === 'AWS secret access key')).toBeTruthy();
  });

  test('also catches a bare key via the entropy pattern (pilot/aggressive)', () => {
    const dets = detectSecrets('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(dets.length).toBeGreaterThan(0);
  });
});

// PATTERNS always includes the entropy patterns; the guard gates them by
// bundle.aggressive. So at this layer (catalog) they always fire.
describe('detectSecrets — high-entropy (pilot/aggressive)', () => {
  test('flags a 64-char hex hash', () => {
    const dets = detectSecrets('d41d8cd98f00b204e9800998ecf8427e3bbce4dbca09a9e3aeb5c55a40a5a51a');
    expect(dets.find((d) => d.label === 'High-entropy hex string')).toBeTruthy();
  });

  test('flags a 40-char git SHA', () => {
    const dets = detectSecrets('commit da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(dets.find((d) => d.label === 'High-entropy hex string')).toBeTruthy();
  });

  test('flags a high-entropy base64 string', () => {
    const dets = detectSecrets('v/Yw7J1kR+L8xM9pT3qN5zC2bV4jH6mF0gD1sW3nK8c=');
    expect(dets.find((d) => d.label === 'High-entropy base64 string')).toBeTruthy();
  });

  test('does not flag a low-entropy repetitive run', () => {
    expect(detectSecrets('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual([]);
  });

  // High-entropy ids inside URLs are links, not secrets — don't flag them.
  test('does not flag a Loom share link', () => {
    expect(detectSecrets('https://www.loom.com/share/8f3c1a9b2d7e4f60a5c8b1e9d4f27a3c')).toEqual(
      [],
    );
  });

  test('does not flag a Google Drive file link', () => {
    const url =
      'https://drive.google.com/file/d/1A2b3C4d5E6f7G8h9I0jK1lM2nO3pQ4rS/view?usp=sharing';
    expect(detectSecrets(url)).toEqual([]);
  });

  test('does not flag a bare domain/path link (no scheme)', () => {
    expect(detectSecrets('loom.com/share/8f3c1a9b2d7e4f60a5c8b1e9d4f27a3c')).toEqual([]);
  });

  test('still flags a bare high-entropy string not in a URL', () => {
    const dets = detectSecrets('token 8f3c1a9b2d7e4f60a5c8b1e9d4f27a3c end');
    expect(dets.find((d) => d.label === 'High-entropy hex string')).toBeTruthy();
  });

  test('still flags a real key even when it appears in a URL query', () => {
    const dets = detectSecrets(
      'https://api.example.com/v1?key=AIzaSyA1234567890B1234567890C1234567890',
    );
    expect(dets.find((d) => d.label === 'Google API key')).toBeTruthy();
  });
});

describe('detectSecrets — negatives', () => {
  test('returns empty for ordinary prose', () => {
    expect(detectSecrets('The quick brown fox jumps over the lazy dog.')).toEqual([]);
  });

  test('does not flag a short sk- lookalike', () => {
    expect(detectSecrets('sk-short')).toEqual([]);
  });

  test('does not flag a plain word=value', () => {
    expect(detectSecrets('name=John')).toEqual([]);
  });
});

// Realistic everyday text that must never trigger the guard — even in pilot
// (aggressive entropy) mode, since these have separators / short runs.
describe('detectSecrets — false-positive guards (normal text)', () => {
  test.each([
    ['a normal sentence', 'Please review the pull request and merge it when ready.'],
    ['a sentence mentioning secret/password', 'The secretary said to reset your password soon.'],
    ['an email address', 'Contact us at john.wright@secureintent.ai for help.'],
    ['a UUID', 'id: 550e8400-e29b-41d4-a716-446655440000'],
    ['an ISO timestamp', 'updated 2026-06-08T14:20:00Z'],
    ['a hex colour', 'background: #1a2b3c; color: #ffffff;'],
    ['an IPv4 address', 'server at 192.168.1.1 port 5432'],
    ['a phone number', 'call +44 7911 123456 today'],
    ['a normal code line', 'const apiUrl = getConfig().endpoint;'],
    ['a markdown link', 'See [the docs](https://example.com/guide/getting-started).'],
    ['a file path', 'open src/lib/detection/patterns.ts and edit it'],
  ])('does not flag %s', (_name, text) => {
    expect(detectSecrets(text)).toEqual([]);
  });
});

describe('detectSecrets — multiple & overlap', () => {
  test('finds multiple secrets sorted by position', () => {
    const a = 'sk-' + 'a'.repeat(30);
    const b = 'ghp_' + 'b'.repeat(36);
    const dets = detectSecrets(`first ${a} then ${b}`);
    expect(dets).toHaveLength(2);
    expect(dets[0].start).toBeLessThan(dets[1].start);
  });

  test('keeps the more specific match when two patterns overlap', () => {
    // An env line whose value is an OpenAI key: known-key should win, not duplicated.
    const key = 'sk-' + 'z'.repeat(30);
    const dets = detectSecrets(`API_KEY=${key}`);
    expect(dets).toHaveLength(1);
    expect(dets[0].type).toBe('known-key');
    expect(dets[0].match).toBe(key);
  });
});

// The built-in catalogue has no `origin`, so nothing it finds may grow one —
// this is what keeps the "Team rule" badge off an ordinary user's warning.
describe('detectSecrets — the static catalogue never carries an origin', () => {
  test('a finding from the built-in patterns has no origin key', () => {
    const dets = detectSecrets('key AKIAIOSFODNN7EXAMPLE here');
    expect(dets).toHaveLength(1);
    expect('origin' in dets[0]).toBe(false);
  });
});

/**
 * Beta testing found every prefixed credential name passing straight through:
 * PASSWORD= was caught, DB_PASSWORD= was not. An underscore is a word character,
 * so `\b` finds no boundary between `_` and `PASSWORD`.
 */
describe('prefixed credential names', () => {
  const found = (text: string) => detectSecrets(text);

  test.each([
    'DB_PASSWORD=hunter2xyz',
    'REDIS_PASSWORD=abcdefgh',
    'CLIENT_SECRET=abcdefgh',
    'JWT_SECRET=abcdefgh',
    'SESSION_SECRET=abcdefgh',
    'ACCESS_TOKEN=abcdefgh',
    'REFRESH_TOKEN=abcdefgh',
    'STRIPE_API_KEY=abcdefghij',
    'SECRET_KEY=django-insecure-abc',
  ])('catches %s', (sample) => {
    expect(found(sample).length).toBeGreaterThan(0);
  });

  test.each([
    'TOKEN_COUNT=1000000',
    'MAX_TOKENS=1000000',
    'PASSWORD_HASH=abcdefgh',
  ])('leaves %s alone — these are everywhere in AI tooling config', (sample) => {
    expect(found(sample)).toHaveLength(0);
  });
});
