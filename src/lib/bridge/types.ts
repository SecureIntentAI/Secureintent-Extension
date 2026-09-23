// The desktop bridge protocol.
//
// The desktop side owns this format (`engine/src/bridge.rs`) and we match it.
// Messages are JSON objects tagged by `type`. No secret and no page content
// crosses the bridge — only the origin of the focused tab, and a short hash
// identifying a copy both sides may have seen.

/** Ports the agent may be on, in the order it binds them (BRIDGE_PORT, PORT_TRIES). */
export const BRIDGE_PORTS = [8137, 8138, 8139, 8140, 8141] as const;

/**
 * How long the desktop should stay quiet about a copy we handled. Their own
 * stored URL expires after 10s (`BROWSER_URL_TTL_MS`); this is the same order of
 * magnitude, long enough to cover a paste the user is mid-way through.
 */
export const HANDLED_TTL_MS = 5000;

/** First frame on every connection. Anything else and the desktop closes on us. */
export interface HelloMessage {
  type: 'hello_v2';
  nonce: string;
}

export interface WelcomeMessage {
  type: 'welcome_v2';
  ok: boolean;
}

/**
 * Where the focused tab is.
 *
 * `url` is what the desktop deserialises today — its `BrowserUrl` variant has a
 * single `url` field, and a frame without it fails to parse and is dropped in
 * silence. So it is required, and it carries the **origin only**: scheme, host
 * and port, never a path, query or fragment. A dev URL's query string routinely
 * holds session tokens and none of that is needed to recognise localhost.
 *
 * `host`, `port` and `ts` are the shape the desktop side asked for in review.
 * Their serde ignores unknown fields, so sending both means the switch to the
 * narrower form is theirs to make whenever they like, with no flag day.
 */
export interface BrowserUrlMessage {
  type: 'browser_url';
  url: string;
  host: string;
  port: number | null;
  ts: number;
}

export type OutboundMessage = HelloMessage | BrowserUrlMessage;
