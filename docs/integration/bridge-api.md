# `window.redstone` — the whole bridge

Reference. The complete surface the web app can reach from inside the desktop
shell; there is nothing else. Feature-detect with `window.redstone` and check
`window.redstone.version` (currently `'1'`) before relying on anything added
later.

`window.redstone` exists on **every** page the shell loads, including `/login` —
it means "this is the desktop app", not "the user is signed in".

---

## Folders, per conversation

| Method | Purpose |
|---|---|
| `sessionFolder(sessionId?)` | `{ sessionId, folderId, folderName, link }` for a conversation |
| `linkSessionFolder(sessionId?)` | native picker → create/reuse folder → start syncing. Returns the link, or `null` if cancelled |
| `unlinkSessionFolder(sessionId?)` | stop mirroring; offers to detach the folder. Never deletes local files |
| `onSessionChanged(cb)` | the open conversation, or its sync state, changed |

See [02-folder-control-in-chat.md](02-folder-control-in-chat.md).

## Folders, lower level

| Method | Purpose |
|---|---|
| `pickFolder()` | native directory picker; returns a path or `null` |
| `linkFolder({folderId, localPath})` | link a specific folder. The path **must** have come from `pickFolder` in this session — anything else is refused |
| `unlinkFolder(folderId)` | stop syncing one link |
| `listLinks()` | every link on this machine, with sync state |
| `pauseLink(id)` / `resumeLink(id)` / `syncNow(id?)` | control the sync engine |
| `revealInFileManager({folderId, relPath?})` | open Finder/Explorer at a folder or file |
| `onSyncStatus(cb)` | stream of `LinkStatus` as sync progresses |

```ts
type LinkStatus = {
  folderId: string;
  folderName: string;
  localPath: string;
  state: 'synced' | 'syncing' | 'paused' | 'error' | 'conflict' | 'signed_out';
  pending: number;        // files still to transfer
  conflicts: string[];    // relative paths, both copies kept
  errors: string[];       // relative paths parked after repeated failures
  lastSyncedAt: string | null;
  message?: string;
};
```

## Files and screen

| Method | Purpose |
|---|---|
| `pickFiles({multiple?, sessionId?})` | native file picker → uploaded → `AttachmentRef[]` |
| `onFilesDropped(cb)` | fires when the user drops files on the window (the shell renders the drop target) |
| `captureScreen({sessionId?})` | screenshot with a preview the user must confirm → `AttachmentRef` or `null` |

```ts
type AttachmentRef = { attachmentId: string; filename: string; sizeBytes: number };
```

**The shell never sends a message.** These return `attachmentId`s; composing,
streaming and rendering stay the web app's job (spec §6). Uploads go through
`POST /sessions/{id}/attachments/upload` — the proxied endpoint, never the
presigned one, because clients outside the server network cannot always reach the
storage host.

Limits are read at runtime from `GET /files/upload-constraints` and enforced
client-side too, so a 2 GB file is refused before the bytes go on the wire.

## Windows and activity

| Method | Purpose |
|---|---|
| `openQuickBar()` / `closeQuickBar()` | the global quick chat bar |
| `openMainWindow({sessionId?})` | focus the main window, optionally on a conversation |
| `setActiveSession(id)` | which conversation is open — where dropped files go |
| `setTurnActive({sessionId, active})` | wrap streaming; drops the folder poll from 10s to 2s |
| `info()` | `{ version, platform, appOrigin, shortcuts }` — gate features on a minimum shell version |

## What is deliberately absent

No `readFile`, no `writeFile`, no `exec`, no generic path access. The renderer
runs remote code, so every method above is a named operation the main process
validates: a `localPath` is only accepted if a native dialog produced it, and
every relative path is resolved inside its link root with `..`, absolute paths
and symlinks refused.

If a future feature seems to need a generic file API, it does not — ask for a
specific method instead.
