'use strict';

/**
 * Drop-in replacement for pro.db
 * Redirects all read/write operations to settings/database.json
 * so all data stays inside the Railway Volume.
 */

const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(process.cwd(), 'settings', 'database.json');

function _read() {
  try {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}', 'utf8');
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function _write(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

const db = {
  set(key, value) {
    if (!key) throw new TypeError('The data is not defined!');
    const file = _read();
    file[key] = value;
    _write(file);
    return value;
  },

  get(key) {
    if (!key) throw new TypeError('The data is not defined!');
    return _read()[key];
  },

  fetch(key) {
    return db.get(key);
  },

  has(key) {
    if (!key) throw new TypeError('The data is not defined!');
    return key in _read();
  },

  delete(key) {
    if (!key) throw new TypeError('The data is not defined!');
    const file = _read();
    if (!(key in file)) return false;
    delete file[key];
    _write(file);
    return true;
  },

  fetchAll() {
    return _read();
  },

  all() {
    const file = _read();
    return Object.entries(file).map(([ID, data]) => ({ ID, data }));
  },
};

module.exports = db;
