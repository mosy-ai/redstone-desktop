# 2. The folder control in the chat

**Owner:** web app · **Status: reported done, not yet confirmed from the desktop.**
See [How to check your end](#how-to-check-your-end-is-wired) — it takes about a
minute.

---

## Why it belongs in your UI

Spec §8 has the web app feature-detect the bridge and render desktop affordances
itself. That is the right place: the control belongs beside the conversation, in
your layout, where the user is when they want it.

The desktop currently renders a fallback strip above the page. It works, but it
sits outside your layout and cannot know where your chat header ends. When your
control ships, that strip shrinks to a drag handle.

## The API

```js
const desktop = window.redstone;

if (desktop) {
  const state = await desktop.sessionFolder(sessionId);
  // → { sessionId, folderId, folderName, link }
  //
  //   folderId  — the Redstone folder this conversation works in, or null
  //   link      — the local directory mirroring it, or null if this machine
  //               has none:
  //               { localPath, folderName,
  //                 state: 'synced' | 'syncing' | 'paused' | 'error'
  //                      | 'conflict' | 'signed_out',
  //                 pending, conflicts[], errors[], lastSyncedAt }

  // The button. Native directory picker → creates or reuses the conversation's
  // folder → starts syncing. Returns null if the user cancels.
  await desktop.linkSessionFolder(sessionId);

  // Stop mirroring. Never deletes local files; asks whether to detach the
  // folder from the conversation too.
  await desktop.unlinkSessionFolder(sessionId);

  // Live updates.
  desktop.onSessionChanged((s) => render(s));   // conversation changed
  desktop.onSyncStatus((link) => render(link)); // sync state moved
}
```

**Pass `sessionId` explicitly.** Omitting it makes the shell act on the
conversation it believes is open — a guess that can race with a background
window.

## Suggested states

| `link` | Show |
|---|---|
| `null` | `📁 Link a folder` — an invitation |
| `state: 'synced'` | `● ~/Projects/q3-report — synced`, dot green |
| `state: 'syncing'` | `● ~/Projects/q3-report — syncing 3`, dot amber |
| `conflicts.length` | `● 2 conflicts — both kept`, dot red, click for detail |
| `state: 'signed_out'` | `● Sign in again` |

Wording you can copy verbatim is in `src/renderer/chrome/chrome.ts` (`summarise`).

## Two calls worth making regardless of the button

```js
desktop.setActiveSession(sessionId);                      // on open / switch
desktop.setTurnActive({ sessionId, active: true });       // before streaming
desktop.setTurnActive({ sessionId, active: false });      // after
```

- `setActiveSession` tells the shell where a **dropped file** belongs. Without
  it, dragging a PDF onto the window has nowhere to go.
- `setTurnActive` drops the folder poll from 10s to 2s while the agent is
  writing, so its file edits appear on the user's disk within seconds instead of
  up to ten.

## How to check your end is wired

Open a chat in the desktop app, then **Help → Show Logs**:

- `web app reports the active session — no longer reading it from the URL`
  → your `setActiveSession` arrived. The shell stops inferring for the rest of
  the run.
- `active session changed (url)` and nothing else → the call is not arriving and
  the shell is still reading `/chat?s=…` out of the address bar.

That fallback exists only for deployments without bridge support
(`watchAppNavigation` in `src/main/windows/main-window.ts`) and can be deleted
once every deployment calls you.

## One caveat

`window.redstone` exists on **every** page the shell loads, including `/login`.
Feature-detecting it tells you "this is the desktop app", not "the user is signed
in".
