# Redstone Desktop — build spec

**Audience:** the desktop developer building this. You do not need access to the
Redstone backend or web source to build against this document; everything you
call is listed with its exact path, request and response shape.

**Status:** ready to start. The sync API this depends on is **built and live** —
see [§9](#9-what-we-build-for-you), and
[folder-sync-api.md](folder-sync-api.md) for the exact contract. Nothing blocks
Phases 1 and 2.

**Contacts:** the Redstone backend/web team owns everything under
[§9 What we build for you](#9-what-we-build-for-you). One item there is still
outstanding, and it is only needed for Phase 3.

---

## 1. What this is

A desktop app that puts Redstone on the user's machine and connects it to their
local files.

The web app at `https://redstone-agent.yitec.dev` already does chat, dashboards,
knowledge bases, notes, tasks and settings. **The desktop app does not
reimplement any of it.** It loads the web app in a window and adds the four
things a browser cannot do:

1. **Folder workspaces** — link a local folder to a Redstone chat. Files sync up,
   the agent works on them server-side, results sync back down. The user edits in
   their own editor; Redstone edits the same files.
2. **Local files into a chat** — drag a file from Finder/Explorer onto the window,
   or attach through a native file dialog.
3. **A quick chat bar** — a global keyboard shortcut summons a small always-on-top
   input from anywhere, without switching to the app.
4. **Screen capture** — one keystroke shows Redstone what is currently on screen.

Everything else stays the web app's job. If you find yourself writing a message
list, a markdown renderer or a settings form, stop: that is a signal the feature
belongs in the web UI instead, and we will add it there.

---

## 2. Product principles

**The web app is the app.** The shell is a container plus a small, explicitly
enumerated native API. When the web app ships a feature, the desktop app has it
the same day, with no desktop release.

**Native features are opt-in and visible.** Nothing reads the disk or the screen
without a user action that plainly means "do this now". No background screen
capture, no watching folders the user did not pick.

**Sync never destroys work.** A conflict produces two files, never one
overwritten one. This rule outranks tidiness.

**Offline degrades, it does not break.** With no network the window shows a
retry state and the sync engine queues; when connectivity returns it drains.

---

## 3. Architecture

```
┌─ main process (Node) ──────────────────────────────────────────┐
│  • window + tray + global shortcuts                            │
│  • sync engine (file watcher, queue, SQLite state)             │
│  • screen capture                                              │
│  • native dialogs, path allowlist, token access                │
│  • auto-update                                                 │
└───────────┬────────────────────────────────────────────────────┘
            │ contextBridge (preload) — the ONLY channel
┌───────────▼─────────────────┐   ┌──────────────────────────────┐
│ main window                 │   │ quick bar window             │
│ BrowserWindow → the web app │   │ frameless, always-on-top     │
│ https://…/chat?client=…     │   │ → the web app's /quick route │
└─────────────────────────────┘   └──────────────────────────────┘
```

**Stack:** Electron (latest stable at build time) + TypeScript. Suggested
libraries, not mandates: `chokidar` (watching), `better-sqlite3` (sync state),
`electron-builder` (packaging), `electron-updater` (updates). Keep the main
process dependency list short — it holds the user's token and file access.

**Renderer security is non-negotiable.** The renderer loads remote content, so:

```js
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, 'preload.js'),
}
```

Use one persistent session partition (e.g. `persist:redstone`) across all
windows so login is shared. Restrict `webRequest` to the Redstone origin plus
the storage host; open every other URL in the system browser via
`shell.openExternal` (handle `setWindowOpenHandler` and `will-navigate`).

**Platforms:** macOS 13+ (arm64 + x64), Windows 10+ (x64). Linux is
best-effort — ship an AppImage if it is cheap, skip it otherwise.

---

## 4. Authentication

**The user logs in through the normal web login form.** Do not build a native
login screen; do not handle passwords in the shell.

The web app stores a JWT in a cookie named `rs_token` on the app origin. Because
all windows share one persistent partition, the main process can read it:

```js
const [cookie] = await session.fromPartition('persist:redstone')
  .cookies.get({ url: 'https://redstone-agent.yitec.dev', name: 'rs_token' });
const token = cookie?.value;
```

Send it as `Authorization: Bearer <token>` on every API call you make from the
main process.

Rules:

- **Re-read the cookie before each request batch.** The web app refreshes the
  token; a value cached at startup goes stale. Access tokens last 24 hours,
  refresh tokens 7 days.
- **On `401`, stop and surface it.** Pause sync, show "Sign in again", and let
  the user click through to the main window. Never attempt to refresh yourself —
  the web app owns that.
- **Never write the token to disk, a log file, or a crash report.** Hold it in
  memory only.
- If no cookie exists, the user is not logged in: show the main window and let
  the web app handle it.

---

## 5. Feature: folder workspaces

The headline feature. Everything else in this document is smaller.

### 5.1 Concept

A **Redstone folder** is a durable, server-side project directory. It is
mounted as the agent's working directory, so the agent reads and writes it the
way a developer works in a project checkout. Folders already exist and are
already usable from the web app — they are not new.

The desktop app adds a **link**: one Redstone folder ↔ one local directory,
kept in sync both ways.

```
~/Projects/q3-report  ⇄  Redstone folder "Q3 report"  →  agent works here
        ↑                                                       │
        └────────────── changes sync back ─────────────────────┘
```

A chat session is then **bound** to that folder, so the agent in that chat sees
those files.

### 5.2 User flows

**Link an existing local folder**

1. User clicks "Open a folder" in the app (a native menu item, or a button the
   web app renders when it detects the desktop bridge).
2. Native directory picker.
3. The shell creates a Redstone folder named after the directory, or lets the
   user attach to one that already exists.
4. Initial sync: everything local uploads; anything already server-side
   downloads (see conflict rules below).
5. The shell creates a chat session bound to that folder and navigates the main
   window to it.

**Work**

- User edits files in their own editor → the change uploads within seconds.
- User asks Redstone to do something → the agent works on the server-side copy.
- Agent writes files → they appear in the local directory.
- A status indicator shows: `Synced` / `Syncing (3 files)` / `Paused` /
  `Sign in again` / `Conflicts (2)`.

**Unlink**

Stops syncing. **Never deletes local files.** Ask whether to also delete the
server-side folder; default is no.

### 5.3 Sync engine

**State store.** SQLite, one row per synced file, at minimum:

| column | meaning |
|---|---|
| `link_id` | which folder link |
| `rel_path` | POSIX-style path relative to the link root |
| `local_mtime`, `local_size` | as of last successful sync |
| `local_hash` | sha256 of content as of last successful sync |
| `remote_mtime`, `remote_size` | as reported by the server |
| `remote_hash` | server-reported hash (see §9.4) |
| `state` | `synced` / `pending_up` / `pending_down` / `conflict` |

`local_hash` is what makes correctness possible. Do **not** decide "changed"
from mtime alone: the server-side files live on an S3-backed FUSE mount, so a
file's remote mtime is the time the *server* wrote it, not the time the user
saved it. Use mtime+size as a cheap pre-filter, then hash before acting.

**Detecting local changes.** `chokidar` with `awaitWriteFinish` (editors write
temp files then rename; without this you upload half-written files). Debounce
~1.5s per path. Full rescan on app start and every ~15 minutes — watchers miss
events after sleep, network drive reconnects, and on some Windows configurations.

**Detecting remote changes.** Poll the folder tree. Adaptive interval:

- `10s` normally,
- `2s` while a turn is streaming in a session bound to this folder (the web app
  tells you via the bridge — see §8),
- back off to `60s` after 5 minutes with no local or remote activity, and on
  repeated network errors (exponential, capped).

**Upload / download.** Sequential per link, max 2 links in parallel. Never
saturate the user's uplink. Retry with exponential backoff; a file that fails 5
times goes to an error list, visible in the UI, and does not block the queue.

### 5.4 Conflicts

A conflict is: **both sides changed since the last successful sync of that path**
(local hash ≠ stored local hash **and** remote hash ≠ stored remote hash).

Resolution: **keep both, lose nothing.**

1. Download the remote version to `<name> (Redstone's copy YYYY-MM-DD HHmm).<ext>`.
2. Leave the user's local file untouched at its original path.
3. Upload the local file (it wins the canonical path).
4. Mark the link `conflict` and surface a notification naming the file.

Never merge. Never overwrite. Never resolve silently.

### 5.5 What must not sync

The server hides scaffolding at a folder root — it is agent machinery, not user
content, and **it will not appear in listings even though it exists on the
server**. Treat these names as "not present" on both sides. Never upload them,
never interpret their absence as a remote deletion:

```
session.json   workspace_context.json   .env    .gitignore   .git
__pycache__    node_modules             .venv   .claude      skills
data-workspace .memory                  MEMORY.md
.skills-account                         .skills-baseline.json
```

Additionally skip locally: `.DS_Store`, `Thumbs.db`, `~$*` (Office lock files),
`*.tmp`, `*.crdownload`, `*.part`, symlinks (do not follow), anything over the
size cap (§7.3), and any path the user adds to a per-link ignore list. Support a
`.redstoneignore` file (gitignore syntax) at the link root.

Warn, and require an explicit confirm, if the user picks a directory that
contains a `.git` directory, `node_modules`, or more than 5,000 files. The
common accident is linking a whole home directory.

### 5.6 API you use

Base: `https://redstone-agent.yitec.dev/api/v1`. All calls need
`Authorization: Bearer <token>`.

| Call | Purpose |
|---|---|
| `GET /folders` | List folders. Returns `{mount_ready, items:[{id,name,created_at,updated_at}]}`. **If `mount_ready` is false, pause sync and show "Folder storage unavailable"** — writing anyway loses data. |
| `POST /folders` `{name}` | Create. → `{id,name,…}` |
| `PATCH /folders/{id}` `{name}` | Rename |
| `GET /folders/{id}/files?path=<sub>` | List **one directory level**. → `[{name,is_dir,size,modified}]` |
| `GET /folders/{id}/download?path=<file>` | Download bytes |
| `POST /folders/{id}/files?path=<sub>` | Upload, `multipart/form-data`, field `file` |
| `POST /folders/{id}/mkdir` `{path,name}` | Create a subdirectory |
| `POST /sessions` `{name, folder_id}` | Create a chat bound to the folder |

Today's listing is one directory per request, so a deep tree costs many
round-trips, and there is no delete, no move, and no content hash. §9 covers the
additions; build against the shapes documented there and treat the current
endpoints as the fallback.

---

## 6. Feature: local files into a chat

Two entry points, one path underneath.

**Drag and drop.** A file dragged onto the main window attaches to the current
chat. Show a full-window drop target with a clear "Drop to attach" state.
Electron gives you the real path via `webUtils.getPathForFile(file)` in the
preload; the deprecated `File.path` property is gone in current Electron.

**Native picker.** A menu item and a bridge method opening `dialog.showOpenDialog`.

**Upload.** For each file, in order:

```
POST /api/v1/sessions/{session_id}/attachments/upload
  multipart/form-data, field "file"
  → { attachment_id, file_id, filename }
```

Then hand the `attachment_id` list to the web app through the bridge; the web
app sends the message. **Do not send the message from the shell** — the web app
owns composing, streaming and rendering.

Use this proxied endpoint, not the presigned-URL variant
(`POST /sessions/{id}/attachments`). The presigned URLs point at a storage host
that clients outside the server network cannot always reach; routing through the
backend works everywhere. This has bitten us before.

**Limits** (fetch them at runtime from `GET /api/v1/files/upload-constraints`
rather than hardcoding; current values shown for sizing):

- 100 MB per file
- 20 files per batch

Enforce them client-side too, with a clear message. Do not start a 2 GB upload
that the server will reject.

---

## 7. Feature: quick chat bar and screen capture

### 7.1 The bar

A frameless, transparent, always-on-top `BrowserWindow`, roughly 720×72 px
collapsed, growing to ~720×420 when an answer streams in. Centred horizontally,
about a third down the screen. `skipTaskbar: true`,
`setVisibleOnAllWorkspaces(true)`.

**Default shortcut:** `Cmd+Shift+Space` (macOS) / `Ctrl+Shift+Space` (Windows).
Configurable in the app's settings, persisted locally. `globalShortcut.register`
returns false when another app already owns the combination — detect that and
tell the user instead of failing silently.

Behaviour: shortcut toggles. `Esc` hides. Blur hides (unless a response is
streaming). `Enter` sends. `Cmd/Ctrl+Enter` sends **and** opens the full window
on that conversation.

**Contents:** it loads the web app at a dedicated lightweight route
(`/quick?client=desktop`) — see §9.5. This keeps streaming, markdown, citations,
Vietnamese/English copy and model routing identical to the main app for free.

### 7.2 Screen capture

**Trigger:** a second global shortcut (default `Cmd/Ctrl+Shift+1`), and a camera
button in the quick bar. Both are explicit user actions. There is no automatic,
scheduled or background capture — do not add one.

**Flow:**

1. Capture via `desktopCapturer.getSources({types:['screen','window']})`.
   - One display → capture it.
   - Multiple displays or a window request → show a picker.
   - Region select (drag a rectangle on a transparent overlay window) is phase 3.
2. Show the thumbnail inside the quick bar so the user sees exactly what will be
   sent, with a remove button. **Never send a capture the user has not seen.**
3. On send: PNG → `POST /sessions/{id}/attachments/upload` → pass the
   `attachment_id` to the web app with the message.

**The backend already handles the rest.** A turn carrying an image is routed
automatically to a vision-capable model. No special flag, no separate endpoint.

**macOS permission.** Screen Recording must be granted in System Settings →
Privacy & Security, and macOS only lists an app there after it has attempted a
capture. Handle the first-run case explicitly: attempt, detect the empty/black
result, then show an explainer with a button that deep-links to
`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`.
Note that macOS requires an app restart after the permission is granted.

**Privacy.** Capture only on the keystroke. Show a visible indicator while a
capture is pending. Delete the temp file after upload. Never capture while the
screen is locked.

### 7.3 Notifications

Native notifications for: agent finished a turn started from the quick bar, sync
conflict, sync error needing attention, sign-in expired. Clicking opens the
relevant view. Everything else is in-app only — do not notify per file synced.

---

## 8. The bridge (shell ↔ web app)

Exposed from the preload, versioned, minimal. The web app feature-detects
`window.redstone` and shows desktop-only affordances when it is present.

```ts
window.redstone = {
  version: '1',
  platform: 'darwin' | 'win32' | 'linux',

  // folders
  pickFolder(): Promise<string | null>,
  linkFolder(o: { folderId: string; localPath: string }): Promise<LinkStatus>,
  unlinkFolder(folderId: string): Promise<void>,
  listLinks(): Promise<LinkStatus[]>,
  revealInFileManager(o: { folderId: string; relPath?: string }): Promise<void>,
  onSyncStatus(cb: (s: LinkStatus) => void): () => void,   // returns unsubscribe

  // files
  pickFiles(o?: { multiple?: boolean }): Promise<AttachmentRef[]>,
  onFilesDropped(cb: (f: AttachmentRef[]) => void): () => void,

  // capture
  captureScreen(): Promise<AttachmentRef | null>,

  // windows
  openQuickBar(): Promise<void>,
  closeQuickBar(): Promise<void>,
  openMainWindow(o?: { sessionId?: string }): Promise<void>,

  // the web app tells the shell a turn is streaming, so sync polls faster
  setTurnActive(o: { sessionId: string; active: boolean }): void,
};

type LinkStatus = {
  folderId: string;
  localPath: string;
  state: 'synced' | 'syncing' | 'paused' | 'error' | 'conflict' | 'signed_out';
  pending: number;
  conflicts: string[];    // relative paths
  lastSyncedAt: string | null;   // ISO 8601
  message?: string;
};

type AttachmentRef = { attachmentId: string; filename: string; sizeBytes: number };
```

**Trust boundary.** The renderer runs remote code. The main process must
therefore:

- keep an allowlist of linked roots and reject any `localPath` not created by a
  native dialog in this session;
- resolve and normalise every path, rejecting anything that escapes its root
  (`..`, symlinks, junctions);
- expose no generic `readFile`/`writeFile`/`exec`. If a future feature seems to
  need one, it does not — add a specific method instead.

---

## 9. What we build for you

### 9.1 Sync API — done, live

Everything Phase 2 was blocked on is built and deployed. Full contract, with
real responses and a worked sync loop: **[folder-sync-api.md](folder-sync-api.md)**.

| | |
|---|---|
| `GET /folders/{id}/tree` | whole tree in one call, `sha256` per file, and a `cursor` so an idle folder answers `unchanged: true` without hashing anything |
| `DELETE /folders/{id}/files` | a local deletion can finally propagate; a non-empty directory needs `recursive=true` |
| `POST /folders/{id}/move` | rename without re-uploading the bytes |
| `GET /folders/{id}/stat` | one entry, hash included |
| `POST /folders/{id}/files` | now returns a real `modified`, so no re-list after every upload |

Two things to read before you design the engine: deletions are **not** reported
(diff the complete listing against your own state), and `truncated: true`
suspends that rule entirely. Both are covered in the API doc.

### 9.2 A `/quick` route in the web app — not started

A minimal composer + streaming answer + attachment chip, styled for the bar,
sharing the main app's session, i18n and model routing. Small piece of work on
our side; it is what lets the bar stay a thin container. Needed for Phase 3, so
it does not block you now.

### 9.3 Smaller items — not started

- Chunked/resumable upload above ~25 MB. Until then, a dropped connection at
  95 MB restarts from zero.
- A change notification (websocket/SSE) so you are not polling for the agent's
  writes. The cursor makes polling cheap enough that this is comfort, not need.
- A desktop-friendly download for the app itself, plus a version/update feed
  endpoint if we do not host releases on a static bucket.

## 10. Packaging and distribution

- `electron-builder`. macOS: universal or two arch builds, hardened runtime,
  notarized; entitlements must include screen recording and, if you use the
  native file dialog on a sandboxed build, user-selected file access.
  Windows: signed installer (NSIS).
- Auto-update through `electron-updater` against a static release feed. Check on
  launch and every 6 hours. Never force-restart mid-turn: prompt, and default to
  applying on next launch.
- Crash reporting is opt-in. **Scrub file paths and never include the auth
  token, file contents, or screen captures.**
- Ship a version string the web app can read via the bridge, so we can gate
  desktop features on a minimum shell version.

---

## 11. Phases

**Phase 1 — shell + files.** Window, persistent session, auth via cookie, menus,
tray, drag-and-drop attach, native file picker, packaging and update channel.
Ships useful on its own.

**Phase 2 — folder sync.** The engine, conflict handling, status UI, ignore
rules. Depends on §9.1–9.4. This is the bulk of the work; budget accordingly.

**Phase 3 — quick bar + capture.** Global shortcuts, the bar (depends on §9.5),
full-screen and window capture, notifications.

**Phase 4 — polish.** Region capture, multiple linked folders at once, selective
sync, bandwidth limits, Linux build.

---

## 12. Non-goals

- No local LLM, no offline agent. The agent runs server-side, always.
- No reimplementation of chat, notes, tasks, knowledge bases or settings.
- No local file browser UI. The OS file manager is the file browser; use
  `revealInFileManager`.
- No local database of conversations. History lives on the server.
- No mobile.

---

## 13. Acceptance criteria

The build is done when a reviewer can, on a clean machine, do all of the
following without a developer present:

1. Install, launch, log in with a real account, and reach their existing chats.
2. Link `~/Documents/test-project` (containing a nested subdirectory) and see it
   report `Synced` with the correct file count.
3. Ask Redstone in the bound chat to modify a file; within 15 seconds the local
   file on disk contains the change.
4. Edit the same file locally in a text editor; within 15 seconds the agent, asked
   to read it, reports the new content.
5. Edit locally **and** have the agent edit the same file while the app is
   quit — then relaunch and find two files: theirs untouched, plus a
   `(Redstone's copy …)` sibling, with a conflict notification.
6. Delete a local file and see it gone server-side (needs §9.1).
7. Drag a PDF onto the window and get an answer about its contents.
8. Press the global shortcut from another application, type a question, and get a
   streamed answer without the main window ever taking focus.
9. Press the capture shortcut, see the thumbnail preview, send it, and get an
   answer that describes what was on screen.
10. Pull the network cable mid-sync, reconnect, and see the queue drain with no
    lost or corrupted file.
11. Confirm no token, file path, or file content appears in any log the app
    writes.

---

## 14. Open questions

1. **Folder ↔ session cardinality.** One folder can back many chats. Should the
   desktop app pin one "current" chat per folder, or list them all? Leaning
   towards: link is to the folder, chats are listed under it.
2. **Team folders.** Folders are per-user today. If two people link the same
   shared folder later, the conflict rules in §5.4 hold, but presence
   ("Anh is editing this") does not exist. Out of scope for now; do not design it
   out.
3. **Sync scale ceiling.** What is the largest folder we support? Proposal:
   soft-warn at 5,000 files or 2 GB, hard-refuse above 20,000 files, revisited
   once §9.3 lands and we can measure.
4. **Quick bar without a chat.** Does the bar always start a new conversation, or
   continue the last one? Proposal: new conversation by default, with a toggle to
   continue the most recent.
