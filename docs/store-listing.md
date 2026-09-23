# Chrome Web Store listing

Source of truth for the store copy. The **short description** must stay in sync
with `manifest.description` in `wxt.config.ts` (Web Store limit: 132 characters).
The **detailed description** is pasted into the Web Store dashboard.

## Short description (≤132 chars)

> Blocks secret pastes locally. Business teams receive limited AI-service security metadata—never prompts, pasted text, or secrets.

## Detailed description

Plain text — the Chrome Web Store renders this linearly (no markdown). Paste the
block below as-is; keep the `•` bullets and blank lines, don't add `*` or `#`.

SecureIntent warns you the moment you're about to paste an API key, token, password, or other secret into a website where it doesn't belong — like AI chat and coding assistants.

How it works
• Detection runs entirely on your device. Your pasted text is never sent anywhere.
• When a secret is detected, a warning appears with clear choices: Cancel, Paste anyway, or Paste anonymously — which redacts the secret and pastes the rest.
• Pasting a large log? It can strip out secrets, IP addresses, and emails in one step before the text goes in.
• Only an anonymous, one-way fingerprint of a detected secret is ever sent for aggregate reporting — never the secret itself, and never your text.

What it detects
A wide range of credentials: API keys and access tokens from major cloud and developer platforms, private keys, high-entropy secrets, and common key = value credential patterns. Broad matches (such as card numbers) are confirmed by on-device validators to keep false positives low.

Where it works
Popular AI chat and coding assistants get dedicated support, and a catch-all guard covers text fields on other sites. Protection happens wherever you paste.

Free & Pro
Core detection and warnings are free, including a monthly allowance of Anonymise & Paste. Pro unlocks unlimited Anonymise & Paste, large-log sanitizing, restoring anonymized values later in the same session, and a PIN lock for high-risk cloud consoles. Pro is entirely optional — the free protection works with no sign-up.

Privacy first
Raw pasted text, prompts, secrets, and URL paths never leave your device. The extension computes a salted, one-way hash on-device for anonymous reporting. For Business organisation members who accept the in-product disclosure, it also reports limited activity at recognised AI services: the service hostname, paste byte count, and secret-warning outcome. It never reports page content, URLs, prompts, or pasted text; free and Developer Pro installs do not send this Business metadata. We never sell your data.

## Chrome Web Store dashboard disclosure

Before submitting this release, update the Store's data-use answers to match the
copy above: Shadow AI is optional Business-org telemetry after in-product consent,
uses recognised service hostname plus interaction metadata, and does **not** collect
website content, URL paths/query strings, prompts, pasted text, or secret values.
