'use strict';

const {
  app, BrowserWindow, BrowserView, ipcMain, Tray, Menu,
  desktopCapturer, nativeImage, shell, systemPreferences, Notification,
} = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// ── Hardcoded server URL — no setup form needed ───────────────────────────────
const SERVER_URL = 'https://seoteamtargets.vercel.app';

const TOOLBAR_H = 44; // height of the top toolbar bar (px)

let mainWindow  = null;
let portalView  = null; // BrowserView showing {SERVER_URL}/member
let shareWindow = null; // hidden BrowserWindow running WebRTC
let tray        = null;
let isQuitting  = false;
let shownLiveNotification = false; // fire notification only on first "live" per session

// Dynamically set from the portal session (overrides any fallback identity).
// When member.html resolves /api/me it calls portal-notify-user IPC which sets this.
// _startSharingInternal uses this so every employee uses THEIR OWN Pusher channel.
let currentUser = null; // { employeeId: string, employeeName: string }

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

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
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    820,
    minWidth:  900,
    minHeight: 600,
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
    // Always launch portal mode — server URL is hardcoded
    initPortalMode(SERVER_URL);
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
      preload:          path.join(__dirname, 'preload-portal.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.setBrowserView(portalView);
  updatePortalBounds();
  portalView.webContents.loadURL(`${serverUrl}/member`);

  // Stop sharing when the portal navigates away from /member (logout, session expiry).
  // will-navigate fires BEFORE the page is destroyed, giving screenshare.js time to
  // send the screenshare-stopped signal to the manager portal.
  portalView.webContents.on('will-navigate', (_, url) => {
    if (!url.includes('/member')) {
      console.log('[main] portal navigating away — stopping share + clearing user');
      currentUser = null; // clear identity; next login will re-notify
      if (shareWindow && !shareWindow.isDestroyed()) {
        shareWindow.webContents.send('do-stop');
      }
    }
  });

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

// ── Shared helper: pick source + send do-start ────────────────────────────────
async function _startSharingInternal() {
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

  // Build config: server URL is hardcoded; identity comes from the portal session.
  // currentUser is set by portal-notify-user IPC when member.html resolves /api/me.
  const cfg = {
    serverUrl:    SERVER_URL,
    employeeId:   currentUser?.employeeId   || '',
    employeeName: currentUser?.employeeName || '',
  };

  if (!cfg.employeeId) {
    return { error: 'Not logged in — please log in to the portal before starting.' };
  }

  shownLiveNotification = false;
  shareWindow.webContents.send('do-start', { cfg, sourceId: src.id });
  return { success: true };
}

// Start sharing — member portal BrowserView invokes this (via preload-portal.js)
ipcMain.handle('portal-start-sharing', () => _startSharingInternal());

// Stop sharing — member portal BrowserView
ipcMain.handle('portal-stop-sharing', () => {
  if (shareWindow && !shareWindow.isDestroyed()) shareWindow.webContents.send('do-stop');
  return true;
});

// Portal tells us which employee is currently logged in.
// Called by member.html immediately after /api/me resolves.
// We store this and use it as the identity for all subsequent start/stop calls
// so the correct Pusher channel is used regardless of who set up the app.
ipcMain.handle('portal-notify-user', (_, { username, display }) => {
  currentUser = { employeeId: username, employeeName: display };
  console.log('[main] current portal user:', username, display);
  // Update the toolbar employee name badge to reflect the logged-in user
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('employee-updated', { employeeName: display });
  }
  return true;
});

// Status from share window → update tray + forward to toolbar renderer
ipcMain.on('sharing-status', (_, { state, text }) => {
  updateTrayMenu(state);
  if (tray) tray.setToolTip(`Rank Orbit — ${text || state}`);

  // Forward to toolbar renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sharing-status', { state, text });
  }

  // Forward to member portal BrowserView (updates monitor-badge, etc.)
  if (portalView && !portalView.webContents.isDestroyed()) {
    portalView.webContents.send('portal-sharing-status', { state, text });
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

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  // Skip entirely in dev — app is not packaged, there is no release to check.
  if (!app.isPackaged) {
    console.log('[updater] dev mode — skipping update check');
    return;
  }

  autoUpdater.autoDownload        = true;   // download silently in background
  autoUpdater.autoInstallOnAppQuit = true;  // install when the user next quits

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] already up to date');
  });

  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading… ${Math.round(p.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded:', info.version);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Update available',
        body:  'App will restart to install the latest version.',
      }).show();
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
  });

  // Check 5 seconds after startup so the main window has time to appear first.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err.message);
    });
  }, 5_000);
}
