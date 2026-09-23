import type { PatternOrigin, SecretType } from './types';

export interface Pattern {
  type: SecretType;
  label: string;
  regex: RegExp; // global-flagged; the whole match (m[0]) is the secret
  validate?: string; // optional post-match validator name (see validators.ts)
  /** Only a team's own patterns carry this ('team'); the catalogue below omits it. */
  origin?: PatternOrigin;
}

// higher rank wins when two detections overlap
export const TYPE_RANK: Record<SecretType, number> = {
  'private-key': 4,
  pii: 3,
  'known-key': 2,
  'env-credential': 1,
  // Lowest on purpose. This one fires because nothing matched, so where it
  // overlaps a detector that did recognise the format, the named one wins.
  'high-entropy': 0,
};

export const PATTERNS: Pattern[] = [
  {
    type: 'private-key',
    label: 'Private key (PEM)',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    type: 'known-key',
    label: 'Anthropic API key',
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    type: 'known-key',
    label: 'OpenAI API key',
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    type: 'known-key',
    label: 'AWS access key ID',
    regex: /(?:AKIA|ASIA|AIDA)[0-9A-Z]{16}/g,
  },
  {
    type: 'known-key',
    label: 'GitHub token',
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    type: 'known-key',
    label: 'Google API key',
    regex: /AIza[0-9A-Za-z_-]{35}/g,
  },
  {
    type: 'known-key',
    label: 'Stripe key',
    regex: /(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g,
  },
  {
    type: 'known-key',
    label: 'Slack token',
    regex: /xox[baprsce]-[0-9A-Za-z-]{10,}/g,
  },
  {
    type: 'known-key',
    label: 'JWT',
    regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  {
    type: 'known-key',
    label: 'GitHub fine-grained PAT',
    regex: /github_pat_[A-Za-z0-9_]{60,}/g,
  },
  {
    type: 'known-key',
    label: 'GitLab PAT',
    regex: /glpat-[A-Za-z0-9_-]{20,}/g,
  },
  {
    type: 'known-key',
    label: 'npm token',
    regex: /npm_[A-Za-z0-9]{36}/g,
  },
  {
    type: 'known-key',
    label: 'Hugging Face token',
    regex: /hf_[A-Za-z0-9]{30,}/g,
  },
  {
    type: 'known-key',
    label: 'Perplexity API key',
    regex: /pplx-[A-Za-z0-9]{20,}/g,
  },
  {
    type: 'known-key',
    label: 'OpenRouter API key',
    regex: /sk-or-v1-[A-Za-z0-9]{20,}/g,
  },
  {
    type: 'known-key',
    label: 'Groq API key',
    regex: /gsk_[A-Za-z0-9]{20,}/g,
  },
  {
    type: 'env-credential',
    label: 'JSON credential',
    regex:
      /["'](?:api[_-]?key|access[_-]?key|client[_-]?secret|secret|token|password|passwd)["']\s*:\s*["'][^"']{8,}["']/gi,
  },
  {
    type: 'known-key',
    label: 'xAI API key',
    regex: /xai-[A-Za-z0-9]{20,}/g,
  },
  {
    type: 'known-key',
    label: 'SendGrid API key',
    regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
  },
  {
    type: 'known-key',
    label: 'Slack webhook URL',
    regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  },
  {
    type: 'known-key',
    label: 'Twilio account SID',
    regex: /AC[a-f0-9]{32}/g,
  },
  {
    type: 'known-key',
    label: 'Discord bot token',
    regex: /[MNO][A-Za-z\d_-]{23}\.[\w-]{6}\.[\w-]{27,}/g,
  },
  {
    type: 'known-key',
    label: 'Dropbox access token',
    regex: /sl\.[A-Za-z0-9_-]{130,}/g,
  },
  {
    type: 'known-key',
    label: 'Notion integration token',
    regex: /(?:secret_|ntn_)[A-Za-z0-9]{43,}/g,
  },
  {
    type: 'known-key',
    label: 'Firebase Cloud Messaging server key',
    regex: /AAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{130,}/g,
  },
  {
    type: 'known-key',
    label: 'Google OAuth refresh token',
    regex: /1\/\/0[A-Za-z0-9_-]{30,}/g,
  },
  {
    type: 'env-credential',
    label: 'Azure storage connection string',
    regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/g,
  },

  {
    type: 'env-credential',
    label: 'Connection string with credentials',
    regex: /\w+:\/\/[^:\s/]+:[^@\s]+@\S+/g,
  },
  {
    type: 'env-credential',
    label: 'Credential assignment',
    // `\b` alone catches PASSWORD= but not DB_PASSWORD=: an underscore is a word
    // character, so there is no boundary between `_` and `PASSWORD`. The leading
    // `[A-Za-z0-9_]*` fixes that, and the optional trailing key picks up
    // SECRET_KEY without a general wildcard, which would fire on
    // MAX_TOKENS=1000000. Keep in step with configBundle.ts in the backend: the
    // served bundle overrides this, and this is what a fresh install uses until
    // its first sync.
    regex:
      /\b[A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)(?:[_-]?key)?\s*[=:]\s*["']?[^\s"']{6,}/gi,
  },
  {
    // only flagged with its label — a bare 40-char base64 string is indistinguishable from a hash
    type: 'known-key',
    label: 'AWS secret access key',
    regex: /(?:aws[\s_-]?)?secret[\s_-]?access[\s_-]?key\s*[:=]\s*["']?[A-Za-z0-9/+]{40}/gi,
  },
  {
    type: 'pii',
    label: 'Credit card number',
    regex: /\b\d(?:[ -]?\d){11,18}\b/g,
    validate: 'card', // network prefix + Luhn
  },
  // Aggressive: unknown/zero-day secrets by entropy. Gated by bundle.aggressive.
  {
    type: 'high-entropy',
    label: 'High-entropy hex string',
    regex: /\b[0-9a-fA-F]{32,}\b/g,
    validate: 'entropy',
  },
  {
    type: 'high-entropy',
    label: 'High-entropy base64 string',
    regex: /[A-Za-z0-9+/]{32,}={0,2}/g,
    validate: 'entropy',
  },
];
