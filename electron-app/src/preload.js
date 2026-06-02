'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Return array of { id, name, thumbnail } for all screens + windows */
  getSources: () => ipcRenderer.invoke('get-sources'),

  /** Read persisted config ({ serverUrl, employeeId, employeeName }) */
  getConfig: () => ipcRenderer.invoke('get-config'),

  /** Write/merge config fields */
  setConfig: (data) => ipcRenderer.invoke('set-config', data),

  /** Wipe all saved config (reset to setup screen) */
  clearConfig: () => ipcRenderer.invoke('clear-config'),

  /** Tell main process the current sharing status for tray icon */
  updateStatus: (status) => ipcRenderer.send('status-update', status),

  /** Check screen capture permission (macOS). Returns 'granted'|'denied'|'restricted' */
  checkScreenPermission: () => ipcRenderer.invoke('check-screen-permission'),

  /** Open macOS screen-recording permissions pane */
  openPermissions: () => ipcRenderer.invoke('open-permissions'),
});
