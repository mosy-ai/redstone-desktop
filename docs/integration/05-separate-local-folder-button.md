# 5. "Folder on this computer" wants its own button and icon

**Owner:** web app · **Status: requested, 14 Aug 2026.**
Refines what shipped for [04](04-desktop-affordances-in-web-ui.md) — which works;
this is about where it lives.

---

## What shipped, and what is right about it

The composer now has **Attach**, **Capture the screen**, **Chat with specific
knowledge**, **Folder** and Send. Clicking **Folder** opens *Work in a folder*:

```
Work in a folder
  ○ No folder (fresh workspace)          ← selected
  ○ Choose a folder on this computer     ← "Starts a chat bound to it and keeps the two in step"
  [ Folder name… ] [ New folder ]
```

Verified from the desktop app: clicking that second entry calls
`redstone:open-folder-flow`, which is the correct bridge call. The wiring is
done, the copy is good, and screen capture and attach both landed.

## The change

**Give "a folder on this computer" its own button in the composer, with its own
icon.** Take it out of the *Work in a folder* modal.

## Why it is worth a separate control

They look like one feature and are two.

|  | Work in a folder | Folder on this computer |
|---|---|---|
| What it picks | a folder that already exists on the server | a directory on the user's own machine |
| What it does | points the chat at it | **starts a two-way mirror** — files begin moving in both directions, and the agent's writes land on their disk |
| Where it works | browser and desktop | desktop only |
| Undo | rebind the chat | stop syncing; files stay on both sides |

Three consequences of merging them:

1. **It is two clicks deep behind a control that reads as "server folder".** The
   user who wants this is the user who just installed a desktop app to connect
   their own files, and they are the least likely to go looking inside a modal
   about workspaces. This came up as "how do I select a folder from my computer?"
   from someone who had the button on screen.
2. **A desktop-only capability sits in a list that is mostly not desktop-only.**
   In a browser that entry has to be hidden, leaving a gap in a radio group —
   the shape of the menu changes depending on where you run it.
3. **The two icons are nearly the same.** Both currently read as "folder", so the
   list is carrying all of the meaning.

## What to build

A second button in the composer, beside the existing Folder one, rendered **only
when `window.redstone` exists**. It opens the OS picker directly — no
intermediate modal, since the native dialog *is* the picker:

```js
const desktop = window.redstone;

// New chat, no session yet: the folder brings the conversation with it.
const link = await desktop.openFolder();

// Inside an existing conversation: bind to that one instead.
const link = await desktop.linkSessionFolder(sessionId);

// → LinkStatus | null   (null when the user cancels)
```

**Label / tooltip**, platform-aware — `desktop.platform` is `'darwin'`,
`'win32'` or `'linux'`:

> Link a folder on this Mac · Link a folder on this PC · Link a folder on this computer

**Icon.** A laptop, not another folder — a different silhouette is what makes it
distinguishable at composer size:

```svg
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
     stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V14H4z"/>
  <path d="M2.5 17.5h19"/>
</svg>
```

Rendered at 18, 24 and 48px against your composer background before proposing it.
Two alternatives were tried and rejected: a laptop with a folder on its screen
(the folder turns to mush at 18px) and a folder with sync arrows (the arrows
collapse into a blob, and it still reads as "folder", which is the confusion
being removed).

**Once linked**, the button is the place to show it — the local path and a state
dot, from `desktop.sessionFolder(sessionId)`:

```
🖥  ~/Projects/q3-report · synced
```

`onSyncStatus` and `onSessionChanged` push updates; the states are `synced`,
`syncing`, `paused`, `error`, `conflict`, `signed_out`.

## What stays as it is

*Work in a folder* keeps doing its job — pick an existing folder, create a new
one, or none — minus the "on this computer" entry. That control is right, it
works in a browser, and nothing about it needs to change.
