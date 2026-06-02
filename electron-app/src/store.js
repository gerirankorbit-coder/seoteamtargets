'use strict';

/**
 * Minimal JSON key-value store backed by a file in the user's app data folder.
 * Zero extra dependencies — just Node's fs and Electron's app.getPath.
 */

const fs   = require('fs');
const path = require('path');

let appDataPath = null;
function getFilePath() {
  if (!appDataPath) {
    // app may not be ready yet — lazy-load
    const { app } = require('electron');
    appDataPath = path.join(app.getPath('userData'), 'config.json');
  }
  return appDataPath;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(getFilePath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  try {
    fs.writeFileSync(getFilePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[store] write error:', e);
  }
}

class Store {
  get(key) {
    return load()[key];
  }
  set(key, value) {
    const data = load();
    data[key] = value;
    save(data);
  }
  getAll() {
    return load();
  }
  clear() {
    save({});
  }
}

module.exports = Store;
