/** Capture source picker: screens first, then windows. */
const shell = window.redstoneShell;
const container = document.getElementById('sources') as HTMLElement;

document.getElementById('cancel')?.addEventListener('click', () => shell?.cancelCapture());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') shell?.cancelCapture();
});

void shell?.captureSources().then((sources) => {
  const ordered = [...sources].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1));
  container.replaceChildren();
  for (const source of ordered) {
    const button = document.createElement('button');
    button.className = 'source';
    button.type = 'button';

    const img = document.createElement('img');
    img.src = source.thumbnail;
    img.alt = '';

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = source.kind === 'screen' ? 'Screen' : 'Window';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = source.name;
    name.title = source.name;

    button.append(img, kind, name);
    button.addEventListener('click', () => shell?.chooseCaptureSource(source.id));
    container.append(button);
  }
  (container.querySelector('.source') as HTMLElement | null)?.focus();
});
