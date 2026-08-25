# Design notes

Decisions that are not obvious from the code, and the reasoning behind the two
places where this build deviates from the spec.

---

## 1. No native modules — the reason the app cross-compiles

The spec suggests `better-sqlite3` for sync state. This build uses a crash-safe
JSON snapshot store instead (`src/main/store.ts`, `src/main/sync/state.ts`).

**Why.** A native module has to be compiled for each platform *and* each Electron
ABI. That means you can no longer produce a Windows build from a Mac, every
Electron bump needs a rebuild step, and a mismatch surfaces as a runtime crash on
a user's machine rather than a build failure on yours. The requirement here was
that the app compiles cleanly for Windows, Linux and macOS; a zero-native-module
dependency list is what makes that true by construction rather than by luck.

**Is it enough?** The state is one record per synced file, and the sync API
truncates above 20,000 entries per folder — a hard ceiling the app enforces
anyway. 20,000 records is a few MB of JSON: a full read at startup, then
debounced atomic writes (temp file → `fsync` → `rename`). Well inside what a file
handles comfortably.

**If it stops being enough.** `SyncStateStore` is deliberately row-shaped —
`putFile`, `dropFile`, `renameFile`, `file(relPath)`. Swapping in SQLite is a
change to one file, and nothing above it moves. Do it when a link needs more
records than a snapshot can hold, or when partial writes start to matter.

The one thing this costs: the whole per-link state is rewritten on each flush
rather than one row being updated. At 20k files that is a few milliseconds every
500ms of activity, and it is amortised by the debounce.

---

## 2. The quick bar has a local fallback

Spec §7.1 says the bar loads the web app's `/quick` route, which keeps streaming,
markdown, citations, i18n and model routing identical to the main app. Spec §9.2
lists that route as **not started**.

So `quick-window.ts` probes for `/quick` once per run and uses it when it
answers. When it does not, the bar loads a local page that talks to the same
`POST /sessions/{id}/messages` SSE endpoint and renders **plain text only** —
`textContent`, never `innerHTML`.

That restraint is the point. The fallback is deliberately worse than the web app
so nobody is tempted to grow it: no markdown, no citations, no model picker, no
history. When `/quick` ships, `hasQuickRoute()` starts returning true, the
fallback stops being reached, and `src/renderer/quick/*` plus `quick-chat.ts` can
be deleted in one commit.

---

## 3. Where the classification table lives

`src/main/sync/plan.ts` is a pure function: three snapshots in, a list of
operations out. No network, no disk, no Electron.

This is the part of the app that can silently lose a user's work, and it is the
part that is hardest to exercise through the UI — you would need a live server,
a folder, and a way to make both sides change between two polls. As a pure
function it is 22 unit tests, including the cases you would never reproduce by
hand: a hash mismatch with neither side changed, a rename that is really an edit,
a truncated listing that must not delete.

`link-sync.ts` keeps everything that genuinely needs the world: the cycle,
transfers, retry budgets, backoff, status.

---

## 4. Uploads record what was sent, not what was seen

The scan hashes a file, then the upload reads it again. If the user saved in
between, those differ. The recorded hash is the one taken at read time, so state
always describes bytes that actually crossed the wire. The next cycle sees the
newer file and re-uploads. The alternative — recording the scan's hash — makes
the state claim the server holds something it does not, and the change is then
invisible forever.

Downloads get the mirror-image treatment: the temp file is hashed and compared to
the server's hash before it is renamed into place. A truncated transfer fails the
op instead of quietly replacing good content.

---

## 5. Why our own writes invalidate the cursor

The tree cursor is a signature over every entry's path, size and mtime. After we
upload, move, mkdir or delete, the server's tree has changed *because of us* — and
if we kept our cursor, the next poll would return `unchanged: true` against a
tree we have not actually seen in its new form. `invalidateCursor()` after every
write costs one full listing and keeps the cache honest.

---

## 6. Retry budgets are keyed by content, not by path

A file that fails five times is parked: it stops being retried and shows up in
the link's error list, without blocking the queue (spec §5.3). But "parked
forever" would be wrong — the fix for most failures is that the file changes.

So the budget is keyed by path *and* an operation signature that includes the
content hash. Edit the file, or let the agent edit it, and the signature changes,
the budget resets, and the work is retried. Nothing needs to remember to clear a
flag.

