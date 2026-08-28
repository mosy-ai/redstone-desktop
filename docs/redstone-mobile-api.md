# Redstone Mobile — server API spec

Contract for the **Redstone Mobile app** (Android + iOS) and the endpoints the
**agent server** must build for it. Companion to
[the folder-sync API](folder-sync-api.md) and
[the desktop build spec](redstone-desktop-spec.md): those cover the desktop
shell; this one covers the phone.

**Audience:** the agent-server team. Everything below marked *(new)* is work for
you. Everything marked *(existing)* the mobile app already gets to reuse as-is.

**Base URL:** `https://redstone-agent.yitec.dev/api/v1` — but never hardcode it.
Redstone is self-hostable and regional; the instance is something the user
types on first run and we probe with the existing unauthenticated
`GET /api/v1/health` (`{"status":"healthy","service":"Redstone Agent"}`) before
trusting it.

**Auth:** `Authorization: Bearer <jwt>` on every authenticated call — same token
scheme as the rest of the API (§2).

**Status of this document:** proposal. None of the *(new)* endpoints exist yet.
The shapes below are what the mobile app will send and expect; treat the field
names and status codes as the thing to agree on, not as already-deployed truth.

---

## 1. What the mobile app is, and why the server needs new endpoints

The app is the **Redstone web app in a WebView**, plus the things a mobile
browser cannot do — exactly the desktop shell's philosophy ([desktop spec §1](redstone-desktop-spec.md)),
moved to the phone. Composing, streaming and rendering a conversation stay the
web app's job. The native layer adds four capture channels the browser has no
access to:

| Channel | What it captures | Why it can't be done any other way |
|---|---|---|
| **Notifications** | Every OS notification the user lets us read | The headline. Messenger, Viber, WhatsApp, Zalo, bank apps — none expose an API for a third party to read a user's messages. The notification shade is the only place that content surfaces on-device. |
| **Messages (SMS/MMS)** | Native texts and short-code messages | OTPs, delivery updates, appointment reminders — content the assistant needs to be useful, unreachable from a browser. |
| **Contacts** | The address book | So the agent can resolve "message from Mom" to a person, and act on "text my dentist" without the user copy-pasting numbers. |
| **Camera** | A photo taken in the moment | A live capture into the current chat, instead of only picking an existing file. |

The point of all four is the same: **the agent is an assistant, and an assistant
that cannot see the user's incoming messages, contacts and context is guessing.**
The user grants access per channel; the app streams what it captures to the
server so the agent can summarise it, surface it, and act on it — without the
user switching apps and copy-pasting.

The server side of that is a set of **ingestion endpoints** (device → server)
plus **push delivery** (server → device) and a **consent ledger** so we only
ever hold what the user actually agreed to.

```
┌─────────────────────────── phone ───────────────────────────┐
│  WebView: Redstone web app  ──────────────►  existing API    │
│                                              (sessions,       │
│                                               attachments,    │
│                                               folders)        │
│                                                               │
│  Native capture services                                      │
│   • NotificationListenerService (Android) / push+share (iOS)  │
│   • SMS reader (Android only)                                 │
│   • Contacts                                                  │
│   • Camera                                                    │
│        │                                                      │
│        └── batched, idempotent ──►  NEW ingestion endpoints   │
│                                     §5 §6 §7 §8               │
│                                                               │
│  FCM / APNs  ◄── push ──  NEW device-push endpoints  §4      │
└───────────────────────────────────────────────────────────────┘
```

### Platform reality — read before designing the ingestion side

The server should not assume the two platforms feed it the same thing:

- **Android** can host a `NotificationListenerService` and (with the SMS
  permission and, for a Play-Store build, an approved use-case) read SMS. This
  is where the rich capture happens.
- **iOS has no equivalent.** There is no public API to read other apps'
  notifications or SMS. On iOS the realistic capture is: the app's **own** push
  notifications, content the user explicitly **shares** into the app via the
  share sheet, and camera/contacts with permission. Design every ingestion
  endpoint so a mostly-empty iOS feed is normal, not an error.

