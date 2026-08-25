# Folder sync API

Reference for the Redstone Desktop sync engine. Companion to
[the build spec](redstone-desktop-spec.md) — that document says *what* to build,
this one is the exact contract.

**Base URL:** `https://redstone-agent.yitec.dev/api/v1`
**Auth:** `Authorization: Bearer <jwt>` on every request (see the spec, §4).
**Status:** live. Every example below is a real response from the deployed API.

---

## 1. The model

A **folder** is a durable, server-side project directory. Its bytes live in
object storage, FUSE-mounted so the agent can read and write it like a real
checkout. Your job is to mirror one folder into one local directory.

Two consequences of that storage worth knowing before you design anything:

- **`modified` is server write time, not the user's save time.** The mount
  rewrites timestamps. Never decide "changed" from mtime alone.
- **A file can be rewritten with the same length.** Size is not a change
  detector either. This is why every file carries a `hash`.

---

## 2. Endpoints

### List folders

```http
GET /folders
```

```json
{
  "mount_ready": true,
  "items": [{ "id": "…", "name": "Q3 report", "created_at": "…", "updated_at": "…" }]
}
```

**`mount_ready: false` means stop.** Object storage is not attached; writes
would land on ephemeral disk and be lost. Pause sync and show
"Folder storage unavailable" rather than uploading into a void.

### Create / rename

```http
POST  /folders            {"name": "Q3 report"}     → 201 {id, name, …}
PATCH /folders/{id}       {"name": "Q3 final"}      → 200
```

### Read the whole tree — the endpoint you will live in

```http
GET /folders/{id}/tree?cursor=<opaque>&hash=true
```

```json
{
  "cursor": "9f2b…",
  "unchanged": false,
  "truncated": false,
  "entries": [
    { "path": "notes.md",    "is_dir": false, "size": 5,  "modified": "2026-08-11T10:51:17.883021",
      "hash": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
    { "path": "src",         "is_dir": true,  "size": null, "modified": "…", "hash": null },
    { "path": "src/main.py", "is_dir": false, "size": 8,  "modified": "…", "hash": "sha256:…" }
  ]
}
```

- `path` is POSIX, relative to the folder root, and is the identity of an entry.
- `hash` is `sha256:<hex>` of the file contents; `null` for directories.
  Pass `hash=false` for a metadata-only sweep when you do not need it.
- Entries are sorted by `path`.

**Polling.** Send back the previous `cursor`. It is a signature over every
entry's path, size and mtime, so an idle folder answers:

```json
{ "cursor": "9f2b…", "unchanged": true, "truncated": false, "entries": [] }
```

That path does a walk and a `stat`, and **no hashing at all** — cheap enough for
a 10 second poll. Any create, edit, delete or rename changes the cursor and you
get the full tree back.

**Deletions are not reported, by design.** A server-side delta would mean
persisting a snapshot per folder per client. Instead the listing is complete, so
diff it against your own state: a path you hold that is absent here has been
deleted server-side.

> **`truncated: true` suspends that rule.** Above 20,000 entries the walk stops
> and the listing is partial. A partial listing must **never** be read as "those
> files were deleted". Treat it as: pull what is listed, do not propagate any
> deletion, and tell the user the folder is too large to mirror.

### Download / upload one file

```http
GET  /folders/{id}/download?path=src/main.py      → the bytes
POST /folders/{id}/files?path=src                 multipart, field "file"
```

Upload returns the written entry including a real `modified`, so you can record
what you just wrote without re-listing:

```json
{ "name": "notes.md", "is_dir": false, "size": 5, "modified": "2026-08-11T10:51:17.883021" }
```

The destination name comes from the multipart filename; `path` is the directory
it lands in (`""` for the root). Parent directories are created.

### One entry's metadata

```http
GET /folders/{id}/stat?path=src/main.py
```

Returns a single tree entry, hash included. Useful after a write, and to confirm
a conflict resolution landed.

### Create a directory

```http
POST /folders/{id}/mkdir     {"path": "src", "name": "utils"}   → 201
```

### Delete

```http
DELETE /folders/{id}/files?path=notes.md            → 204
DELETE /folders/{id}/files?path=src                 → 409 if not empty
DELETE /folders/{id}/files?path=src&recursive=true  → 204
```

A non-empty directory needs `recursive=true`. Without it you get 409 rather than
losing a subtree to a mistyped path. `path=` (empty) is rejected — deleting the
folder itself is not this endpoint's job.

### Move / rename

```http
POST /folders/{id}/move   {"from_path": "notes.md", "to_path": "docs/readme.md"}
```