---

## 7. Log redaction happens at the transport

`logger.ts` installs one hook on `electron-log` that scrubs every argument of
every message: JWT-shaped strings and `Bearer …` become `<token>`, filesystem
paths become `<path:ab12cd34>`, and any object key matching
`token|secret|password|cookie|authorization` becomes `<redacted>`.

Doing it at the transport rather than at call sites means a future `logger.info`
someone adds in a hurry is covered too — which is what acceptance criterion 11
actually asks for. The path digest is stable within a run, so you can still
follow one file through a cycle without learning its name; `relPathHint()` adds
the extension back when that helps.

URL paths are left alone (`/api/v1/folders` is useful and private to nobody):
only paths under real filesystem roots are hashed.

---

## 8. The origin allowlist widens by exactly one level

Spec §3 says to restrict the renderer to "the Redstone origin plus the storage
host". The storage host is deployment configuration
(`STORAGE_PUBLIC_ENDPOINT_URL` in the backend), so the shell cannot know it — and
blocking it would break every image and download the web app renders.

`src/shared/origins.ts` therefore allows the app origin plus **sibling hosts of
its own domain**: `redstone-agent.yitec.dev` also permits `*.yitec.dev`. One
level, same scheme, and never when the parent is a public suffix — `app.co.uk`
derives no wildcard at all. Anything further afield has to be listed explicitly
in `settings.allowedOrigins`, which is why `setSettings` over the bridge refuses
to write that field: remote code must not be able to widen its own cage.

The rule is pure and tested (`test/origins.test.ts`) rather than inlined into the
`webRequest` handler, because "which URLs can remote code reach" is not a
question you want to answer by reading a callback.

---

## 9. The server comes before the login

Redstone can be self-hosted and runs in more than one region, so a desktop build
cannot ship with an origin baked in — the way Mattermost cannot. The first screen
is therefore the server address, before any login form, because the login form
lives on the server the user has not named yet.

`servers.ts` does three things worth calling out:

- **It accepts what people type.** `redstone.acme.com`, a pasted
  `https://redstone.acme.com/chat?s=…`, a trailing slash and a `:3070` all
  normalise to one origin. Paths are dropped rather than half-supported: the web
  app routes from the domain root, so a sub-path deployment is not something the
  shell can honour by pretending.
- **It probes before accepting.** `GET /api/v1/health` is unauthenticated and
  answers `{"service":"Redstone Agent"}`, which distinguishes a real instance
  from a typo that happens to resolve. The origin that is kept is the one that
  *answered*, so an http→https or apex→www redirect is recorded correctly.
- **It only falls back to http for local addresses.** `localhost:3070` should
  work without spelling out the scheme; `acme.com` should never be silently
  downgraded.

**Switching is ordered, not just reassigned** (`server-switch.ts`): sync stops
*before* the origin changes. Reversed, an in-flight cycle would finish against
the new server holding the old server's state — which is how one company's files
end up uploaded into another's folder.

Links carry a `serverOrigin` for the same reason. A folder id means nothing on a
different instance, so the engine only runs the links belonging to the active
server; the rest sit dormant and resume when the user switches back. Nothing is
deleted by a switch.

---

## 10. The icon is the wordmark, not a redrawing

The web app sets `redstone.` in Fraunces with the full stop in clay
(`AuthScreen.tsx`, `globals.css`). The app icon is that mark reduced to `r.`, and
the outlines in `build/icon.svg` are the **real Fraunces contours** — extracted
from the same static instance Google Fonts serves the web app, at unitsPerEm
2000, with the font's own advance (957) placing the full stop. An eyeballed
lookalike would drift from the product every time either side changed.

`npm run icons` rasterises the SVGs through Electron's Chromium rather than a
native image library: no image toolchain to install anywhere, and the icon is
rendered by the same engine that renders the app. The SVGs are the source of
truth and are meant to be edited by hand.

---

## 11. What the shell deliberately does not do

- No local database of conversations, no local file browser, no reimplementation
  of chat, notes, tasks or settings. The OS file manager is the file browser;
  `revealInFileManager` is the whole feature.
- No background screen capture, no folder watching the user did not ask for.
- No token refresh. The web app owns the session; the shell reads a cookie and
  reports `401` upward.
- No `webview`, no popups: every external URL goes to the system browser.
