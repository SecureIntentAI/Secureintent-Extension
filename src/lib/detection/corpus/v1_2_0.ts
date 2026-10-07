import type { Detection } from '../types';
import { githubTokenChecksum } from '../validators';

export interface DetectorCorpusCase {
  id: string;
  text: string;
  expected: Pick<Detection, 'label' | 'match'>[];
  aggressive?: boolean;
}

const unknownToken = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
const envCredential = 'new-provider-8Jc5M9qR2vT6xY4z';
const checksumPayload = 'SyntheticPayload0123456789ABCD';
const syntheticGitHubToken = `ghp_${checksumPayload}${githubTokenChecksum(checksumPayload)}`;
const syntheticNpmToken = `npm_${checksumPayload}${githubTokenChecksum(checksumPayload)}`;
const checksum = githubTokenChecksum(checksumPayload);
const invalidChecksum = `${checksum[0] === '0' ? '1' : '0'}${checksum.slice(1)}`;

/** Synthetic regression corpus for the v1.2.0 detector; no live credentials. */
export const detectorCorpusV1_2_0 = {
  version: '1.2.0',
  positives: [
    {
      id: 'known-openai-key',
      text: 'sk-abcdefghijklmnopqrstuvwxyz012345',
      expected: [{ label: 'OpenAI API key', match: 'sk-abcdefghijklmnopqrstuvwxyz012345' }],
    },
    {
      id: 'known-github-token',
      text: syntheticGitHubToken,
      expected: [{ label: 'GitHub token', match: syntheticGitHubToken }],
    },
    {
      id: 'known-npm-token-with-checksum',
      text: syntheticNpmToken,
      expected: [{ label: 'npm token', match: syntheticNpmToken }],
    },
    {
      id: 'json-unknown-api-key',
      text: JSON.stringify({ settings: { apiKey: unknownToken } }),
      expected: [{ label: 'JSON credential', match: unknownToken }],
    },
    {
      id: 'json-nested-client-secret',
      text: JSON.stringify({ service: { clientSecret: envCredential } }),
      expected: [{ label: 'JSON credential', match: envCredential }],
    },
    {
      id: 'dotenv-unknown-credential',
      text: `SERVICE_CREDENTIAL=${envCredential}`,
      expected: [{ label: 'Structured credential', match: envCredential }],
    },
    {
      id: 'yaml-camel-case-api-key',
      text: `service:\n  apiKey: ${unknownToken} # synthetic`,
      expected: [{ label: 'Structured credential', match: unknownToken }],
    },
    {
      id: 'xml-client-secret',
      text: `<service><clientSecret>${envCredential}</clientSecret></service>`,
      expected: [{ label: 'Structured credential', match: envCredential }],
    },
    {
      id: 'http-bearer-authorization',
      text: `Authorization: Bearer ${unknownToken}`,
      expected: [{ label: 'Structured credential', match: unknownToken }],
    },
    {
      id: 'dotenv-quoted-password',
      text: 'SERVICE_PASSWORD="correct horse battery staple"',
      expected: [
        {
          label: 'Structured credential',
          match: 'correct horse battery staple',
        },
      ],
    },
    {
      id: 'standalone-unknown-token-aggressive',
      text: unknownToken,
      expected: [{ label: 'Possible unknown token', match: unknownToken }],
    },
    {
      id: 'credential-bearing-connection-string',
      text: 'postgres://demo_user:fake-not-real@db.example.test:5432/sample',
      expected: [
        {
          label: 'Connection string with credentials',
          match: 'postgres://demo_user:fake-not-real@db.example.test:5432/sample',
        },
      ],
    },
    {
      id: 'pem-private-key-block',
      text: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34Gk\n-----END RSA PRIVATE KEY-----',
      expected: [
        {
          label: 'Private key (PEM)',
          match:
            '-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34Gk\n-----END RSA PRIVATE KEY-----',
        },
      ],
    },
    {
      id: 'valid-luhn-card-number',
      text: 'billing card 4111 1111 1111 1111',
      expected: [{ label: 'Credit card number', match: '4111 1111 1111 1111' }],
    },
  ] satisfies DetectorCorpusCase[],
  negatives: [
    {
      id: 'json-public-key',
      text: JSON.stringify({ publicKey: unknownToken }),
      expected: [],
    },
    {
      id: 'json-client-id',
      text: JSON.stringify({ clientId: envCredential }),
      expected: [],
    },
    {
      id: 'yaml-public-key',
      text: `publicKey: ${unknownToken}`,
      expected: [],
    },
    {
      id: 'yaml-api-key-placeholder',
      text: 'apiKey: "replace me"',
      expected: [],
    },
    {
      id: 'xml-client-id',
      text: `<clientId>${envCredential}</clientId>`,
      expected: [],
    },
    {
      id: 'authorization-placeholder',
      text: 'Authorization: Bearer changeme',
      expected: [],
    },
    {
      id: 'json-password-placeholder',
      text: '{"password":"changeme"}',
      expected: [],
    },
    {
      id: 'dotenv-password-placeholder',
      text: 'SERVICE_PASSWORD=changeme',
      expected: [],
    },
    {
      id: 'dotenv-spaced-placeholder',
      text: 'SERVICE_PASSWORD="replace me"',
      expected: [],
    },
    {
      id: 'dotenv-api-key-placeholder',
      text: 'API_KEY=your_api_key',
      expected: [],
    },
    {
      id: 'token-count-is-not-a-secret',
      text: 'TOKEN_COUNT=1000',
      expected: [],
    },
    {
      id: 'share-link-path-token',
      text: `https://example.test/share/${unknownToken}`,
      expected: [],
    },
    {
      id: 'ordinary-api-key-prose',
      text: 'The sample explains where to enter your API key.',
      expected: [],
    },
    {
      id: 'short-github-like-value',
      text: 'ghp_abcdefghijklmnopqrstuvwx',
      expected: [],
    },
    {
      id: 'github-token-with-invalid-checksum',
      text: `ghp_${checksumPayload}${invalidChecksum}`,
      expected: [],
    },
    {
      id: 'npm-token-with-invalid-checksum',
      text: `npm_${checksumPayload}${invalidChecksum}`,
      expected: [],
    },
    {
      id: 'invalid-luhn-card-number',
      text: 'billing card 4111 1111 1111 1112',
      expected: [],
    },
    {
      id: 'standalone-unknown-token-conservative',
      text: unknownToken,
      expected: [],
      aggressive: false,
    },
  ] satisfies DetectorCorpusCase[],
} as const;
