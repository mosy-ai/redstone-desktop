# Redstone Desktop

The Redstone web app in a window, plus the four things a browser cannot do:

1. **Folder workspaces** — link a local directory to a Redstone folder, synced both ways.
2. **Local files into a chat** — drag from Finder/Explorer, or use a native picker.
3. **A quick chat bar** — a global shortcut summons a composer from anywhere.
4. **Screen capture** — one keystroke shows Redstone what is on your screen.

Everything else is the web app's job. There is no message list, no markdown
renderer and no settings form in this repo — if you find yourself writing one,
the feature belongs in the web UI ([spec §1](docs/redstone-desktop-spec.md)).

---

## Quick start

```bash
npm install
npm run icons      # renders build/icon.svg → icon.png + tray.png (no binaries in git)
npm run dev        # build + launch
```

On first launch the app asks for a **server address** before anything else —
Redstone is self-hostable and regional, so there is no origin to assume. The
address is probed (`GET /api/v1/health`) to confirm it is really a Redstone
instance, then remembered; `File → Switch Server…` changes it later and keeps a
short list of the ones you have used.

Skip that screen while developing against a known deployment:

```bash
REDSTONE_ORIGIN=http://localhost:3070 npm run dev
```

You then sign in through the normal web login form, on that server. The shell
never handles a password — it reads the `rs_token` cookie the web app sets, and
on a `401` it pauses sync and asks you to sign in again rather than trying to
refresh anything itself.

### Everyday commands

| Command | What it does |
|---|---|
| `npm run verify` | typecheck → unit tests → bundle → headless boot. The one to run before pushing. |
| `npm test` | the sync classification table and the origin allowlist, as tests |
| `npm run build` | esbuild → `dist/` (main, preload, local pages) |
| `npm run watch` | same, incremental |
| `npm run smoke` | boots the real main process headlessly and exits non-zero if the shell fails to come up |
| `npm run pack` | unpacked app for this platform, in `release/` |
| `npm run dist:mac` / `dist:win` / `dist:linux` | installers |
| `npm run dist:cross` | Windows + Linux installers, from any host |

---

## Layout

```
src/
├── main/                  # Node side: the only place with file and token access
│   ├── index.ts           # bootstrap, lifecycle, smoke-test mode
│   ├── security.ts        # navigation allowlist, permission denials
│   ├── auth.ts            # reads rs_token from the shared partition
│   ├── logger.ts          # redaction: no token, no path, no content ever lands in a log
│   ├── api/client.ts      # the entire REST surface used, and nothing else
│   ├── sync/
│   │   ├── plan.ts        # the classification table, pure and tested
│   │   ├── link-sync.ts   # one link: cycle, apply, retry, backoff
│   │   ├── engine.ts      # all links, the 2-at-a-time budget, the mount gate
│   │   ├── state.ts       # per-file sync state + cached remote listing
│   │   ├── scan.ts        # local walk and hashing
│   │   ├── watcher.ts     # chokidar with awaitWriteFinish
│   │   └── ignore.ts      # server-hidden names, junk, .redstoneignore
│   ├── capture.ts         # user-triggered only, preview before send
│   ├── folder-flow.ts     # pick → warn → create/attach → sync → bound chat
│   ├── servers.ts         # which instance: normalise, probe, remember
│   ├── server-switch.ts   # stop sync → repoint → restart, in that order
│   └── windows/           # main, quick bar, sync status, server picker
├── preload/index.ts       # window.redstone — the whole bridge, plus the drop target
├── renderer/              # the shell's own pages (server, quick bar, status, picker, offline)
└── shared/
    ├── origins.ts         # what remote code may reach, pure and tested
    ├── types.ts           # the bridge contract
    └── constants.ts
```

---

## The bridge

**Handing work to the web team?** `docs/integration/` has one document per piece,
each self-contained: [the backend binding](docs/integration/01-bind-folder-to-session.md),
[the folder control in the chat](docs/integration/02-folder-control-in-chat.md),
[the `/quick` route](docs/integration/03-quick-route.md), plus a
[full bridge reference](docs/integration/bridge-api.md) and
[how the shell differs from a browser](docs/integration/shell-behaviour.md).

The web app feature-detects `window.redstone` and shows desktop affordances when
it is there. Full shape in [`src/preload/index.ts`](src/preload/index.ts); it
matches [spec §8](docs/redstone-desktop-spec.md) with additive extras (`info()`,
`openFolder()`, `pauseLink`/`resumeLink`/`syncNow`, and an optional `sessionId`
on `pickFiles`/`captureScreen`).

```js
if (window.redstone) {
  const links = await window.redstone.listLinks();
  window.redstone.onSyncStatus((status) => render(status));

  // Attach files the user picked natively; the web app still sends the message.
  const refs = await window.redstone.pickFiles({ sessionId });

  // Tell the shell a turn is streaming so sync polls at 2s instead of 10s.
  window.redstone.setTurnActive({ sessionId, active: true });
}
```

