'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Config ──────────────────────────────────────────────────────────────────
  getConfig:   ()     => ipcRenderer.invoke('get-config'),
  setConfig:   (data) => ipcRenderer.invoke('set-config', data),
  clearConfig: ()     => ipcRenderer.invoke('clear-config'),

  // ── Setup → portal transition ────────────────────────────────────────────────
  // Call after saving config to resize window + create portal BrowserView.
  setupComplete: (data) => ipcRenderer.invoke('setup-complete', data),

  // ── Screen sharing control ───────────────────────────────────────────────────
  startSharing: () => ipcRenderer.invoke('start-sharing'),
  stopSharing:  () => ipcRenderer.invoke('stop-sharing'),

  // ── Status updates from share window (via main process) ─────────────────────
  onSharingStatus: (cb) => ipcRenderer.on('sharing-status', (_, data) => cb(data)),

  // ── Portal user identity updates ────────────────────────────────────────────
  // Fires when member.html resolves /api/me so the toolbar name badge can
  // update to show the currently logged-in employee instead of the setup name.
  onEmployeeUpdated: (cb) => ipcRenderer.on('employee-updated', (_, data) => cb(data)),

  // ── Tray status (kept for compat) ───────────────────────────────────────────
  updateStatus: (s) => ipcRenderer.send('status-update', s),

  // ── macOS screen-recording permissions ──────────────────────────────────────
  checkScreenPermission: () => ipcRenderer.invoke('check-screen-permission'),
  openPermissions:       () => ipcRenderer.invoke('open-permissions'),

  // ── Screen sources (kept for compat) ────────────────────────────────────────
  getSources: () => ipcRenderer.invoke('get-sources'),
});
