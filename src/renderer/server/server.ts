/**
 * First-run server picker.
 *
 * The shell cannot guess which Redstone instance a user belongs to — it may be
 * self-hosted or regional — so this is the screen before the login screen. It
 * only ever hands a string to the main process, which does the validating and
 * the probing; nothing here talks to the network itself.
 */
import type { KnownServer, ProbeResult } from '../../shared/types';

const shell = window.redstoneShell;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const form = $<HTMLFormElement>('form');
const input = $<HTMLInputElement>('url');
const status = $<HTMLDivElement>('status');
const submit = $<HTMLButtonElement>('submit');
const submitLabel = $<HTMLSpanElement>('submitLabel');
const spinner = $<HTMLSpanElement>('spinner');
const knownSection = $<HTMLElement>('known');
const knownList = $<HTMLUListElement>('knownList');
const cancel = $<HTMLButtonElement>('cancel');

let busy = false;

function setStatus(text: string, tone: 'idle' | 'ok' | 'error' = 'idle'): void {
  status.textContent = text;
  status.dataset.tone = tone;
  input.setAttribute('aria-invalid', String(tone === 'error'));
}

function setBusy(next: boolean): void {
  busy = next;
  submit.disabled = next;
  spinner.hidden = !next;
  submitLabel.textContent = next ? 'Checking…' : 'Connect';
  input.readOnly = next;
}

async function connect(raw: string): Promise<void> {
  const value = raw.trim();
  if (!value || busy) return;
  setBusy(true);
  setStatus('Looking for a Redstone server…');
  try {
    const result: ProbeResult = await shell!.probeServer(value);
    if (!result.ok) {
      setStatus(result.message ?? 'Could not connect to that server.', 'error');
      setBusy(false);
      input.select();
      return;
    }
    setStatus(`Found ${result.name ?? 'Redstone'} — opening…`, 'ok');
    // The main process closes this window once the app window is up.
    await shell!.useServer(result.origin!);
  } catch (err) {
    setStatus((err as Error).message ?? 'Something went wrong.', 'error');
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void connect(input.value);
});

cancel.addEventListener('click', () => shell?.closeServerPicker());

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !cancel.hidden) shell?.closeServerPicker();
});

function renderKnown(servers: KnownServer[], activeOrigin: string | null): void {
  const others = servers.filter((s) => s.origin !== activeOrigin);
  if (!others.length) {
    knownSection.hidden = true;
    return;
  }
  knownSection.hidden = false;
  knownList.replaceChildren();
  for (const server of others) {
    const item = document.createElement('li');

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'server';
    pick.textContent = server.origin.replace(/^https?:\/\//, '');
    pick.title = server.origin;
    pick.addEventListener('click', () => void connect(server.origin));

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'forget';
    forget.textContent = '×';
    forget.title = 'Forget this server';
    forget.setAttribute('aria-label', `Forget ${server.origin}`);
    forget.addEventListener('click', async () => {
      await shell!.forgetServer(server.origin);
      void load();
    });

    item.append(pick, forget);
    knownList.append(item);
  }
}

async function load(): Promise<void> {
  const state = await shell!.serverState();
  renderKnown(state.servers, state.activeOrigin);

  // Reached from the menu rather than on first run: there is something to go
  // back to, and the current server is worth showing.
  cancel.hidden = !state.activeOrigin;
  if (state.activeOrigin) {
    $<HTMLHeadingElement>('title').textContent = 'Switch server';
    $<HTMLParagraphElement>('subtitle').textContent =
      'Connecting to a different Redstone signs you into that instance. Folders linked here keep syncing when you switch back.';
    input.placeholder = state.activeOrigin.replace(/^https?:\/\//, '');
  }
  $<HTMLSpanElement>('version').textContent = `Redstone ${state.version}`;
  input.focus();
}

void load();
