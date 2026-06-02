'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu,
  desktopCapturer, nativeImage, shell,
  systemPreferences,
} = require('electron');
const path = require('path');
const Store = require('./store');   // tiny key-value wrapper (see below)

// ── Persistent config store (plain JSON, no extra deps) ─────────────────────
const store = new Store();

let mainWindow = null;
let tray       = null;
let isQuitting = false;

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           540,
    height:          680,
    minWidth:        460,
    minHeight:       560,
    title:           'RO Screen Share',
    backgroundColor: '#0d0f14',
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Required so renderer can call getUserMedia with chromeMediaSource
      webSecurity:      false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    // If configured, show immediately; otherwise show setup screen
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide(); // minimize to tray instead
    }
  });

  setupTray();
}

// ── System tray ───────────────────────────────────────────────────────────────
function setupTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon-tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    // On macOS, make it a template icon (auto adapts to dark/light mode)
    if (process.platform === 'darwin') icon = icon.resize({ width: 16, height: 16 });
  } catch {
    // Fall back to an empty transparent 16×16 icon if asset is missing
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('RO Screen Share');

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });

  updateTrayMenu('offline');
}

function updateTrayMenu(status) {
  if (!tray) return;
  const label = { live: '● Live', connecting: '◌ Connecting…', offline: '○ Offline' }[status] || '○ Offline';
  const ctx = Menu.buildFromTemplate([
    { label: 'RO Screen Share', enabled: false },
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Show Window', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(ctx);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Return available screen / window sources for source picker
ipcMain.handle('get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types:            ['screen', 'window'],
      thumbnailSize:    { width: 280, height: 158 },
      fetchWindowIcons: false,
    });
    return sources.map(s => ({
      id:        s.id,
      name:      s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  } catch (err) {
    console.error('[main] get-sources error:', err);
    return [];
  }
});

// Persistent config (serverUrl, employeeId, employeeName)
ipcMain.handle('get-config', () => store.getAll());

ipcMain.handle('set-config', (_, data) => {
  Object.entries(data).forEach(([k, v]) => store.set(k, v));
  return true;
});

ipcMain.handle('clear-config', () => {
  store.clear();
  return true;
});

// Let renderer update tray status
ipcMain.on('status-update', (_, status) => {
  updateTrayMenu(status);
  if (tray) tray.setToolTip(`RO Screen Share — ${status}`);
});

// Check screen capture permission (macOS only)
ipcMain.handle('check-screen-permission', async () => {
  if (process.platform !== 'darwin') return 'granted';
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'not-determined') {
    // Trigger a getSources call to prompt the user
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    return systemPreferences.getMediaAccessStatus('screen');
  }
  return status; // 'granted' | 'denied' | 'restricted'
});

// Open system preferences (macOS) or shell URL
ipcMain.handle('open-permissions', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});
