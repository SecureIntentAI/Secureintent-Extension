# Chrome Web Store listing

Source of truth for the store copy. The **short description** must stay in sync
with `manifest.description` in `wxt.config.ts` (Web Store limit: 132 characters).
The **detailed description** is pasted into the Web Store dashboard.

## Short description (≤132 chars)

> Blocks secret pastes and scans supported text files locally. Business teams receive limited AI-service security metadata.

## Detailed description

Plain text — the Chrome Web Store renders this linearly (no markdown). Paste the
block below as-is; keep the `•` bullets and blank lines, don't add `*` or `#`.

SecureIntent warns you the moment you're about to paste an API key, token, password, or other secret into a website where it doesn't belong — like AI chat and coding assistants.

How it works
• Detection runs entirely on your device. SecureIntent does not send inspected text to its servers; the destination site receives it only when the paste proceeds.
• When a secret is detected, a warning appears with clear choices: Cancel, Paste anyway, or Paste anonymously — which redacts the secret and pastes the rest.
• Supported text files selected through a file picker or dropped onto a page are scanned locally before the page receives them. File contents and file-scan results are not sent to SecureIntent. Binary files and other upload paths are not checked.
• Pasting a large log? It can strip out secrets, IP addresses, and emails in one step before the text goes in.
• Only an anonymous, one-way fingerprint of a detected secret is ever sent for aggregate reporting — never the secret itself, and never your text.

What it detects
A wide range of credentials: API keys and access tokens from major cloud and developer platforms, private keys, high-entropy secrets, and common key = value credential patterns. Broad matches (such as card numbers) are confirmed by on-device validators to keep false positives low.

Where it works
Popular AI chat and coding assistants get dedicated support, and a catch-all guard covers text fields on other sites. Protection happens wherever you paste.

Free & Pro
Core detection and warnings are free, including a monthly allowance of Anonymise & Paste. Pro unlocks unlimited Anonymise & Paste, large-log sanitizing, restoring anonymized values later in the same session, and a PIN lock for high-risk cloud consoles. Pro is entirely optional — the free protection works with no sign-up.

Privacy first
SecureIntent does not send raw pasted text, supported file contents, prompts, or secret values to its servers. Files are scanned locally before the page receives them; if a paste or upload proceeds, the destination site receives that content. The extension computes a salted, one-way hash on-device for anonymous reporting about text pastes; file scans do not generate telemetry. For Business organisation members who accept the in-product disclosure, it also reports limited activity at recognised AI services: the service hostname, text-paste byte count, and secret-warning outcome. It does not report page content, URLs, prompts, pasted text, file contents, or file-scan findings; free and Developer Pro installs do not send this Business metadata. We never sell your data.

## Chrome Web Store dashboard disclosure

Before submitting this release, update the Store's data-use answers to match the
copy above: Shadow AI is optional Business-org telemetry after in-product consent,
uses recognised service hostname plus text-paste interaction metadata, and does **not**
collect website content, URL paths/query strings, prompts, pasted text, file contents,
file-scan findings, or secret values. Text-file scanning runs locally and is not telemetry.
