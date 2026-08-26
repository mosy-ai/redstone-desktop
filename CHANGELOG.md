# Changelog

## 0.2.2 — 26 Aug 2026

### Fixed
- **A weak connection no longer makes the window flash.** The offline screen
  retried by re-opening the main window on a fixed 15-second timer, so an
  intermittent connection produced a loop — error screen, reload, fail, error
  screen — that also raised and focused the window on top of whatever the user
  was doing. Recovery is now detected by probing the server's health endpoint on
  a backoff that grows from 2s to 60s, and the view is navigated once, after the
  server has already answered.
- **One dropped packet no longer replaces a working page with an error.** The
  first failed load is retried quietly; only the second shows the offline
  screen.

### Added
- **A connection banner in the desktop bar.** Until now a dropped connection was
  invisible until the whole view went blank. The bar names the failure —
  "No internet connection" against "Can't reach <server>" — because those need
  different reactions, and confirms when the connection is back.
- The offline screen says which failure it is, counts down to the next check,
  and comes back on its own when the network returns.

## 0.2.1 — 25 Aug 2026

Signed and notarized by Apple. 0.2.0 was ad-hoc signed, so macOS refused to open
it without a right-click override, and every launch showed the unidentified
developer warning.

### Changed
- **macOS builds are signed with a Developer ID and notarized**, app and disk
  image both. Gatekeeper now accepts the download with no warning and no
  right-click dance: `spctl` reports `source=Notarized Developer ID`.
- Signing happens *before* the app is put into the dmg and zip. Previously the
  signature was applied to the built bundle afterwards, which left the shipped
  archives containing an unsigned copy — no microphone permission for anyone but
  the person who ran the build.
- Ad-hoc signing (used when no certificate is configured) now passes the
  entitlements file, so unsigned local builds keep microphone access too.

### Fixed
- Windows and Linux installers are built in CI again. An unset signing secret
  arrives as an empty variable and electron-builder read it as a certificate
  path; the Linux icon renderer aborted on Electron's unconfigured sandbox.

## 0.2.0 — 15 Aug 2026

First release anyone else can install. 0.1.0 was never published.

### Added
- **Server picker before login.** Redstone is self-hostable and regional, so the
  first screen asks for the instance and verifies it with `GET /api/v1/health`.
  Remembers the servers you have used; `File → Switch Server…` changes it.
- **Folder sync**, both directions: local edits reach the server in ~3.5s, the
  agent's writes reach your disk in ~2s while a turn is streaming. Conflicts keep
  both copies, renames move rather than re-upload, deletions propagate, and a
  truncated listing never deletes anything.
- **Per-conversation folder links.** A folder belongs to a chat, not to the app.
- **Quick chat bar** on a global shortcut, running the web app's `/quick` route.
- **Screen capture** on a global shortcut, with a preview you confirm before
  anything is uploaded. Held for the quick bar until it has a conversation.
- **Bring Redstone to the front** (`⌘⌥R`), on the display your cursor is on.
- **Desktop settings** (`⌘,`): all three shortcuts with a recorder, launch at
  login, microphone permission and device preference, current server.
- **Drag and drop** files onto the window to attach them.
- **Voice input**: microphone allowed for audio, for Redstone's origins, once
  macOS has granted it too.
- Bridge additions for the web app: `focusWindow`, `setBadgeCount`,
  `sessionFolder`, `linkSessionFolder`, `unlinkSessionFolder`,
  `preferredMicrophone`, `resizeQuickBar`.

### Fixed
- WebSockets to Redstone's own origins were blocked, leaving the web app
  reconnecting silently.
- The window could not be dragged: a hidden title bar with no drag region.
- Notifications: the renderer was destroyed on close and throttled while hidden,
  so the event stream stopped. The window now hides, un-throttled.
- The login was lost on every quit — cookies were not flushed before exit.
- Native dialogs opened behind the window (the web app is a view, not a window),
  making the folder picker look like it did nothing.
- A global shortcut added after install came back `undefined`, because saved
  settings replaced nested defaults wholesale.
- Quitting mid-launch crashed with "globalShortcut cannot be used before the app
  is ready".
- Folders showed their raw id instead of a name.
- "Paused" no longer implies you paused it: a server-side stop says so, and
  offers no button that cannot help.

### Known gaps
- Windows and Linux builds are not published yet; they package cleanly and CI
  builds them, but nobody has run them in anger.
- Not notarized. macOS will warn unless you remove the quarantine attribute.
- Uploads are not resumable, matching the server API.