So: the endpoints are cross-platform, but the **volume and completeness are
Android-first**. Every ingested record carries the `platform` and the capture
`source` so the agent can weight it.

---

## 2. Conventions

Consistent with the existing API ([folder-sync-api.md](folder-sync-api.md),
[desktop spec §4](redstone-desktop-spec.md)):

- **JSON**, `snake_case` fields. Request and response bodies both.
- **Timestamps** are ISO-8601. The existing API emits naive server-local strings
  (`2026-08-11T10:51:17.883021`); the phone knows its own clock and timezone, so
  **device-originated timestamps must be UTC with an explicit offset**
  (`2026-08-27T09:14:03.221+07:00`). Keep the device value verbatim; do not
  rewrite it to server-receipt time — receipt lag is real on a phone that was
  offline. Store server-receipt time separately if you need it.
- **Auth:** `Authorization: Bearer <jwt>`. Access tokens last 24 h, refresh
  tokens 7 days (desktop spec §4). On `401`, the app stops and re-authenticates
  (§3); it never tries to refresh a dead token itself.
- **Errors** are a JSON envelope:
  ```json
  { "error": { "code": "consent_revoked", "message": "…", "detail": {} } }
  ```
  A request that dies at a proxy comes back as HTML instead (Cloudflare 5xx); the
  client already distinguishes that from a real API error and you should assume
  it will surface "a gateway error", not your `message`. Keep real error bodies
  small and specific.
- **Retryable:** transport failure, `408`, `429`, `5xx`. The app retries these
  with backoff. `4xx` (other than 408/429) are permanent; the app drops the
  batch and, for a `422`, logs which records the server rejected.
- **Idempotency.** Capture is at-least-once — the phone re-sends after a crash,
  a network drop, a token refresh. Every ingested record carries a stable,
  client-generated `client_id` (§6.1), and every batch POST accepts an
  `Idempotency-Key` header. **The server must dedupe on `client_id`**; a
  re-POST of the same records returns `200` with per-record `status: "duplicate"`
  rather than storing twice.
- **Batching.** Capture is bursty (a group chat lights up). The app buffers and
  POSTs arrays, not one record per request. Limits in §9.
- **Cursors.** Where the app needs to know "what does the server already have"
  (contacts reconciliation, resend-after-reinstall), endpoints follow the same
  opaque-`cursor` model as `/folders/{id}/tree`.

---

## 3. Authentication on a phone *(new — one decision to make)*

The desktop shell reads the `rs_token` cookie out of the shared WebView
partition and reuses it for its own API calls. The mobile app can do the same —
the WebView that hosts the web app holds the cookie, and the native layer can
read it from the platform cookie store for the app origin.

That works, but a background capture service that fires while the app is swiped
away needs a token **without** a live WebView, and a 24 h access token is not
enough for a service that must keep ingesting for days. So the recommendation:

**Recommended: a device-bound token exchange.** After the user logs in through
the normal web form in the WebView, the app calls a new endpoint **once** to
trade the session for a long-lived, device-scoped refresh token that the
background services use:

```http
POST /api/v1/mobile/auth/device-token
Authorization: Bearer <rs_token from the WebView session>
```
```json
{
  "device": {
    "platform": "android",
    "app_version": "1.0.0",
    "os_version": "14",
    "model": "Pixel 8",
    "device_id": "b8c1…"          // app-generated, stable per install, not a hardware id
  }
}
```
→ `201`
```json
{
  "device_id": "b8c1…",
  "access_token": "…",             // short-lived, 24h, for ingestion calls
  "refresh_token": "…",            // device-scoped, revocable server-side, long-lived
  "expires_in": 86400
}
```

- The refresh token is **scoped to this device and to the ingestion + push
  surface only** — not a full web session. If the phone is lost, the user
  revokes that one device (§10) without signing out everywhere.
