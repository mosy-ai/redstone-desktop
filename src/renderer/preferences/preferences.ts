/**
 * Desktop settings — the handful of things that belong to the app rather than to
 * the account. Account settings stay in the web app; the footer link goes there.
 *
 * The shortcut fields are recorders: click one, press the combination, and the
 * main process tries to claim it globally. A combination another app already
 * owns cannot be claimed, and that has to be visible here — the alternative is a
 * key that silently does nothing, which is how the user finds out it failed.
 */
import type { Settings, ShellInfo } from '../../shared/types';

const shell = window.redstoneShell;
const bridge = window.redstone;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const status = $<HTMLParagraphElement>('status');
const NAMES = ['quickBar', 'summon', 'capture'] as const;
type Name = (typeof NAMES)[number];

let recording: Name | null = null;

/** `Command+Shift+Space` → `⌘⇧Space`, but only where those glyphs mean something. */
function pretty(accelerator: string | null): string {
  if (!accelerator) return 'Not set';
  if (bridge.platform !== 'darwin') return accelerator.replace(/\+/g, ' + ');
  return accelerator
    .replace('CommandOrControl', '⌘')
    .replace('Command', '⌘')
    .replace('Control', '⌃')
    .replace('Alt', '⌥')
    .replace('Option', '⌥')
    .replace('Shift', '⇧')
    .replace(/\+/g, '');
}

function say(text: string, tone: 'idle' | 'ok' | 'error' = 'idle'): void {
  status.textContent = text;
  status.dataset.tone = tone;
}

function paint(info: ShellInfo, settings: Settings): void {
  for (const name of NAMES) {
    const button = $<HTMLButtonElement>(name);
    const wanted = settings.shortcuts[name];
    const live = info.shortcuts[name];
    button.textContent = pretty(wanted);
    // Configured but not held: another app owns it, and pressing it does nothing.
    button.dataset.unset = String(!live);
    button.title = live
      ? 'Click to change'
      : `${wanted} could not be registered — another app is using it. Click to choose another.`;
  }
  const unheld = NAMES.filter((n) => !info.shortcuts[n]);
  if (unheld.length) {
    say('Another app already uses the highlighted shortcut. Pick a different one.', 'error');
  }
}

async function refresh(): Promise<void> {
  const [info, settings] = await Promise.all([bridge.info(), shell!.getSettings()]);
  paint(info, settings);
  $<HTMLInputElement>('launchAtLogin').checked = settings.launchAtLogin;
  $<HTMLInputElement>('reduceBackgroundAnimation').checked = settings.reduceBackgroundAnimation;
  $<HTMLElement>('serverOrigin').textContent = settings.appOrigin.replace(/^https?:\/\//, '') || '—';
  $<HTMLElement>('version').textContent = `Redstone ${info.version} · ${info.platform}`;
}

// --- the recorder ----------------------------------------------------------

function stopRecording(): void {
  if (!recording) return;
  $<HTMLButtonElement>(recording).dataset.recording = 'false';
  recording = null;
  void refresh();
}

for (const name of NAMES) {
  $<HTMLButtonElement>(name).addEventListener('click', () => {
    stopRecording();
    recording = name;
    const button = $<HTMLButtonElement>(name);
    button.dataset.recording = 'true';
    button.textContent = 'Press keys…';
    say('Press the combination you want, or Esc to cancel.');
  });
}

window.addEventListener('keydown', (event) => {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    stopRecording();
    say('');
    return;
  }
  // A modifier on its own is not a shortcut yet — wait for the real key.
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;

  const parts: string[] = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  if (!parts.length) {
    say('A global shortcut needs at least one modifier — ⌘, ⌃, ⌥ or ⇧.', 'error');
    return;
  }

  const key =
    event.code === 'Space'
      ? 'Space'
      : event.code.startsWith('Key')
        ? event.code.slice(3)
        : event.code.startsWith('Digit')
          ? event.code.slice(5)
          : event.code.startsWith('Arrow')
            ? event.code.slice(5)
            : event.key.length === 1
              ? event.key.toUpperCase()
              : event.key;

  const accelerator = [...parts, key].join('+');
  const name = recording;
  stopRecording();
  void apply(name, accelerator);
});

