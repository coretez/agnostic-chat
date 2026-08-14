'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const { openDatabase } = require('./db');
const devServer = require('./dev-server');
const { registerIpc } = require('./ipc');
const mcpManager = require('./mcp/manager');

const isDev = process.argv.includes('--dev');

// the internal design record §6 finding #1: an isolated test profile. --user-data-dir
// redirects userData (and so the database) BEFORE anything opens it — the
// only safe way to live-test against a scratch DB (a HOME override does not
// redirect app.getPath('userData') on macOS).
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', path.resolve(userDataArg.split('=').slice(1).join('=')));

// §6 finding #2: a remote-debugging port is total control over the renderer
// and, through IPC, the database. Development only — a packaged build refuses
// to start with it rather than silently exposing itself.
if (app.isPackaged && (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('inspect'))) {
  console.error('remote debugging is not permitted in packaged builds');
  app.quit();
}

/**
 * Create the main application window.
 *
 * Security posture (the foundation for "prompt protection"):
 *  - contextIsolation: renderer JS runs in its own world, isolated from preload/Electron internals.
 *  - nodeIntegration: false — the chat UI can never touch Node/fs/child_process directly.
 *  - sandbox: true — renderer runs in an OS-level sandbox.
 * The renderer reaches the outside world ONLY through the typed bridge in preload.js.
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    // Native macOS look: inset traffic lights over a translucent window.
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true // artifact panel embeds a real Chromium view (hardened below)
    }
  });

  // Harden any <webview> (artifact preview): no Node, isolated, no preload,
  // and it can never spawn app windows.
  win.webContents.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // NOTE: do NOT set webPreferences.plugins here. It looks like the fix for
    // a PDF showing black, and measurement says the opposite: with a file:
    // URL, plugins:false renders the document (1693 distinct colours in a
    // captured frame) and plugins:true fails the load outright with
    // ERR_FAILED. The black screen was the data: URL, not the plugin flag.
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Diagnostics: surface renderer console + preload errors in the terminal.
  win.webContents.on('preload-error', (_e, p, error) => {
    console.error('[preload-error]', p, error && (error.stack || error.message || error));
  });
  win.webContents.on('console-message', (...args) => {
    const msg = args.length >= 3 ? args[2] : (args[0] && args[0].message);
    console.log('[renderer]', msg);
  });

  // Open target=_blank / window.open links in the user's real browser, never
  // in-app — and only web URLs: file:/custom schemes via openExternal are an
  // execution primitive (same rule as ipc's app:openExternal).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The app window must never navigate away from its own local file.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  // Open the DB in the app's userData dir and register all IPC handlers
  // before the first window can talk to them.
  openDatabase(path.join(app.getPath('userData'), 'agnostic-chat.db'));
  registerIpc();

  createWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { devServer.disposeAll(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

// Shut down any live MCP subprocesses cleanly.
app.on('will-quit', () => { try { mcpManager.disposeAll(); } catch {} try { devServer.disposeAll(); } catch {} });
