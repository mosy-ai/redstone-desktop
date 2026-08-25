# 6. Voice input in the desktop app

**Owner:** desktop (fixed) + one optional web change · **15 Aug 2026.**

---

## What was broken, and why it was ours

Voice worked in a browser and reported "no microphone detected" in the desktop
app. Two shell-side causes, both fixed:

1. **The shell denied the permission.** Its permission handler allowed only
   clipboard and notifications, so `getUserMedia` never resolved. Nothing
   reached your code — the page asked, the shell said no.
2. **The macOS entitlement said no.** `com.apple.security.device.audio-input`
   was `false` and there was no `NSMicrophoneUsageDescription`, so even a
   permitted request would have been refused by the OS in a signed build.

Now: `media` is allowed for **audio only**, for Redstone's own origins only,
and only after macOS has granted access too — with a prompt the first time and a
link into System Settings if it was previously refused. Camera stays denied;
screen capture is still main-process only, from an explicit keystroke.

**A browser hides this difference from you.** Chrome already holds the OS
microphone grant, so a site that works there can still fail in an Electron app
that has not asked for it. Worth remembering for anything else that touches
hardware.

## The optional web change: device selection

Desktop settings now list the available inputs and let the user pick a preferred
one. The shell **cannot enforce that choice** — the page calls `getUserMedia`,
so the constraint has to come from you:

```js
const desktop = window.redstone;
const deviceId = desktop ? await desktop.preferredMicrophone() : '';

const stream = await navigator.mediaDevices.getUserMedia({
  audio: deviceId ? { deviceId: { exact: deviceId } } : true,
});
```

`preferredMicrophone()` returns `''` when the user has not chosen one, which
means "use the system default" — so the code above is correct with or without a
choice, and in a browser `desktop` is undefined and it degrades to `audio: true`.

If you would rather not special-case it, skip this: voice works without it and
follows the macOS default input, which the settings window links to.

## Worth knowing

- Device **labels** are empty until the microphone has been granted once. That is
  a Chromium privacy rule, not a bug — the settings window shows "Microphone"
  until the first grant, then real names.
- If a user says voice is dead, the shell's log now distinguishes the two
  failures: `microphone request allowed`, `microphone request blocked by macOS`,
  or `denied media request` with the origin and requested media types.
