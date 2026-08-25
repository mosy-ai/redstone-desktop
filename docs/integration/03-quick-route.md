# 3. `/quick` — the route behind the quick chat bar

**Owner:** web app · **Status: the route exists** (it 307s to `/login` like any
guarded page, rather than 404ing). What it renders has not been seen from the
desktop.

---

## What it is for

A global shortcut (`⌘⇧Space` / `Ctrl+Shift+Space`) summons a small always-on-top
window from anywhere — the user types a question without switching to the app.
Spec §7.1.

The window is a thin container. Everything inside it should be your route, so
streaming, markdown, citations, Vietnamese/English copy and model routing stay
identical to the main app with no desktop release.

## What it needs to be

```
GET /quick?client=desktop
```

- A composer, a streaming answer, and an attachment chip.
- Styled for a **720×72** window that grows to about **720×420** when an answer
  arrives.
- Shares the session cookie with the main window, so no separate sign-in.
- No app chrome — no sidebar, no header. The window is the chrome.

The `client=desktop` query is there if you want to branch on it.

## How the shell decides to use it

It probes the route once per run and **requires a 2xx**. Two traps, both hit in
practice:

- The route is guarded by your middleware, which reads the **cookie** — a bearer
  header alone gets bounced. The probe now sends `rs_token` as a cookie.
- An unsatisfied guard answers **307 to `/login`**, not 404. Treating any
  non-error status as success meant rendering a login page inside a 72px-tall
  bar, which is worse than no route at all.

`hasQuickRoute` in `src/main/windows/quick-window.ts`.

## Until a 2xx comes back

The bar loads a local composer that talks to the same
`POST /sessions/{id}/messages` SSE endpoint and renders **plain text only** — no
markdown, no citations, no model picker, no history.

That is deliberate. The fallback is worse than the web app so that nobody is
tempted to grow a second chat UI inside the desktop app. When `/quick` answers
2xx, the fallback stops being reached and these can be deleted outright:

- `src/renderer/quick/*`
- `src/main/quick-chat.ts`

## Related: screen capture

The same bar carries the capture button (`⌘⇧1`). The shell takes the screenshot,
shows the user exactly what will be sent, uploads it via
`POST /sessions/{id}/attachments/upload`, and hands the `attachment_id` to
whatever composes the message. Nothing needed on your side beyond the composer
accepting an attachment chip — the backend already routes a turn carrying an
image to a vision-capable model.
