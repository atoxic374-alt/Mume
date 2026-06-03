'use strict';
/**
 * db.js — SQLite (WASM) key-value store
 * Uses node-sqlite3-wasm: pure WebAssembly, no native binaries, no GLIBC dependency.
 * In-memory cache for instant sync reads; writes go directly to SQLite.
 */

const path = require('path');
const { Database } = require('node-sqlite3-wasm');

const fs = require('fs');

const DB_PATH = path.join(process.cwd(), 'settings', 'data.db');
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '');
const _db = new Database(DB_PATH);

_db.run(`PRAGMA journal_mode = WAL`);
_db.run(`PRAGMA synchronous = NORMAL`);
_db.run(`
    CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
`);

// Warm up in-memory cache from disk on startup
const _cache = new Map();
const rows = _db.all(`SELECT key, value FROM kv_store`) || [];
for (const row of rows) {
    try { _cache.set(row.key, JSON.parse(row.value)); }
    catch { _cache.set(row.key, row.value); }
}

const db = {
    set(key, value) {
        if (!key) throw new TypeError('The data is not defined!');
        _cache.set(key, value);
        _db.run(
            `INSERT INTO kv_store(key,value,updated_at) VALUES(?,?,unixepoch())
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`,
            [key, JSON.stringify(value)]
        );
        return value;
    },

    get(key) {
        if (!key) throw new TypeError('The data is not defined!');
        return _cache.get(key);
    },

    fetch(key) { return db.get(key); },

    has(key) {
        if (!key) throw new TypeError('The data is not defined!');
        return _cache.has(key);
    },

    delete(key) {
        if (!key) throw new TypeError('The data is not defined!');
        if (!_cache.has(key)) return false;
        _cache.delete(key);
        _db.run(`DELETE FROM kv_store WHERE key=?`, [key]);
        return true;
    },

    fetchAll() { return Object.fromEntries(_cache); },

    all() {
        return [..._cache.entries()].map(([ID, data]) => ({ ID, data }));
    },
};

module.exports = db;
