/**
 * Origin matching for the renderer's network allowlist.
 *
 * Pure and dependency-free so the rule that decides what remote code may talk
 * to can be tested directly — see `test/origins.test.ts`.
 */

/** Schemes the shell serves itself, or that carry no network traffic. */
export const LOCAL_SCHEMES: ReadonlySet<string> = new Set([
  'file:',
  'devtools:',
  'blob:',
  'data:',
  'about:',
  'chrome-extension:',
]);

/** ws/wss are judged as the http/https origin they connect to. */
const WS_EQUIVALENT: Readonly<Record<string, string>> = {
  'ws:': 'http:',
  'wss:': 'https:',
};

/**
 * Registrable-suffix pairs that must never become a wildcard: `foo.co.uk` has
 * three labels but its parent is a public suffix, and allowing `.co.uk` would
 * allow an entire country. Not a full public-suffix list — just the shapes a
 * deployment of this app might plausibly use.
 */
const PUBLIC_SUFFIX_PAIRS: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'or.jp', 'ne.jp',
  'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.my',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  'co.nz', 'co.za', 'co.kr', 'co.id', 'co.th', 'co.il', 'co.in',
]);

/**
 * `https://redstone-agent.yitec.dev` → `https://.yitec.dev`, a suffix pattern
 * that also matches the storage host (spec §3). Returns null when the origin has
 * no sibling worth allowing: an IP, a bare hostname, an apex domain, or a name
 * whose parent is a public suffix.
 */
export function siblingSuffix(origin: string): string | null {
  try {
    const { protocol, hostname } = new URL(origin);
    if (/^\d+(\.\d+){3}$/.test(hostname)) return null;
    const labels = hostname.split('.');
    if (labels.length < 3) return null;
    const parent = labels.slice(1).join('.');
    if (PUBLIC_SUFFIX_PAIRS.has(parent)) return null;
    return `${protocol}//.${parent}`;
  } catch {
    return null;
  }
}

/**
 * Is `rawUrl` allowed?
 *
 * An entry is either an exact origin (`https://app.example.com`) or a suffix
 * pattern with a leading dot after the scheme (`https://.example.com`), which
 * matches that host and its subdomains on the same scheme.
 */
export function isAllowedUrl(rawUrl: string, allowed: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;

  // A WebSocket to an allowed origin is the same trust decision as an HTTPS
  // request to it — the web app opens one to its own host for live updates, and
  // refusing it leaves the page reconnecting forever.
  const scheme = WS_EQUIVALENT[url.protocol] ?? url.protocol;
  if (scheme !== 'https:' && scheme !== 'http:') return false;

  // Built by hand rather than read from `url.origin`, which is not the http
  // origin for a ws: URL.
  const origin = `${scheme}//${url.host}`;

  return allowed.some((entry) => {
    const trimmed = entry.replace(/\/+$/, '');
    if (origin === trimmed) return true;
    const match = /^(https?:)\/\/\.(.+)$/.exec(trimmed);
    if (!match) return false;
    const [, entryScheme, parent] = match;
    if (scheme !== entryScheme || !parent) return false;
    return url.hostname === parent || url.hostname.endsWith(`.${parent}`);
  });
}
