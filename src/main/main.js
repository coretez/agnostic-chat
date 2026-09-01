'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const { openDatabase } = require('./db');
const repo = require('./db/repo');
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
function windowOptions() {
  return {
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
  };
}

function hardenWebview(_event, webPreferences) {
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
}

function attachDiagnostics(window) {
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error && (error.stack || error.message || error));
  });
  window.webContents.on('console-message', (...args) => {
    const message = args.length >= 3 ? args[2] : (args[0] && args[0].message);
    console.log('[renderer]', message);
  });
}

function restrictNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function createWindow() {
  const window = new BrowserWindow(windowOptions());
  window.webContents.on('will-attach-webview', (_e, webPreferences) => {
    hardenWebview(_e, webPreferences);
  });
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  attachDiagnostics(window);
  restrictNavigation(window);
  if (isDev) window.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  // Open the DB in the app's userData dir and register all IPC handlers
  // before the first window can talk to them.
  openDatabase(path.join(app.getPath('userData'), 'agnostic-chat.db'));
  const recovered = repo.workflowRuns.recoverInterrupted();
  if (recovered) console.log(`[workflow recovery] marked ${recovered} interrupted run(s) partial`);
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
