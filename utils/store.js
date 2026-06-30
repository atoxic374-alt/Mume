'use strict';
const fs = require('fs');
const path = require('path');

const FILES = {
  tokens:   './settings/tokens.json',
  bots:     './settings/bots.json',
  time:     './settings/time.json',
  host:     './settings/host.json',
  display:  './settings/display.json',
  emojis:   './assets/emojis.json',
  history:  './settings/history.json',
  database: './settings/database.json',
};
const OBJ_KEYS = ['display', 'database'];

class Store {
  constructor() {
    this._mem      = {};   // key → parsed value
    this._dirty    = new Set();
    this._timers   = {};
    this._flushing = new Set(); // ── #10: concurrent-write guard ──
    // Warm up all caches on startup
    for (const [key, file] of Object.entries(FILES)) {
      try {
        if (fs.existsSync(file)) {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          this._mem[key] = OBJ_KEYS.includes(key) && (Array.isArray(parsed) || !parsed || typeof parsed !== 'object')
            ? {}
            : parsed;
        } else {
          this._mem[key] = OBJ_KEYS.includes(key) ? {} : [];
        }
      }
      catch {
        this._mem[key] = OBJ_KEYS.includes(key) ? {} : [];
      }
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
    // ── #10: debounce triggers async flush ───────────────────────────────────
    this._timers[key] = setTimeout(() => this._flushAsync(key).catch(e =>
      console.error('[Store] deferred flush error:', key, e.message)
    ), 500);
  }

  // Atomic: fn receives current value, returns new value
  update(key, fn) {
    const next = fn(this._mem[key]);
    this.set(key, next);
    return next;
  }

  // =============================================================
  // دالات نودز لافالينك المفقودة (تمت إضافتها لتعمل مع music.js)
  // =============================================================
  getNodes() {
    return new Map(Object.entries(this.get('host') || {}));
  }

  setNode(name, data) {
    const hosts = this.get('host') || {};
    hosts[name] = { ...(hosts[name] || {}), ...data };
    this.set('host', hosts);
  }
  // =============================================================

  // ── #10: async flush — non-blocking write via fs.promises ───────────────────
  async _flushAsync(key) {
    if (!this._dirty.has(key)) return;
    const file = FILES[key];
    if (!file) return;
    // Prevent two concurrent writes to the same file
    if (this._flushing.has(key)) return;
    this._flushing.add(key);
    // Mark as in-progress BEFORE writing so any set() that arrives during
    // the async write adds key back to _dirty, letting us detect it in finally.
    this._dirty.delete(key);
    const tmp = file + '.tmp';
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(this._mem[key], null, 2));
      await fs.promises.rename(tmp, file);
    } catch (e) {
      this._dirty.add(key); // restore so next flush retries
      console.error('[Store] flush error:', key, e.message);
    } finally {
      this._flushing.delete(key);
      // A set() arrived while we were writing — flush the newer value now
      if (this._dirty.has(key)) {
        this._flushAsync(key).catch(e =>
          console.error('[Store] re-flush error:', key, e.message)
        );
      }
    }
  }

  // Sync flush kept for SIGTERM / process-exit path only
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
      console.error('[Store] sync flush error:', key, e.message);
    }
  }

  _flushAll() {
    for (const key of [...this._dirty]) {
      this._flushAsync(key).catch(e => console.error('[Store] flushAll error:', key, e.message));
    }
  }

  // Used only on SIGTERM — keeps sync writes for safe exit
  flushSync() {
    for (const key of this._dirty) this._flush(key);
  }
}

module.exports = new Store();
