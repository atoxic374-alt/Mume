'use strict';
/**
 * db.js — SQLite key-value store (replaces the JSON-file-based version)
 * Uses settings/data.db with a simple kv_store table.
 * In-memory cache ensures reads are instant; writes go to SQLite.
 */

const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(process.cwd(), 'settings', 'data.db');

const _db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('[DB] Open error:', err.message);
});

// In-memory cache for instant sync reads
const _cache = new Map();
let _ready   = false;

_db.serialize(() => {
    _db.run(`PRAGMA journal_mode = WAL`);
    _db.run(`PRAGMA synchronous = NORMAL`);
    _db.run(`
        CREATE TABLE IF NOT EXISTS kv_store (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
    `);
    // Warm up cache from disk
    _db.all(`SELECT key, value FROM kv_store`, [], (err, rows) => {
        if (!err && rows) {
            for (const row of rows) {
                try { _cache.set(row.key, JSON.parse(row.value)); }
                catch { _cache.set(row.key, row.value); }
            }
        }
        _ready = true;
    });
});

function _persist(key, value) {
    const json = JSON.stringify(value);
    _db.run(
        `INSERT INTO kv_store(key,value,updated_at) VALUES(?,?,unixepoch())
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`,
        [key, json],
        (err) => { if (err) console.error('[DB] Write error:', key, err.message); }
    );
}

const db = {
    set(key, value) {
        if (!key) throw new TypeError('The data is not defined!');
        _cache.set(key, value);
        _persist(key, value);
        return value;
    },

    get(key) {
        if (!key) throw new TypeError('The data is not defined!');
        return _cache.get(key);
    },

    fetch(key) {
        return db.get(key);
    },

    has(key) {
        if (!key) throw new TypeError('The data is not defined!');
        return _cache.has(key);
    },

    delete(key) {
        if (!key) throw new TypeError('The data is not defined!');
        if (!_cache.has(key)) return false;
        _cache.delete(key);
        _db.run(`DELETE FROM kv_store WHERE key=?`, [key], (err) => {
            if (err) console.error('[DB] Delete error:', key, err.message);
        });
        return true;
    },

    fetchAll() {
        return Object.fromEntries(_cache);
    },

    all() {
        return [..._cache.entries()].map(([ID, data]) => ({ ID, data }));
    },
};

module.exports = db;
