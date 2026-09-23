// Which content scripts belong on a tab that was already open when the extension
// was installed. Manifest scripts do not attach to those tabs until a reload.

type Rule = { file: string; patterns: string[] };

const DEDICATED: Rule[] = [
  { file: 'content-scripts/bolt.js', patterns: ['*://bolt.new/*'] },
  { file: 'content-scripts/chatgpt.js', patterns: ['*://chatgpt.com/*', '*://chat.openai.com/*'] },
  { file: 'content-scripts/claude.js', patterns: ['*://claude.ai/*'] },
  { file: 'content-scripts/copilot.js', patterns: ['*://copilot.microsoft.com/*'] },
  { file: 'content-scripts/deepseek.js', patterns: ['*://chat.deepseek.com/*'] },
  { file: 'content-scripts/duck.js', patterns: ['*://duck.ai/*'] },
  { file: 'content-scripts/gemini.js', patterns: ['*://gemini.google.com/*'] },
  {
    file: 'content-scripts/githubcopilot.js',
    patterns: ['*://github.com/copilot', '*://github.com/copilot/*'],
  },
  { file: 'content-scripts/grok.js', patterns: ['*://grok.com/*'] },
  { file: 'content-scripts/kimi.js', patterns: ['*://kimi.com/*', '*://*.kimi.com/*'] },
  { file: 'content-scripts/lovable.js', patterns: ['*://lovable.dev/*'] },
  { file: 'content-scripts/meta.js', patterns: ['*://meta.ai/*', '*://www.meta.ai/*'] },
  { file: 'content-scripts/mistral.js', patterns: ['*://chat.mistral.ai/*'] },
  {
    file: 'content-scripts/perplexity.js',
    patterns: ['*://perplexity.ai/*', '*://*.perplexity.ai/*'],
  },
  { file: 'content-scripts/poe.js', patterns: ['*://poe.com/*'] },
  { file: 'content-scripts/qwen.js', patterns: ['*://chat.qwen.ai/*'] },
  { file: 'content-scripts/reddit.js', patterns: ['*://reddit.com/*', '*://www.reddit.com/*'] },
  { file: 'content-scripts/replit.js', patterns: ['*://replit.com/*'] },
  { file: 'content-scripts/v0.js', patterns: ['*://v0.app/*', '*://v0.dev/*'] },
];

const SESSION_LOCK: Rule = {
  file: 'content-scripts/sessionlock.js',
  patterns: [
    '*://console.aws.amazon.com/*',
    '*://*.console.aws.amazon.com/*',
    '*://signin.aws.amazon.com/*',
    '*://console.cloud.google.com/*',
    '*://console.firebase.google.com/*',
    '*://portal.azure.com/*',
    '*://dash.cloudflare.com/*',
    '*://cloud.digitalocean.com/*',
    '*://dashboard.heroku.com/*',
    '*://app.netlify.com/*',
    '*://dashboard.render.com/*',
    '*://cloud.linode.com/*',
    '*://cloud.oracle.com/*',
    '*://cloud.ibm.com/*',
    '*://supabase.com/dashboard/*',
  ],
};

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const rest = pattern.slice(2);
    return host === rest || host.endsWith(`.${rest}`);
  }
  return host === pattern;
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(`${base}/`);
  }
  return path === pattern;
}

function patternMatches(pattern: string, url: URL): boolean {
  const parsed = /^\*:\/\/(\*|[^/]+)(\/.*)$/.exec(pattern);
  if (!parsed) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return hostMatches(parsed[1], url.hostname) && pathMatches(parsed[2], url.pathname);
}

function matchesAny(patterns: string[], url: URL): boolean {
  return patterns.some((pattern) => patternMatches(pattern, url));
}

/** Content scripts to inject into an already-open tab, dedicated ones first. */
export function scriptsForUrl(raw: string): string[] | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const files = DEDICATED.filter((rule) => matchesAny(rule.patterns, url)).map((rule) => rule.file);
  if (matchesAny(SESSION_LOCK.patterns, url)) files.push(SESSION_LOCK.file);
  files.push('content-scripts/fallback.js', 'content-scripts/bridge.js');
  return files;
}
