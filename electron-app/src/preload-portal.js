'use strict';
// Injected into the BrowserView that loads {serverUrl}/member.
// Exposes a minimal portalAPI so the member portal can trigger Electron screen
// sharing without needing nodeIntegration.  The API is intentionally narrow —
// only two actions (start / stop) and one event listener (status).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portalAPI', {
  /** true — lets member.html detect it is running inside the Electron app */
  isElectron: true,

  /**
   * Called by member.html immediately after /api/me resolves.
   * Tells the main process which employee is currently logged in so the
   * correct Pusher channel (private-screenshare-{username}) is used for
   * every subsequent start/stop sharing call.
   */
  notifyUser: (username, display) =>
    ipcRenderer.invoke('portal-notify-user', { username, display }),

  /** Ask main to pick a screen source and begin WebRTC sharing */
  startSharing: () => ipcRenderer.invoke('portal-start-sharing'),

  /** Ask main to stop sharing and clean up the WebRTC peer */
  stopSharing: () => ipcRenderer.invoke('portal-stop-sharing'),

  /**
   * Register a callback that fires whenever sharing state changes.
   * cb({ state: 'live'|'connecting'|'offline'|'error', text: string })
   * Safe to call multiple times — each call adds one listener.
   */
  onSharingStatus: (cb) =>
    ipcRenderer.on('portal-sharing-status', (_, data) => cb(data)),
});
