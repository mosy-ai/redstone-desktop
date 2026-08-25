# 1. Bind a folder to an existing conversation

**Owner:** backend · **Status: done** — verified from the desktop, 12 Aug 2026.

---

## Why the desktop needs it

A folder link belongs to a conversation, not to the app. The user opens a chat,
points it at a directory on their machine, and the agent works in those files.
That takes both halves:

```
chat session ──(server: session.folder_id)──> Redstone folder
                                                    │  (desktop: links.json)
                                                    ▼
                                          ~/Projects/q3-report
```

The server owns the first arrow. Creating the binding at session-creation time
(`POST /sessions {name, folder_id}`) was not enough, because the moment a user
wants a folder is when they are already in a conversation.

## What the desktop calls

```http
PATCH /sessions/{session_id}          {"folder_id": "<id>"}    ← tried first
PUT   /sessions/{session_id}/folder   {"folder_id": "<id>"}    ← fallback
PATCH /sessions/{session_id}          {"folder_id": null}      ← unbind
```

Both are live. Probed unauthenticated from the desktop, both return `401` —
routing happened, auth rejected — where a nonsense path under the same prefix
returns `404`, which is how we know the `401` means the route exists:

```
PATCH /api/v1/sessions/{id}             → 401   ✓
PUT   /api/v1/sessions/{id}/folder      → 401   ✓
PATCH /api/v1/sessions/{id}/nonexistent → 404   ← control
```

Also relied on:

```http
GET /sessions/{session_id}    → { …, "folder_id": "<id>" | null }
```

The desktop asks this before offering to link, so a conversation that already has
a folder gets *mirrored* rather than given a second one — otherwise the agent
would be looking at different files than the user.

## Two things to keep

**Return the binding in the response body.** The desktop verifies the returned
`folder_id` rather than trusting a `200`. That is not distrust of the endpoint —
it is what caught the repository's update whitelist silently dropping the field,
which would have left the agent working inside the folder while every response
reported it unbound. The whitelist now raises on a field it cannot write; please
keep both behaviours.

**`PATCH` must apply only the fields sent.** An absent `folder_id` leaves the
binding alone (so a rename does not detach a folder); an explicit `null` unbinds.
The desktop's "stop syncing and detach the folder" action depends on that
distinction.

## What the desktop does with it

- **Link:** create or reuse the conversation's folder, bind it, start syncing the
  local directory.
- **Unlink:** stops the local mirror. Offers to detach the folder too, which
  sends the explicit `null`. Local files are never deleted, and neither are the
  files in Redstone.

Implementation: `bindFolderToSession` / `unbindFolderFromSession` in
`src/main/api/client.ts`, driven from `src/main/session-folder.ts`.
