'use strict';
/**
 * db.js — In-memory key-value store with JSON file persistence
 * - Reads are instant (served from RAM)
 * - Writes are debounced (500 ms) then flushed to disk atomically
 * - Fully synchronous get/has/delete; async-compatible get (returns Promise)
 * - Zero native dependencies — works on Railway, Replit, everywhere
 *
 * Used by: commands/Control/mu.js (rate-limit timestamps)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SETTINGS_DIR = path.join(process.cwd(), 'settings');
const DB_FILE      = path.join(SETTINGS_DIR, 'database.json');
const FLUSH_DELAY  = 500;   // ms debounce before writing to disk

// ── Ensure settings/ dir exists ───────────────────────────────────────────────
try { if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true }); }
catch (e) { console.error('[DB] Could not create settings dir:', e.message); }

// ── Load existing data into memory ────────────────────────────────────────────
const _cache = new Map();
let   _dirty = false;
let   _timer = null;

try {
    if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) _cache.set(k, v);
        console.log(`[DB] Loaded ${_cache.size} entries from ${DB_FILE}`);
    }
} catch (e) {
    console.error('[DB] Failed to load database.json (starting fresh):', e.message);
}

// ── Atomic flush to disk ──────────────────────────────────────────────────────
function _flush() {
    if (!_dirty) return;
    _dirty = false;
    const tmp = DB_FILE + '.tmp';
    try {
        const obj = Object.fromEntries(_cache);
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
        fs.renameSync(tmp, DB_FILE);
    } catch (e) {
        console.error('[DB] Flush error:', e.message);
        _dirty = true;   // retry next cycle
    }
}

function _scheduledFlush() {
    _dirty = true;
    clearTimeout(_timer);
    _timer = setTimeout(_flush, FLUSH_DELAY);
}

// Safety net: flush on process exit
process.on('exit',    _flush);
process.on('SIGTERM', () => { _flush(); process.exit(0); });
process.on('SIGINT',  () => { _flush(); process.exit(0); });

// Periodic safety flush every 30 s
setInterval(_flush, 30_000).unref();

// ── Public API ────────────────────────────────────────────────────────────────
const db = {
    /**
     * Store a value. Returns the value.
     * Compatible with both sync usage and `await db.set(...)`.
     */
    set(key, value) {
        if (!key) throw new TypeError('[DB] set: key is required');
        _cache.set(key, value);
        _scheduledFlush();
        return value;
    },

    /**
     * Retrieve a value.
     * Returns a Promise so callers can `await db.get(key)`.
     * Also works synchronously via `.get(key)` (returns the resolved value directly).
     */
    get(key) {
        if (!key) throw new TypeError('[DB] get: key is required');
        const value = _cache.get(key) ?? undefined;
        // Return a thenable so `await db.get(key)` works, while
        // synchronous callers who skip await still get the value.
        const p = Promise.resolve(value);
        // Attach .value for optional sync access
        p.value = value;
        return p;
    },

    /** Alias for get() */
    fetch(key) { return db.get(key); },

    /** Synchronous existence check */
    has(key) {
        if (!key) throw new TypeError('[DB] has: key is required');
        return _cache.has(key);
    },

    /**
     * Delete a key. Returns true if it existed, false otherwise.
     */
    delete(key) {
        if (!key) throw new TypeError('[DB] delete: key is required');
        if (!_cache.has(key)) return false;
        _cache.delete(key);
        _scheduledFlush();
        return true;
    },

    /** Return a plain object snapshot of all data */
    fetchAll() { return Object.fromEntries(_cache); },

    /** Return an array of { ID, data } pairs (pro.db compat) */
    all() {
        return [..._cache.entries()].map(([ID, data]) => ({ ID, data }));
    },

    /** Force an immediate synchronous disk flush (use sparingly) */
    flushSync: _flush,
};

module.exports = db;
