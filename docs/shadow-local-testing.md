# Shadow AI in the production extension

Discovery runs inside the SecureIntent extension a Business organisation already installs. There is no separate local extension, no `127.0.0.1` API, and no synthetic seat.

A signed-in member whose licence is `business_pro` and carries a Clerk organisation id (`org_…`) records three kinds of metadata, and only after Terms are accepted:

- one visit when a recognised AI page loads
- the UTF-8 byte size of each text paste on that page
- the outcome of a paste that contained a secret: `blocked`, `cancelled`, `sanitised`, or `warning_bypassed`

The hostname and catalog service id are kept. The URL path, query, and pasted text are not. Incognito windows and frames inside a page are ignored. Free and Developer Pro installs send nothing.

Events are queued on the device for up to 24 hours and posted to `https://api.secureintent.ai/v1/shadow/events` with the Clerk session. The API takes the organisation from that session. Per-tool "prevent pasting" arrives on the signed config bundle as `policy.aiServices` and is enforced by the same paste guard as the rest of team policy.

The API change lives in `secureintent-backend-v2` (`POST /v1/shadow/events` and migration `0015_shadow_events.sql`). It has to be deployed before a production install can deliver events. Until then the extension keeps the queue and retries.
