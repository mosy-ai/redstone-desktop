# Desktop ⇄ web app integration

What the Redstone desktop shell needs from the web and backend teams. One
document per piece of work — each is self-contained, so you can hand out a
single file without the others.

**Status, verified against `redstone-agent.yitec.dev` on 12 Aug 2026:**

| # | Work | Owner | Status |
|---|---|---|---|
| [1](01-bind-folder-to-session.md) | Bind a folder to an existing conversation | backend | **done** — both routes live, verified from the desktop |
| [2](02-folder-control-in-chat.md) | Folder control in the chat, `setActiveSession`, `setTurnActive` | web app | **reported done, not yet confirmed here** |
| [3](03-quick-route.md) | `/quick` route for the quick chat bar | web app | **route exists** — contents unconfirmed |

| [4](04-desktop-affordances-in-web-ui.md) | Desktop-only controls in the composer | web app | **done** — attach, capture and folder all shipped |
| [5](05-separate-local-folder-button.md) | Separate button + icon for "folder on this computer" | web app | **requested** 14 Aug |

| [6](06-voice-input.md) | Voice input: shell fix + optional device selection | desktop + web | **fixed**; web part optional |

Reference, not work items:

- [bridge-api.md](bridge-api.md) — every method on `window.redstone`
- [shell-behaviour.md](shell-behaviour.md) — how the desktop shell differs from a
  browser: blocked origins, the server picker, what "signed in" means

Nothing here blocks the desktop app shipping. Where a piece is missing, the shell
falls back to something deliberately worse and says so in the code.

---

## How the pieces fit

A folder link is per conversation, and it takes both sides to hold:

```
chat session ──(you: session.folder_id)──> Redstone folder
                                                 │  (desktop: links.json)
                                                 ▼
                                       ~/Projects/q3-report
```

The server owns which folder a conversation works in (#1). The desktop owns the
mapping from that folder to a directory on the user's machine. The button that
starts it belongs in your chat UI (#2), because that is where the user is when
they want it.

The desktop never sends a message, never renders chat, and never reimplements
anything the web app already does. It contributes exactly what a browser cannot:
the local filesystem, the screen, and a window that outlives a tab.
