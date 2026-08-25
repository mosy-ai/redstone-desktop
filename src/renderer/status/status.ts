/**
 * Sync status window. Lists links and the three shell-owned actions on them.
 * Rendered with DOM calls rather than innerHTML — file names come from disk and
 * are never trusted as markup.
 */
import type { LinkStatus } from '../../shared/types';

const list = document.getElementById('list') as HTMLElement;
const version = document.getElementById('shellVersion') as HTMLElement;

const LABEL: Record<LinkStatus['state'], string> = {
  synced: 'Synced',
  syncing: 'Syncing',
  paused: 'Paused',
  error: 'Error',
  conflict: 'Conflicts',
  signed_out: 'Sign in again',
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

function card(status: LinkStatus): HTMLElement {
  const dot = el('span', { className: 'dot' });
  dot.dataset.state = status.state;

  const title = el('h2', {}, [dot, status.folderName || status.folderId]);
  const path = el('div', { className: 'path', textContent: status.localPath });

  // "Paused" means the user paused it. Anything else that stops syncing is a
  // condition to describe, not a switch they flipped.
  const stoppedByServer = status.state === 'paused' && !status.pausedByUser;
  const bits = [stoppedByServer ? 'Waiting' : LABEL[status.state]];
  if (status.pending) bits.push(`${status.pending} pending`);
  if (status.lastSyncedAt) bits.push(`last sync ${new Date(status.lastSyncedAt).toLocaleTimeString()}`);
  if (status.message) bits.push(status.message);
  const meta = el('div', { className: 'meta', textContent: bits.join(' · ') });

  const children: (Node | string)[] = [title, path, meta];

  if (status.conflicts.length) {
    const items = el('ul');
    for (const conflict of status.conflicts.slice(0, 8)) {
      items.append(el('li', { textContent: conflict }));
    }
    children.push(
      el('div', { className: 'conflicts' }, [
        el('strong', { textContent: `${status.conflicts.length} conflict(s) — both copies kept` }),
        items,
      ]),
    );
  }

  if (stoppedByServer) {
    children.push(
      el('div', { className: 'conflicts' }, [
        el('strong', { textContent: 'Redstone’s file storage is offline' }),
        el('div', {
          textContent:
            'Your files are untouched on both sides. Syncing starts again by itself as soon as ' +
            'the server can accept writes — nothing to do here, and nothing is being lost in the ' +
            'meantime.',
        }),
      ]),
    );
  }

  if (status.errors.length) {
    const items = el('ul');
    for (const error of status.errors.slice(0, 8)) items.append(el('li', { textContent: error }));
    children.push(
      el('div', { className: 'conflicts' }, [
        el('strong', { textContent: `${status.errors.length} file(s) could not sync` }),
        items,
      ]),
    );
  }

  const reveal = el('button', { textContent: 'Show in file manager' });
  reveal.addEventListener('click', () => {
    void window.redstone.revealInFileManager({ folderId: status.folderId });
  });

  const sync = el('button', { textContent: 'Sync now' });
  sync.addEventListener('click', () => void window.redstone.syncNow(status.folderId));

  // Only offer Resume for a pause the user can undo. During a server outage the
  // link is already retrying, and a button that cannot help is worse than none.
  const toggle = el('button', {
    textContent: status.pausedByUser ? 'Resume' : 'Pause',
    disabled: stoppedByServer,
  });
  if (stoppedByServer) {
    toggle.title = 'Redstone is retrying on its own — nothing to resume here.';
  }
  toggle.addEventListener('click', async () => {
    if (status.pausedByUser) await window.redstone.resumeLink(status.folderId);
    else await window.redstone.pauseLink(status.folderId);
    await refresh();
  });

  const unlink = el('button', { className: 'danger', textContent: 'Unlink' });
  unlink.addEventListener('click', async () => {
    await window.redstone.unlinkFolder(status.folderId);
    await refresh();
  });

  children.push(el('div', { className: 'actions' }, [reveal, sync, toggle, unlink]));
  return el('div', { className: 'card' }, children);
}

function render(statuses: LinkStatus[]): void {
  list.replaceChildren();
  if (!statuses.length) {
    list.append(
      el('div', {
        className: 'empty',
        textContent:
          'No folders linked yet. Link one and Redstone keeps it in step with your workspace — ' +
          'you keep editing in your own tools.',
      }),
    );
    return;
  }
  for (const status of statuses) list.append(card(status));
}

async function refresh(): Promise<void> {
  render(await window.redstone.listLinks());
}

document.getElementById('add')?.addEventListener('click', async () => {
  await window.redstone.openFolder();
  await refresh();
});

document.getElementById('syncAll')?.addEventListener('click', () => void window.redstone.syncNow());

window.redstone.onSyncStatus(() => void refresh());

void window.redstone.info().then((info) => {
  version.textContent = `Redstone ${info.version} · ${info.platform}`;
});

void refresh();
