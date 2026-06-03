'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Preload for the hidden share window (screenshare.html).
// Exposes a minimal shareAPI — no UI, just config + IPC to main.
contextBridge.exposeInMainWorld('shareAPI', {
  // Retrieve stored config (serverUrl, employeeId, employeeName, …)
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Get available screen sources for re-capture after a track dies
  getSources: () => ipcRenderer.invoke('get-sources'),

  // Report sharing status to main → main forwards to toolbar + updates tray
  reportStatus: (state, text) => ipcRenderer.send('sharing-status', { state, text }),

  // Receive "start sharing" command from main process
  // Callback receives { cfg, sourceId }
  onStart: (cb) => ipcRenderer.on('do-start', (_, data) => cb(data)),

  // Receive "stop sharing" command from main process
  onStop: (cb) => ipcRenderer.on('do-stop', () => cb()),

  // Screen lock / unlock forwarded from powerMonitor in main process
  onScreenLocked:   (cb) => ipcRenderer.on('screen-locked',   () => cb()),
  onScreenUnlocked: (cb) => ipcRenderer.on('screen-unlocked', () => cb()),
});
