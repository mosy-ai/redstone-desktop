# How the desktop shell differs from a browser

Reference for whoever is debugging "it works in Chrome but not in the app". None
of this is work to do — it is the environment your pages run in.

---

## Only Redstone's own origins are reachable

The renderer loads remote code, so the shell restricts what it can talk to (spec
§3): the Redstone origin, sibling hosts on the same domain (`*.yitec.dev` for
this deployment, which covers the storage host), and WebSockets to those origins.
Everything else is blocked and logged.

Consequences seen in practice:

- `static.cloudflareinsights.com` is refused on every page load. Cloudflare's
  analytics beacon does not run in the desktop app. Harmless, but it explains the
  console noise.
- `wss://` to the app's own origin **is** allowed. It was not, briefly — the
  allowlist only permitted `http`/`https`, so the web app's socket was killed and
  the page reconnected forever with nothing on screen to explain it. Fixed, with
  a test.

**If you add a CDN, font host or analytics domain that must work in the desktop
app, tell us** and it goes on the allowlist. Otherwise it will silently not load
for desktop users only.

## Every external link opens in the system browser

`target="_blank"`, `window.open`, and any navigation off the Redstone origin are
handed to the OS browser rather than opening a window inside the app. The shell
has exactly the windows it creates itself.

## The user picks a server before logging in

Redstone is self-hostable and regional, so the app cannot assume an origin. The
first screen asks for one, verifies it with:

```http
GET /api/v1/health   → {"status": "healthy", "service": "Redstone Agent"}
```

**Keep `service` containing "Redstone"** in that response — it is how the app
tells a real instance from a typo that happens to resolve. The origin that
*answers* is the one kept, so redirects (http→https, apex→www) record correctly.

Users can switch servers later; links belong to the server they were made on and
go dormant when the user switches away.

## Sign-in is the web app's job entirely

The shell never handles a password. It reads the `rs_token` cookie the web app
sets, sends it as `Authorization: Bearer …` on its own API calls, re-reads it
before every request batch, and **never refreshes it**. On a `401` it pauses sync
and asks the user to sign in again, in your UI.

Two things that matter for that to work:

- `rs_token` must stay readable to JavaScript on the app origin (it is today —
  set with `max-age`, `SameSite=Lax`).
- The shell flushes the cookie store on quit. It did not at first, which logged
  users out on every restart; if that reappears, suspect the shell, not the token
  lifetime.

## Chat is never reimplemented

The desktop renders no message list, no markdown, no settings form. Where you see
desktop UI it is one of three things: the server picker, the strip above the page
(a drag region plus the folder control until you render your own), or the sync
status window. Everything else is your app in a `WebContentsView`.

The one exception is the quick bar's plain-text fallback, which exists only until
[`/quick`](03-quick-route.md) ships and is deliberately worse than the web app so
it does not become a second chat UI.

## Logs

**Help → Show Logs** opens what the app actually wrote. Useful lines:

| Line | Meaning |
|---|---|
| `web app reports the active session…` | your `setActiveSession` is arriving |
| `active session changed (url)` | the shell is inferring from the address bar |
| `blocked request to disallowed origin` | something the page requested is not on the allowlist |
| `sync engine started with N link(s)` | how many folders this machine mirrors |

Logs are scrubbed: tokens become `<token>`, filesystem paths become
`<path:ab12cd34>`, and file contents are never written. Safe to paste into a
ticket.