- Refresh with `POST /api/v1/mobile/auth/refresh { "refresh_token": "…" }` →
  new access token. On refresh failure (revoked / expired), the app drops back
  to the WebView login.
- The WebView keeps using `rs_token` for the web app itself, unchanged.

**Fallback if you'd rather not build the exchange:** the app reuses the WebView
`rs_token` for ingestion too, and background services simply don't run while the
token is expired and no WebView is alive to refresh it. Simpler server, worse
capture reliability. **This is the one open auth question — see §11.**

Either way, every authenticated ingestion call also carries the device:

```
X-Redstone-Device: b8c1…
```
so the server can attribute records, apply per-device consent (§4), and let the
user see and revoke a device.

---

## 4. Device registration, capabilities & push *(new)*

### 4.1 Register / update a device

Called after the token exchange and whenever a capability or push token changes.
Idempotent on `device_id`.

```http
PUT /api/v1/mobile/devices/{device_id}
```
```json
{
  "platform": "android",
  "app_version": "1.0.0",
  "os_version": "14",
  "model": "Pixel 8",
  "push": { "provider": "fcm", "token": "e7Rp…" },
  "capabilities": {
    "notifications": "granted",
    "sms":           "granted",
    "contacts":      "denied",
    "camera":        "granted",
    "background":    "granted"
  }
}
```
→ `200 { "device_id": "…", "registered_at": "…" }`

- `capabilities` values: `granted` | `denied` | `unavailable` (platform can't
  offer it, e.g. `sms: "unavailable"` on iOS) | `revoked`.
- **This is not the consent ledger** (§10) — it's the current OS-permission
  snapshot, which the server mirrors so the agent knows what it can expect to
  see. The consent ledger is the auditable, timestamped record.
- `push.provider` is `fcm` (Android) or `apns` (iOS). `push.token` is the
  FCM/APNs registration token; it rotates, so expect frequent `PUT`s that change
  only this field.

### 4.2 Server → device push

So the agent can proactively reach the user — "your build finished", "reply
drafted", "I summarised the 40 messages you missed". The server sends through
FCM/APNs using the stored `push.token`; there is no new client endpoint for
this, but the server needs:

- **A send path** keyed on `device_id` → look up `push.token` + provider.
- **Token-rotation handling:** FCM/APNs report stale tokens on send; drop them
  and wait for the app's next `PUT` to supply a fresh one.
- **Payload contract** (what the app knows how to open):
  ```json
  {
    "type": "agent_message" | "summary" | "action_required" | "system",
    "session_id": "…",          // deep-link target; app opens this chat in the WebView
    "title": "…",
    "body": "…",
    "collapse_key": "…"         // so a burst collapses to one row
  }
  ```
- Respect quiet hours / the user's notification consent; a user who granted
  ingestion did not necessarily ask to be pushed at.

---

## 5. Notification ingestion — the headline *(new)*

The reason the app exists. On Android a `NotificationListenerService` sees every
posted notification; the app filters to what the user opted into (per-app
allowlist, §5.3) and streams them here. The agent treats these as **captured
messages from apps that have no API** — Messenger, Viber, WhatsApp, Telegram,
Zalo, bank and delivery apps.

### 5.1 Post a batch

```http
POST /api/v1/mobile/notifications
X-Redstone-Device: b8c1…
Idempotency-Key: 5f3c…
```
```json
{
  "events": [
    {
      "client_id": "and-1f9c0a3e",                 // stable per event, see §6.1
      "posted_at": "2026-08-27T09:14:03.221+07:00",
      "source": "notification_listener",
      "app": {
        "package": "com.facebook.orca",
        "label": "Messenger"
      },
      "category": "msg",                            // Android channel/category if known
      "title": "Mom",
      "text": "Are you coming for dinner?",
      "subtext": null,
      "conversation_key": "com.facebook.orca:thread:8891",  // groups a thread, if the OS gives one
      "is_group": false,
      "actions": ["Reply", "Mark as read"],         // action labels the notification offered
      "contact_hint": "Mom",                        // name as shown, for contact resolution
      "priority": "default"
    }
  ]
}
```
→ `202 Accepted`
```json
{
  "received": 1,
  "results": [
    { "client_id": "and-1f9c0a3e", "status": "stored" }     // or "duplicate" | "rejected"
  ]
}
```