async function apply(name: Name, accelerator: string): Promise<void> {
  say(`Claiming ${pretty(accelerator)}…`);
  const result = await shell!.setShortcut(name, accelerator);
  if (result.ok) say(`${pretty(accelerator)} is yours.`, 'ok');
  else {
    say(
      `${pretty(accelerator)} is already taken by another app — the old one is still set.`,
      'error',
    );
  }
  await refresh();
}

// --- the rest --------------------------------------------------------------

$<HTMLInputElement>('reduceBackgroundAnimation').addEventListener('change', (event) => {
  void shell!.setSettings({
    reduceBackgroundAnimation: (event.target as HTMLInputElement).checked,
  });
});

$<HTMLInputElement>('launchAtLogin').addEventListener('change', (event) => {
  void shell!.setSettings({ launchAtLogin: (event.target as HTMLInputElement).checked });
});

$('switchServer').addEventListener('click', () => void shell!.openServerPicker());
$('accountSettings').addEventListener('click', () => void shell!.openAccountSettings());

void refresh();

// --- voice -----------------------------------------------------------------

/**
 * Two things are true at once here: macOS decides whether Redstone may listen at
 * all, and Chromium decides which device it listens to. The first is a yes/no we
 * can ask for; the second is a system-wide default we can only offer to
 * override, because the page owns the recording (see
 * docs/integration/06-voice-input.md).
 */
const micState = $<HTMLElement>('micState');
const micHint = $<HTMLElement>('micHint');
const micAllow = $<HTMLButtonElement>('micAllow');
const micPickerRow = $<HTMLElement>('micPickerRow');
const micPicker = $<HTMLSelectElement>('micPicker');
const micNote = $<HTMLParagraphElement>('micNote');

async function listMicrophones(preferred: string): Promise<void> {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput',
    );
  } catch {
    devices = [];
  }
  if (!devices.length) {
    micPickerRow.hidden = true;
    return;
  }
  micPickerRow.hidden = false;
  micPicker.replaceChildren();

  const system = document.createElement('option');
  system.value = '';
  system.textContent = 'System default';
  micPicker.append(system);

  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    // Labels are empty until the microphone has been granted at least once.
    option.textContent = device.label || 'Microphone';
    micPicker.append(option);
  }
  micPicker.value = devices.some((d) => d.deviceId === preferred) ? preferred : '';
}

async function refreshMicrophone(): Promise<void> {
  const [state, settings] = await Promise.all([shell!.microphoneStatus(), shell!.getSettings()]);
  const granted = state === 'granted';

  micState.textContent = granted
    ? 'Microphone is available'
    : state === 'not-determined'
      ? 'Redstone has not asked for the microphone yet'
      : 'macOS is blocking the microphone';
  micHint.textContent = granted
    ? 'Redstone records only while you use voice input.'
    : 'Voice input needs this before it can hear anything.';
  micAllow.hidden = granted;

  await listMicrophones(settings.preferredMicrophoneId ?? '');
  micNote.textContent = granted
    ? 'Redstone asks the web app to use this device; if it cannot, macOS’ own default is used.'
    : '';
  micNote.dataset.tone = 'idle';
}

micAllow.addEventListener('click', async () => {
  micAllow.disabled = true;
  const granted = await shell!.requestMicrophone();
  if (!granted) {
    micNote.textContent = 'Still blocked. Turn Redstone on in System Settings → Privacy & Security → Microphone.';
    micNote.dataset.tone = 'error';
  }
  micAllow.disabled = false;
  await refreshMicrophone();
});

micPicker.addEventListener('change', async () => {
  await shell!.setSettings({ preferredMicrophoneId: micPicker.value });
  micNote.textContent = micPicker.value
    ? 'Saved. Voice input will ask for this device.'
    : 'Saved. Voice input will follow the system default.';
  micNote.dataset.tone = 'ok';
});

void refreshMicrophone();
