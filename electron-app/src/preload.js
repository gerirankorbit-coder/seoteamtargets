'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Status updates from share window (via main process) ─────────────────────
  onSharingStatus: (cb) => ipcRenderer.on('sharing-status', (_, data) => cb(data)),

  // ── Portal user identity updates ────────────────────────────────────────────
  // Fires when member.html resolves /api/me so the toolbar name badge updates
  // to show the currently logged-in employee.
  onEmployeeUpdated: (cb) => ipcRenderer.on('employee-updated', (_, data) => cb(data)),

  // ── macOS screen-recording permissions ──────────────────────────────────────
  checkScreenPermission: () => ipcRenderer.invoke('check-screen-permission'),
  openPermissions:       () => ipcRenderer.invoke('open-permissions'),
});