### 5.2 What the server does with them

- **Dedupe** on `client_id`. The listener re-fires on update (a message edited,
  a group notification re-ranked); the app assigns a new `client_id` only for a
  genuinely new event, so `duplicate` means "already have it".
- **Thread them.** `conversation_key` (when present) is a stable per-thread
  handle — group consecutive events into a conversation the agent can summarise.
  When absent, fall back to `app.package` + `title`.
- **Resolve `contact_hint`** against synced contacts (§7) so "Mom" becomes a
  person the agent can act on.
- **Retention & indexing are yours to design**, but see §10 — this is the most
  sensitive data in the whole product. Store only what consent covers; make it
  deletable per-app and per-time-range.

### 5.3 What the app filters *before* sending

The server should still defend against all of it, but by contract the app:

- sends **only apps on the user's allowlist** (default: nothing; the user picks
  which apps to share, e.g. only Messenger + Viber);
- **drops its own** notifications and Redstone's, to avoid loops;
- redacts nothing by default (the agent needs the text) but honours a per-app
  "titles only, no body" setting, which arrives as `text: null`.

### 5.4 iOS

No listener. On iOS this endpoint receives only what the user **shares** into
the app (`source: "share_sheet"`) and the app's own pushes. Same shape,
`source` differs, volume is low. Do not treat an iOS device that posts nothing
here as broken.

---

## 6. Idempotency & ordering details

### 6.1 `client_id`

A stable string the app generates per record, unique within the device. Format
is opaque to the server — treat it as a dedupe key, not a parseable value. The
app guarantees the **same logical event → same `client_id`** across retries and
process restarts (it's persisted in the on-device outbox before the first send
attempt). The pair `(device_id, client_id)` is globally unique.

### 6.2 Ordering

Batches can arrive out of order (a retried older batch lands after a newer one).
The server orders by `posted_at`, not receipt order. The app does **not**
guarantee gap-free sequencing — a permission granted at noon means there is no
history before noon, and that is expected, not a lost batch.

---

## 7. Messages (SMS / MMS) ingestion *(new)*

Android only (`sms: "unavailable"` on iOS). Same batching, dedupe and timestamp
rules as notifications.

```http
POST /api/v1/mobile/messages
```
```json
{
  "messages": [
    {
      "client_id": "sms-4402",
      "sent_at": "2026-08-27T08:02:11.000+07:00",
      "direction": "inbound",                 // inbound | outbound
      "type": "sms",                          // sms | mms
      "address": "+84901234567",              // sender for inbound, recipient for outbound
      "contact_hint": "Dentist",
      "body": "Your appointment is confirmed for Fri 3pm.",
      "thread_key": "+84901234567",
      "attachments": [                         // mms only
        { "client_id": "mms-4402-1", "mime": "image/jpeg", "size": 84213 }
      ]
    }
  ]
}
```
→ `202`, same `results` shape as §5.1.

- **MMS binary parts** are not inline. The app uploads each part as an
  attachment (§8 mechanics) and references it by `client_id`; the server links
  them. Keeps this endpoint a small JSON POST.
- `address` normalisation (E.164) is best-effort on the device; the server
  should not assume it is always E.164 (short codes, alphanumeric senders).
- Consent for SMS is separate from notifications in the ledger (§10) — a user
  may share Messenger notifications but not their bank's SMS OTPs.

---

## 8. Contacts sync *(new)*

So the agent can turn a `contact_hint` into a person, and act on "text my
landlord" without the user pasting a number. This is a **reconciled sync**, not
an append stream — the address book changes in place.

