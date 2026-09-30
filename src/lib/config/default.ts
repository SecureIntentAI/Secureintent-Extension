import type { ConfigBundle } from './types';

// offline fallback; keep in sync with backend/src/lib/configBundle.ts DEFAULT_BUNDLE
export const DEFAULT_BUNDLE: ConfigBundle = {
  version: 9,
  aggressive: true, // pilot: entropy detection on (noisier, more metadata)
  patterns: [
    {
      type: 'private-key',
      label: 'Private key (PEM)',
      regex: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
    },
    { type: 'known-key', label: 'Anthropic API key', regex: 'sk-ant-[A-Za-z0-9_-]{20,}' },
    { type: 'known-key', label: 'OpenAI API key', regex: 'sk-(?:proj-)?[A-Za-z0-9_-]{20,}' },
    {
      type: 'known-key',
      label: 'AWS access key ID',
      regex: '(?:AKIA|ASIA)[0-9A-Z]{16}',
    },
    { type: 'known-key', label: 'GitHub token', regex: 'gh[pousr]_[A-Za-z0-9]{36,}' },
    { type: 'known-key', label: 'Google API key', regex: 'AIza[0-9A-Za-z_-]{35}' },
    {
      type: 'known-key',
      label: 'Stripe key',
      regex: '(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}',
    },
    { type: 'known-key', label: 'Slack token', regex: 'xox[baprs]-[0-9A-Za-z-]{10,}' },
    {
      type: 'known-key',
      label: 'JWT',
      regex: 'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
    },
    { type: 'known-key', label: 'GitHub fine-grained PAT', regex: 'github_pat_[A-Za-z0-9_]{60,}' },
    { type: 'known-key', label: 'GitLab PAT', regex: 'glpat-[A-Za-z0-9_-]{20,}' },
    { type: 'known-key', label: 'npm token', regex: 'npm_[A-Za-z0-9]{36}' },
    { type: 'known-key', label: 'Hugging Face token', regex: 'hf_[A-Za-z0-9]{30,}' },
    {
      type: 'known-key',
      label: 'SendGrid API key',
      regex: 'SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}',
    },
    {
      type: 'known-key',
      label: 'Slack webhook URL',
      regex: 'https://hooks\\.slack\\.com/services/[A-Za-z0-9/]+',
    },
    { type: 'known-key', label: 'Twilio account SID', regex: 'AC[a-f0-9]{32}' },
    {
      type: 'known-key',
      label: 'Discord bot token',
      regex: '[MNO][A-Za-z\\d_-]{23}\\.[\\w-]{6}\\.[\\w-]{27,}',
    },
    {
      type: 'known-key',
      label: 'Dropbox access token',
      regex: 'sl\\.[A-Za-z0-9_-]{130,}',
    },
    {
      type: 'known-key',
      label: 'Notion integration token',
      regex: '(?:secret_|ntn_)[A-Za-z0-9]{43,}',
    },
    {
      type: 'known-key',
      label: 'Firebase Cloud Messaging server key',
      regex: 'AAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{130,}',
    },
    {
      type: 'known-key',
      label: 'Google OAuth refresh token',
      regex: '1//0[A-Za-z0-9_-]{30,}',
    },
    {
      type: 'env-credential',
      label: 'Azure storage connection string',
      regex: 'DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+',
    },
    {
      type: 'env-credential',
      label: 'Connection string with credentials',
      regex: '\\w+://[^:\\s/]+:[^@\\s]+@\\S+',
    },
    {
      type: 'env-credential',
      label: 'Credential assignment',
      regex: '\\b(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)\\s*=\\s*\\S{6,}',
      flags: 'gi',
    },
    {
      type: 'known-key',
      label: 'AWS secret access key',
      regex: '(?:aws[\\s_-]?)?secret[\\s_-]?access[\\s_-]?key\\s*[:=]\\s*["\']?[A-Za-z0-9/+]{40}',
      flags: 'gi',
    },
    {
      type: 'pii',
      label: 'Credit card number',
      regex: '\\b\\d(?:[ -]?\\d){11,18}\\b',
      validate: 'card',
    },
    {
      type: 'pii',
      label: 'IBAN',
      regex: '\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]){11,30}\\b',
      flags: 'gi',
      validate: 'iban',
    },
    {
      type: 'known-key',
      label: 'High-entropy hex string',
      regex: '\\b[0-9a-fA-F]{32,}\\b',
      validate: 'entropy',
    },
    {
      type: 'known-key',
      label: 'High-entropy base64 string',
      regex: '[A-Za-z0-9+/]{32,}={0,2}',
      validate: 'entropy',
    },
  ],
  sites: {
    chatgpt: { inputSelector: '#prompt-textarea' },
    claude: { inputSelector: 'div[contenteditable="true"][data-testid="chat-input"]' },
    gemini: { inputSelector: 'div.ql-editor[contenteditable="true"]' },
    perplexity: { inputSelector: '#ask-input[contenteditable="true"]' },
    copilot: { inputSelector: 'textarea#userInput' },
    grok: {
      inputSelector:
        'div[contenteditable="true"][aria-label="Ask Grok anything"], [data-testid="chat-input"] div[contenteditable="true"]',
    },
    mistral: { inputSelector: 'div.ProseMirror[contenteditable="true"]' },
    meta: { inputSelector: 'input[placeholder^="Ask Meta AI"]' },
    poe: { inputSelector: 'textarea[class*="GrowingTextArea_textArea"]' },
    v0: { inputSelector: 'textarea[id^="prompt-textarea"]' },
    bolt: { inputSelector: 'div[contenteditable="true"][aria-label^="Type your idea"]' },
    lovable: { inputSelector: 'div[contenteditable="true"][aria-label="Chat input"]' },
    replit: { inputSelector: '[data-agent-input2-drop-target="true"] textarea' },
    reddit: { inputSelector: 'textarea[name="title"], div[contenteditable="true"][name="body"]' },
    deepseek: { inputSelector: 'textarea[placeholder="Message DeepSeek"]' },
    duck: { inputSelector: 'textarea[name="user-prompt"]' },
    githubcopilot: {
      inputSelector:
        'textarea[class*="ChatInput-module__input__"], textarea[placeholder="Ask Copilot"]',
    },
    kimi: { inputSelector: 'div.chat-input-editor' },
    qwen: { inputSelector: 'textarea.message-input-textarea' },
    // Catch-all for sites with no dedicated entry: any common text-entry element.
    // Safe to be broad — the overlay only fires when the pasted text matches a
    // secret pattern, so benign pastes (search, login, etc.) pass straight through.
    fallback: {
      inputSelector:
        'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="password"], [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    },
  },
  killSwitch: false,
};
