# 4. Desktop affordances belong in your UI

**Owner:** web app · **Status: requested, 14 Aug 2026.**

Three controls that only work in the desktop app, and that the desktop cannot put
in a sensible place. They belong in your layout, beside what they act on.

The desktop has removed its own versions. Until you ship these, the only routes
to them are native menu items (`⌘O`, `⇧⌘A`) and a global shortcut (`⌘⇧1`) — which
is discoverable by nobody.

---

## How to tell you are in the desktop app

```js
const desktop = window.redstone;            // present ⇒ desktop shell
if (desktop && desktop.version === '1') { … }
```

Present on **every** page the shell loads, including `/login`. It means "this is
the desktop app", not "the user is signed in". `desktop.info()` gives
`{ version, platform, appOrigin, shortcuts }` if you want to gate on a minimum
shell version or show the real accelerator in a tooltip.

Everything below should render **only** when that object exists. In a browser
these controls cannot work at all — there is no filesystem and no screen access.

---

## 4.1 Link a folder from this Mac — including on a new chat

This is the one the user asked for by name.

**In a conversation** (`/chat?s=…`) you already have the control, and it works.
Nothing to change.

**On a new chat** (`/chat`, no session yet) your picker offers existing Redstone
folders. There is no way to choose a directory on the user's own machine, and
that is the case they hit first — they open the app, start a chat, and want to
point it at a project on disk.

```js
// No conversation yet: the folder brings one with it. The shell opens a native
// directory picker, creates the Redstone folder, creates a conversation bound to
// it, syncs the directory up, and navigates the window to that chat.
const link = await desktop.openFolder();
// → LinkStatus | null   (null when the user cancels the picker)
```

Verified end to end against the live server: picker → folder created → session
created and bound → files uploaded, including a nested subdirectory.

Suggested shape: in the composer's folder menu, alongside the existing Redstone
folders, one extra entry — **"Choose a folder on this Mac…"** — shown only when
`window.redstone` exists.

The same menu in an open conversation should keep calling
`desktop.linkSessionFolder(sessionId)`, which binds to *that* conversation rather
than creating a new one.

## 4.2 Attach files from this Mac

Your paperclip uploads through the browser's file input, which works. The
desktop's version differs in one way that matters: it hands back
`attachment_id`s the shell has already uploaded through
`POST /sessions/{id}/attachments/upload`, so a 90 MB file does not go through the
renderer.

```js
const refs = await desktop.pickFiles({ multiple: true, sessionId });
// → [{ attachmentId, filename, sizeBytes }]
```

Optional. Worth it if large attachments are common; skip it otherwise.

**Not optional:** subscribe to dropped files, because the shell renders the
drop target over your page and the user can drop anywhere in the window.

```js
desktop.onFilesDropped((refs) => addAttachmentChips(refs));
```

Without that subscription the file uploads and the user sees nothing.

## 4.3 Screen capture

There is no browser equivalent, so nothing of yours is being replaced.

```js
const ref = await desktop.captureScreen({ sessionId });
// → { attachmentId, filename, sizeBytes } | null  (null if cancelled)
```

The shell picks the screen or window, shows the user exactly what will be sent,
uploads it, and returns the attachment. It also fires `onFilesDropped` with the
same ref, so if you have 4.2 wired the chip appears with no extra work.

A camera button in the composer, desktop-only. The global shortcut `⌘⇧1` already
does this without any UI, but nobody finds a shortcut they were not told about.

---

## What the desktop keeps

A 44px strip above your page, holding only what a web page cannot do for itself:

- **a drag region** — a frameless window is movable only where the page says so,
  and your page has no reason to know it is inside one;
- **a sync status pill**, shown only when a folder is actually syncing. Folder
  sync outlives any single conversation, so it has no home inside one. Clicking
  it opens the shell's own status window;
- **reload**, for a wedged page.

No actions. If you ever see a button appear there again, it is a regression — the
desktop's UI test asserts they stay gone.

---

## The full bridge

[bridge-api.md](bridge-api.md) lists every method. The four above are the ones
with no browser equivalent; everything else is either already wired
([02](02-folder-control-in-chat.md)) or optional.