### 8.1 Push a snapshot / delta

```http
POST /api/v1/mobile/contacts/sync
```
```json
{
  "cursor": "0d7a…",                 // last cursor the server returned, or null for a full sync
  "upserts": [
    {
      "client_id": "c-338",          // stable per contact per device
      "display_name": "Mom",
      "phones": [ { "value": "+84900000000", "type": "mobile" } ],
      "emails": [ { "value": "mom@example.com", "type": "home" } ],
      "org": null,
      "updated_at": "2026-08-20T12:00:00.000+07:00"
    }
  ],
  "deletes": [ "c-201" ]             // client_ids removed from the address book
}
```
→ `200`
```json
{ "cursor": "9b12…", "upserted": 1, "deleted": 1 }
```

- **Full vs delta:** `cursor: null` means the app is sending the whole book
  (first sync, or after a reinstall); the server replaces its view for this
  device. A non-null `cursor` means "these are the changes since that cursor".
- **The book belongs to the device.** Scope stored contacts by `device_id`; do
  not merge two phones' address books into one identity graph unless the product
  later asks for it.
- **Deletion propagates.** A contact the user removes on the phone must be
  removable server-side — send it in `deletes`, and honour §10 bulk deletion.

---

## 9. Camera capture → attachment *(existing endpoint, reused)*

No new endpoint. A photo taken with the in-app camera pop-up is just a file
attached to the current conversation, so it uses the **existing proxied
attachment upload** the desktop shell already uses ([desktop spec §6](redstone-desktop-spec.md)):

```http
POST /api/v1/sessions/{session_id}/attachments/upload
  multipart/form-data, field "file"
  → { attachment_id, file_id, filename }
```

- Use the **proxied** endpoint, never the presigned-URL variant — a phone on a
  cellular network is exactly the "outside the server network" case that breaks
  presigned storage hosts (desktop spec §6). This has bitten the desktop app.
- The web app in the WebView sends the message; the native layer only uploads
  and hands back the `attachment_id`. **Do not send the message from native
  code** — same rule as desktop.
- Limits come from `GET /api/v1/files/upload-constraints` at runtime (currently
  100 MB/file, 20 files/batch). Downscale photos on-device before upload.
- **Known infra caveat:** large uploads through Cloudflare have hit `524`
  timeouts ([followup 2026-08-27](integration/followups/2026-08-27-01-background-animation.md) §2).
  On a phone this is more likely, not less. Either the origin upload timeout
  needs raising for `POST /attachments/upload`, or mobile uploads need a
  resumable path. **Flagged in §11.**

---

## 10. Consent, privacy, retention & deletion *(new — non-negotiable)*

This app reads a person's private messages and contacts. The server is the
system of record for **what the user agreed to**, and must be able to prove it
and undo it.

### 10.1 Consent ledger

Every capability the user grants or revokes is written to an auditable ledger,
separate from the OS-permission snapshot in §4.1:

```http
POST /api/v1/mobile/consent
```
```json
{
  "device_id": "b8c1…",
  "grants": [
    { "scope": "notifications", "state": "granted", "at": "2026-08-27T09:00:00+07:00",
      "detail": { "apps": ["com.facebook.orca", "com.viber.voip"] } },
    { "scope": "sms",      "state": "granted", "at": "…" },
    { "scope": "contacts", "state": "revoked", "at": "…" }
  ]
}
```
→ `200`, current effective consent echoed back.

- **Scopes:** `notifications`, `sms`, `contacts`, `camera`, `background`,
  `push`. Notifications additionally carry the per-app allowlist in `detail`.
- **The server must refuse ingestion that outruns consent.** A
  `POST /mobile/notifications` for an app not in the granted allowlist, or any
  SMS after `sms` was revoked, returns `403 { error.code: "consent_revoked" }`
  and stores nothing. The app enforces this too, but the server is the backstop.