Two things the web app should call, because the shell cannot know them on its
own: **`setActiveSession(sessionId)`** whenever the open conversation changes
(so a dropped file knows where to go), and **`setTurnActive`** around streaming.

### Trust boundary

The renderer runs remote code, so the main process:

- accepts a `localPath` only if a native dialog in this session produced it;
- resolves every relative path inside its link root and rejects anything that
  escapes (`..`, absolute paths, symlinks);
- exposes no generic `readFile` / `writeFile` / `exec`. If a future feature
  seems to need one, it does not — add a specific method instead.

---

## Sync, in one page

Each cycle follows [docs/folder-sync-api.md §4](docs/folder-sync-api.md):

```
GET /tree?cursor=…  →  diff against our own state  →  apply  →  record on success
```

- **Hashes decide, mtimes only pre-filter.** Server mtimes are its own write
  times, and a rewrite can keep the same length.
- **Deletions are not reported**, so a path we hold that is absent from a
  complete listing was deleted server-side. **`truncated: true` suspends that
  rule entirely** — a partial listing never deletes anything.
- **Conflicts keep both.** The remote copy lands beside yours as
  `<name> (Redstone's copy YYYY-MM-DD HHmm).<ext>`, your file keeps the canonical
  path and is uploaded. Never merged, never overwritten, never silent.
- **Renames move, they do not re-upload.** A path that disappears and one that
  appears with the same hash in the same cycle is one `POST /move` — but only
  when the other side still agrees with our record.
- **Polling adapts**: 2s while a turn streams, 10s normally, 60s after five idle
  minutes, exponential backoff on errors.

Downloads are verified against the server's hash before they replace anything,
so a truncated transfer can never quietly eat a good file.

`npm test` covers the classification table, rename detection, operation
ordering, the conflict-copy naming and the renderer's origin allowlist — 31
cases, no network or disk required.

---

## Packaging

`electron-builder`, configured in [`electron-builder.yml`](electron-builder.yml):

| Platform | Targets | Notes |
|---|---|---|
| macOS 13+ | dmg + zip, arm64 & x64 | hardened runtime, entitlements, notarization via `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` |
| Windows 10+ | NSIS, x64 & arm64 | sign with `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` |
| Linux | AppImage + deb, x64 & arm64 | best effort, per spec §3 |

**There are no native modules**, on purpose — see [docs/DESIGN.md](docs/DESIGN.md).
The same `dist/` runs on every platform, so cross-building never needs a
toolchain for someone else's OS — and in practice it does not need CI either:
`npm run dist:cross` builds the Windows and Linux installers on a Mac, and was
verified to produce the same seven artifacts (NSIS x64/arm64/universal, AppImage
and deb for both architectures) that the Linux and Windows runners do.
electron-builder fetches its own NSIS, AppImage and fpm toolchains.

CI (`.github/workflows/build.yml`) still builds all three, because it is the
check that a change compiles and boots on every platform, not just a way to get
installers. The one thing that genuinely needs a native host is **macOS signing
and notarization**: those want the Apple certificate in a keychain.

Two things worth knowing before your first local package:

- **Set `REDSTONE_UPDATE_URL`** for any build you intend to ship. It is
  interpolated into `app-update.yml`; without it the packaged app has no update
  feed (`--dir` builds do not care).
- **electron-builder refuses output paths containing shell-special characters**,
  so a checkout under a directory like `Na's Mac Data` needs
  `--config.directories.output=/some/plain/path`. Nothing else in the build
  minds.

Updates use `electron-updater` against a static feed (`REDSTONE_UPDATE_URL`):
checked on launch and every 6 hours, applied on next launch unless you choose to
restart. It never restarts mid-turn.

---

## Privacy

- The token lives in memory only. Nothing writes it to disk, a log or a crash
  report.
- Logs are scrubbed at the transport: JWTs become `<token>`, filesystem paths
  become `<path:ab12cd34>`. File contents are never logged.
- Screen capture happens only on a keystroke or the bar's camera button, you see
  the exact image before it is sent, and the PNG never touches disk.
- Crash reporting is off. `Help → Show Logs` opens what the app actually wrote.

---

## Status against the spec

| Phase | State |
|---|---|
| 1 — shell, auth, drag-drop, picker, packaging, updates | done |
| 2 — folder sync: engine, conflicts, ignore rules, status UI | done |
| 3 — quick bar, capture, shortcuts, notifications | done, with a local fallback bar until the web app ships `/quick` ([spec §9.2](docs/redstone-desktop-spec.md)) |
| 4 — region capture, selective sync, bandwidth limits | not started |

Known gaps, honestly: uploads are not resumable (neither is the API), the sync
engine's cycle is covered by unit tests at the planning layer but not
end-to-end against a live server, and the quick bar's fallback renders plain
text only.
