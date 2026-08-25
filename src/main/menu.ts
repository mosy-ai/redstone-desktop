/** Application menu. Every native-only capability has a menu item, so the app is
 *  usable before the web app grows desktop-aware buttons. */
import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron';
import { openFolderFlow } from './folder-flow';
import { getActiveSession, pickAndUpload, NoActiveSessionError } from './attachments';
import { linkFolderToSession } from './session-folder';
import {
  getMainWindow,
  loadApp,
  reloadApp,
  showMainWindow,
  summonMainWindow,
} from './windows/main-window';
import { showPreferencesWindow } from './windows/preferences-window';
import { showStatusWindow } from './windows/status-window';
import { showServerWindow } from './windows/server-window';
import { toggleQuickWindow } from './windows/quick-window';
import { syncEngine } from './sync/engine';
import { getSettings } from './settings';
import { checkForUpdates } from './updater';
import { showError } from './dialogs';
import { ROUTES } from '../shared/constants';
import logger from './logger';

export function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const { shortcuts } = getSettings();

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: () => void checkForUpdates({ interactive: true }) },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'Command+,',
                click: () => showPreferencesWindow(),
              },
              { label: 'Account Settings…', click: () => void loadApp(ROUTES.settings) },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          // Same meaning as the button in the chat: link a folder to the
          // conversation that is open. Without one there is nothing to bind to,
          // so it falls back to creating a chat around the folder.
          label: 'Link a Folder to This Chat…',
          accelerator: 'CommandOrControl+O',
          click: () => {
            const sessionId = getActiveSession();
            const run = sessionId
              ? linkFolderToSession(sessionId, getMainWindow())
              : openFolderFlow(getMainWindow()).then((r) => r.status);
            void run.catch((err) => {
              logger.warn('folder link failed', err);
              showError('Could not link that folder', err);
            });
          },
        },
        {
          label: 'Attach Files…',
          accelerator: 'CommandOrControl+Shift+A',
          click: () => {
            void pickAndUpload({ parent: getMainWindow() }).catch((err) => {
              if (err instanceof NoActiveSessionError) showError('Open a conversation first', err);
              else showError('Could not attach those files', err);
            });
          },
        },
        { type: 'separator' },
        ...(isMac
          ? []
          : ([
              { label: 'Settings…', accelerator: 'Control+,', click: () => showPreferencesWindow() },
            ] as MenuItemConstructorOptions[])),
        { label: 'Switch Server…', click: () => showServerWindow() },
        { label: 'Folder Sync Status…', click: () => showStatusWindow() },
        { label: 'Sync Now', click: () => syncEngine.syncAll() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CommandOrControl+R', click: () => reloadApp() },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        {
          label: 'Quick Chat Bar',
          accelerator: shortcuts.quickBar,
          click: () => void toggleQuickWindow(),
        },
        {
          label: 'Bring Redstone to the Front',
          accelerator: shortcuts.summon,
          click: () => summonMainWindow(),
        },
        { label: 'Main Window', click: () => showMainWindow() },
        ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Redstone in a Browser',
          click: () => {
            const origin = getSettings().appOrigin;
            if (origin) void shell.openExternal(origin);
            else showServerWindow();
          },
        },
        { label: 'Show Logs', click: () => void shell.openPath(app.getPath('logs')) },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { label: 'Check for Updates…', click: () => void checkForUpdates({ interactive: true }) },
              { role: 'about' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