- Consent is **per device**. Revoking on one phone does not touch another.

### 10.2 Retention & deletion

- **Read the retention policy at runtime**, don't hardcode it — same pattern as
  upload constraints:
  ```http
  GET /api/v1/mobile/policy
  → { "notification_retention_days": 90, "sms_retention_days": 90,
      "titles_only_default": false, "max_batch": 500, "max_body_bytes": 16384 }
  ```
- **Bulk deletion, honoured server-side:**
  ```http
  DELETE /api/v1/mobile/data?scope=notifications&app=com.facebook.orca
  DELETE /api/v1/mobile/data?scope=all&device_id=b8c1…
  DELETE /api/v1/mobile/data?scope=messages&before=2026-01-01
  ```
  Revoking a scope in the app offers "also delete what you already captured" and
  fires this. A device the user removes (§4) triggers `scope=all` for that
  device.
- **Never log message or contact bodies.** The desktop logger already redacts
  token, path and content ([desktop layout](../README.md)); the ingestion
  handlers must do the same — no notification text, SMS body or phone number in
  a server log or crash report.

---

## 11. Sizing, rate limits & open questions

**Sizing** (proposed; final values live behind `GET /mobile/policy`):

| Limit | Proposed | Why |
|---|---|---|
| Records per batch | 500 | A busy group chat backlog after time offline. |
| Batch body | 5 MB | JSON only; binaries go through §9. |
| Body text per record | 16 KB | A notification is short; cap runaway payloads. |
| Ingestion rate | ~10 batches/min/device, `429` above | Bursty but not abusive; backoff is defined. |
| Contacts per full sync | 50 000 | Large address books exist; page above this. |

**Open questions — decisions the agent team owns:**

1. **Auth model (§3):** build the device-token exchange, or reuse the WebView
   `rs_token` and accept weaker background reliability? *Recommendation: build
   the exchange.*
2. **Upload path (§9):** raise the origin timeout for `POST /attachments/upload`,
   or add a resumable/chunked upload for mobile? The `524` is already biting
   desktop.
3. **Threading model (§5.2):** is `conversation_key` enough to group captured
   notifications, or does the agent want the server to build a unified
   per-contact inbox across notifications + SMS?
4. **Push scope (§4.2):** which agent events are allowed to push to the phone,
   and who owns quiet-hours policy — server or app?
5. **Store-policy gate:** Google Play restricts the SMS and notification-access
   permissions to approved use-cases; iOS has no notification-read API at all.
   Does distribution assume Play-Store review, sideload, or MDM? This bounds
   what §5/§7 can ever receive and should be settled before build.

---

## 12. Endpoint summary

| Method & path | Purpose | Status |
|---|---|---|
| `GET /api/v1/health` | Instance probe | existing |
| `POST /api/v1/mobile/auth/device-token` | Trade web session for device token | new |
| `POST /api/v1/mobile/auth/refresh` | Refresh device access token | new |
| `PUT /api/v1/mobile/devices/{id}` | Register/update device, push token, capabilities | new |
| `POST /api/v1/mobile/notifications` | Ingest captured notifications (batch) | new |
| `POST /api/v1/mobile/messages` | Ingest SMS/MMS (batch) | new |
| `POST /api/v1/mobile/contacts/sync` | Reconciled contacts sync | new |
| `POST /api/v1/mobile/consent` | Write consent grants/revocations | new |
| `GET  /api/v1/mobile/policy` | Retention limits & batch sizing | new |
| `DELETE /api/v1/mobile/data` | Bulk delete captured data by scope | new |
| `POST /api/v1/sessions/{id}/attachments/upload` | Camera photo → attachment | existing |
| `GET /api/v1/files/upload-constraints` | Upload size/count limits | existing |
| _(server → device)_ FCM / APNs | Agent-initiated push | new (send path) |

---

*Draft for review. The `mobile/*` surface is a proposal — names, status codes
and the auth decision in §3/§11 are what to agree on before implementation.*
