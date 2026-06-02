'use strict';

const {
  app, BrowserWindow, BrowserView, ipcMain, Tray, Menu,
  desktopCapturer, nativeImage, shell, systemPreferences, Notification,
} = require('electron');
const path = require('path');
const Store = require('./store');

const store    = new Store();
const TOOLBAR_H = 44; // height of the top toolbar bar (px)

let mainWindow  = null;
let portalView  = null; // BrowserView showing {serverUrl}/member
let shareWindow = null; // hidden BrowserWindow running WebRTC
let tray        = null;
let isQuitting  = false;
let shownLiveNotification = false; // fire notification only on first "live" per session

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('before-quit', () => {
  isQuitting = true;
  // Ask share window to clean up stream + signal "stopped" before exit
  if (shareWindow && !shareWindow.isDestroyed()) {
    shareWindow.webContents.send('do-stop');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else createWindow();
});

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  const cfg       = store.getAll();
  const hasConfig = !!(cfg.serverUrl && cfg.employeeId);

  mainWindow = new BrowserWindow({
    width:     hasConfig ? 1280 : 500,
    height:    hasConfig ? 820  : 640,
    minWidth:  hasConfig ? 900  : 460,
    minHeight: hasConfig ? 600  : 560,
    title:     'Rank Orbit',
    backgroundColor: '#0d0f14',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (hasConfig) {
      initPortalMode(cfg.serverUrl);
    }
  });

  mainWindow.on('resize', updatePortalBounds);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  setupTray();
}

// ── Portal mode (BrowserView + hidden share window) ───────────────────────────
// NOTE: BrowserView is deprecated in Electron 30+ in favour of WebContentsView,
// but it still works reliably in Electron 31 and avoids the BaseWindow rewrite.
function initPortalMode(serverUrl) {
  // ── BrowserView for the member portal ──────────────────────────────────────
  if (portalView) {
    try { mainWindow.removeBrowserView(portalView); } catch {}
  }

  portalView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.setBrowserView(portalView);
  updatePortalBounds();
  portalView.webContents.loadURL(`${serverUrl}/member`);

  // ── Hidden window for WebRTC / Pusher ──────────────────────────────────────
  createShareWindow();
}

function updatePortalBounds() {
  if (!portalView || !mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  portalView.setBounds({
    x: 0,
    y: TOOLBAR_H,
    width:  w,
    height: Math.max(h - TOOLBAR_H, 0),
  });
}

function createShareWindow() {
  if (shareWindow && !shareWindow.isDestroyed()) {
    shareWindow.destroy();
  }

  shareWindow = new BrowserWindow({
    width:       400,
    height:      300,
    show:        false,
    skipTaskbar: true,
    webPreferences: {
      preload:          path.join(__dirname, 'preload-share.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  shareWindow.loadFile(path.join(__dirname, 'screenshare.html'));

  shareWindow.on('closed', () => { shareWindow = null; });
}

// ── System tray ───────────────────────────────────────────────────────────────
function setupTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon-tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') icon = icon.resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Rank Orbit');

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });

  updateTrayMenu('offline');
}

function updateTrayMenu(status) {
  if (!tray) return;
  const label = {
    live:       '● Working',
    connecting: '◌ Connecting…',
    offline:    '○ Not working',
  }[status] || '○ Not working';

  const ctx = Menu.buildFromTemplate([
    { label: 'Rank Orbit', enabled: false },
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Show Window', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(ctx);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Config
ipcMain.handle('get-config', () => store.getAll());

ipcMain.handle('set-config', (_, data) => {
  Object.entries(data).forEach(([k, v]) => store.set(k, v));
  return true;
});

ipcMain.handle('clear-config', () => {
  store.clear();
  return true;
});

// Called by renderer after the setup form is saved — switch to portal mode
ipcMain.handle('setup-complete', (_, { serverUrl }) => {
  mainWindow.setMinimumSize(900, 600);
  mainWindow.setSize(1280, 820);
  initPortalMode(serverUrl);
  return true;
});

// Screen sources — used by share window when re-capturing after a track dies
ipcMain.handle('get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types:         ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (err) {
    console.error('[main] get-sources error:', err);
    return [];
  }
});

// Start sharing — toolbar clicks this; main picks the first screen and forwards
ipcMain.handle('start-sharing', async () => {
  if (!shareWindow || shareWindow.isDestroyed()) {
    return { error: 'Share window not ready — try again in a moment.' };
  }

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types:         ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
  } catch (err) {
    return { error: `Could not list screens: ${err.message}` };
  }

  if (!sources.length) return { error: 'No screens found. Check screen recording permissions.' };

  const src = sources.find(s => s.id.startsWith('screen:')) || sources[0];
  const cfg = store.getAll();

  shownLiveNotification = false; // reset so notification fires on next "live"
  shareWindow.webContents.send('do-start', { cfg, sourceId: src.id });
  return { success: true };
});

// Stop sharing — toolbar clicks this
ipcMain.handle('stop-sharing', () => {
  if (shareWindow && !shareWindow.isDestroyed()) {
    shareWindow.webContents.send('do-stop');
  }
  return true;
});

// Status from share window → update tray + forward to toolbar renderer
ipcMain.on('sharing-status', (_, { state, text }) => {
  updateTrayMenu(state);
  if (tray) tray.setToolTip(`Rank Orbit — ${text || state}`);

  // Forward to toolbar
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sharing-status', { state, text });
  }

  // System notification the first time sharing goes fully live
  if (state === 'live' && !shownLiveNotification && Notification.isSupported()) {
    shownLiveNotification = true;
    new Notification({
      title: 'Screen sharing started',
      body:  'Your manager can now see your screen.',
    }).show();
  }
});

// Tray-status update from toolbar (kept for compat)
ipcMain.on('status-update', (_, status) => updateTrayMenu(status));

// macOS screen-capture permission
ipcMain.handle('check-screen-permission', async () => {
  if (process.platform !== 'darwin') return 'granted';
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'not-determined') {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    return systemPreferences.getMediaAccessStatus('screen');
  }
  return status;
});

ipcMain.handle('open-permissions', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});