Returns the destination entry. Parent directories are created. Fails 409 if the
destination exists unless you pass `"overwrite": true`. Moving a directory into
itself is rejected.

Use this for renames rather than delete-plus-upload: it is atomic server-side
and does not re-transfer the bytes.

---

## 3. Status codes

| Code | Meaning | What to do |
|---|---|---|
| 200 / 201 / 204 | Success | — |
| 401 | Token expired or missing | Pause sync, surface "sign in again". **Do not refresh it yourself** — the web app owns that. |
| 404 | Folder not yours, or path missing | A folder 404 means unlinked or deleted; stop syncing it. |
| 409 | Non-empty directory, or destination exists | Retry with `recursive` / `overwrite` only if that is what the user meant. |
| 422 | Malformed request (e.g. empty `path`) | A bug in the client; log it. |
| 503 | Storage unavailable | Back off and retry; do not treat as deletion. |

Path traversal (`../`) returns **404**, not 403 — existence outside the folder is
never confirmed. Symlinks are skipped by the tree walk entirely.

---

## 4. A sync loop that works

The API gives you the primitives; this is the ordering that stays correct.

**State to keep per file** (SQLite): `rel_path`, and as of the last *successful*
sync: `local_hash`, `remote_hash`, `local_mtime`, `local_size`.

**Each cycle**

1. `GET /tree?cursor=<last>`. If `unchanged`, only local changes can exist —
   skip to step 4.
2. If `truncated`, set a flag: this cycle may not delete anything locally.
3. Diff the listing against your state:
   - remote `hash` ≠ stored `remote_hash` → **remote changed**
   - path present remotely, absent from state → **remote created**
   - path in state, absent remotely, and not truncated → **remote deleted**
4. Diff local disk against your state the same way, hashing only files whose
   size or mtime moved.
5. Classify each path:

   | local | remote | action |
   |---|---|---|
   | unchanged | changed | download |
   | changed | unchanged | upload |
   | changed | changed | **conflict** |
   | deleted | unchanged | `DELETE /files` |
   | unchanged | deleted | delete locally |
   | deleted | changed | download (a resurrect beats a silent loss) |
   | changed | deleted | upload (same reason) |

6. Apply. Record the new hashes only after each operation *succeeds*.

**Conflicts: keep both, always.** Download the remote version alongside as
`<name> (Redstone's copy YYYY-MM-DD HHmm).<ext>`, leave the user's file at the
canonical path, upload it, and notify. Never merge, never overwrite, never
resolve silently. This rule outranks tidiness.

**Renames.** If a path disappears and another appears with the *same hash* in the
same cycle, that is a rename: issue one `POST /move` instead of a delete plus a
full upload.

**Ordering.** Create directories before the files inside them; delete children
before parents; apply downloads before uploads within a cycle so a conflict copy
exists before you overwrite anything.

---

## 5. What not to sync

The server hides agent scaffolding at the folder root. **It will not appear in
the tree even though it exists**, so never interpret its absence as a deletion,
and never upload a file with one of these names to the root:

```
session.json   workspace_context.json   .env   .gitignore   .git
__pycache__    node_modules   .venv   .claude   skills
data-workspace .memory   MEMORY.md
.skills-account   .skills-baseline.json
```

Skip locally as well: `.DS_Store`, `Thumbs.db`, `~$*` (Office lock files),
`*.tmp`, `*.crdownload`, `*.part`, symlinks, and anything over the size cap.
Support a `.redstoneignore` (gitignore syntax) at the link root.

**Limits.** 100 MB per file, 20 files per attachment batch — read them at runtime
from `GET /files/upload-constraints` rather than hardcoding. Warn before linking
a directory with more than 5,000 files; refuse above 20,000, where the tree
truncates and correct mirroring is no longer possible.

---

## 6. Binding a folder to a chat

```http
POST /sessions    {"name": "Q3 report", "folder_id": "<id>"}
```

The agent in that conversation then works inside the folder. Create the folder
and the link first, sync once, then create the session — the agent should not
open on an empty directory.

---

## 7. Known gaps

Honest list of what this API does not do yet. None blocks Phase 2; all would
make it better. Raise them if they start to hurt.

- **No resumable upload.** A dropped connection at 95 MB restarts from zero.
- **No server-side delta.** You always diff a full tree. Fine to ~20,000 entries;
  the cursor keeps the idle case cheap.
- **No change notification.** Polling only — there is no websocket telling you
  the agent just wrote a file.
- **No per-file locking.** If the agent writes while you upload, last writer
  wins; the conflict rule is what protects the user.
- **`truncated` is a hard stop, not pagination.** No `offset` yet.
