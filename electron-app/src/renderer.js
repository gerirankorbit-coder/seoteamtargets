'use strict';

// Portal mode is always active — server URL is hardcoded in main.js.
// Employee identity is discovered automatically from the portal session
// via portalAPI.notifyUser (called by member.html after /api/me resolves).

(async function boot() {
  // Listen for status updates forwarded from the share window via main process
  window.electronAPI.onSharingStatus(({ state, text }) => {
    updateToolbar(state, text);
  });

  // Update the toolbar name badge whenever the portal detects a logged-in user
  window.electronAPI.onEmployeeUpdated(({ employeeName }) => {
    const nameEl = document.getElementById('tb-emp-name');
    if (nameEl) nameEl.textContent = employeeName;
  });
})();

// Toolbar state — status dot + label in sync with screenshare.js state machine
function updateToolbar(state, text) {
  const dot       = document.getElementById('tb-status-dot');
  const label     = document.getElementById('tb-status-text');
  const statusRow = document.getElementById('tb-status-row');

  const isWorking = state === 'live' || state === 'connecting';

  if (dot)   dot.className = 'tb-dot ' + state;
  if (label) label.textContent =
    state === 'live'       ? '● Working' :
    state === 'connecting' ? '◌ Connecting...' : '';

  if (statusRow) statusRow.style.display = isWorking ? 'flex' : 'none';
}
