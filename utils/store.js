'use strict';
const fs = require('fs');
const path = require('path');

const FILES = {
  tokens:  './settings/tokens.json',
  bots:    './settings/bots.json',
  time:    './settings/time.json',
  host:    './settings/host.json',
  display: './settings/display.json',
  emojis:  './settings/emojis.json',
  history: './settings/history.json',
};

class Store {
  constructor() {
    this._mem   = {};   // key → parsed value
    this._dirty = new Set();
    this._timers = {};
    // Warm up all caches on startup
    for (const [key, file] of Object.entries(FILES)) {
      try {
        if (fs.existsSync(file)) {
          this._mem[key] = JSON.parse(fs.readFileSync(file, 'utf8'));
        } else {
          this._mem[key] = key === 'host' ? [] : (key === 'display' ? {} : []);
        }
      }
      catch { this._mem[key] = key === 'host' ? [] : (key === 'display' ? {} : []); }
    }
    // Flush dirty files every 2s (safety net in addition to debounce)
    setInterval(() => this._flushAll(), 2000).unref();
  }

  get(key) {
    return this._mem[key];
  }

  set(key, value) {
    this._mem[key] = value;
    this._dirty.add(key);
    clearTimeout(this._timers[key]);
    this._timers[key] = setTimeout(() => this._flush(key), 500);
  }

  // Atomic: fn receives current value, returns new value
  update(key, fn) {
    const next = fn(this._mem[key]);
    this.set(key, next);
    return next;
  }

  _flush(key) {
    if (!this._dirty.has(key)) return;
    const file = FILES[key];
    if (!file) return;
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this._mem[key], null, 2));
      fs.renameSync(tmp, file);
      this._dirty.delete(key);
    } catch (e) {
      console.error('[Store] flush error:', key, e.message);
    }
  }

  _flushAll() {
    for (const key of this._dirty) this._flush(key);
  }

  flushSync() { this._flushAll(); }
}

module.exports = new Store();
