'use strict';
/**
 * likes.js — SQLite (WASM) likes store
 * Uses node-sqlite3-wasm: pure WebAssembly, no native binaries, no GLIBC dependency.
 * Works on Railway, Replit, Docker, and any Node.js environment.
 */

const path = require('path');
const { Database } = require('node-sqlite3-wasm');

const fs = require('fs');

const DB_PATH = path.join(process.cwd(), 'settings', 'likes.db');
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '');
const db = new Database(DB_PATH);

db.run(`PRAGMA journal_mode = WAL`);
db.run(`PRAGMA synchronous = NORMAL`);
db.run(`PRAGMA busy_timeout = 5000`);
db.run(`
    CREATE TABLE IF NOT EXISTS likes (
        userId   TEXT    NOT NULL,
        uri      TEXT    NOT NULL,
        title    TEXT    NOT NULL,
        author   TEXT    NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        likedAt  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (userId, uri)
    )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_likes_userId ON likes(userId)`);

const locks = new Map();

function withUserLock(userId, task) {
    const key = String(userId || 'global');
    const previous = locks.get(key) || Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(task)
        .finally(() => { if (locks.get(key) === next) locks.delete(key); });
    locks.set(key, next);
    return next;
}

function trackKey(track) {
    const info = track?.info || track || {};
    return info.uri
        || info.identifier
        || [info.sourceName, info.author, info.title, info.length].filter(Boolean).join(':')
        || null;
}

function toggle(userId, track) {
    return withUserLock(userId, () => {
        const info   = track?.info || {};
        const uri    = trackKey(track);
        if (!userId || !uri) return Promise.reject(new Error('missing userId or uri'));

        const exists = db.get(
            `SELECT 1 FROM likes WHERE userId=? AND uri=?`, [userId, uri]
        );
        if (exists) {
            db.run(`DELETE FROM likes WHERE userId=? AND uri=?`, [userId, uri]);
            return Promise.resolve({ liked: false });
        } else {
            db.run(
                `INSERT INTO likes(userId,uri,title,author,duration,likedAt) VALUES(?,?,?,?,?,?)`,
                [userId, uri, info.title || 'Unknown track', info.author || '',
                 Number(info.length || 0), Date.now()]
            );
            return Promise.resolve({ liked: true });
        }
    });
}

function isLiked(userId, uriOrTrack) {
    const uri = typeof uriOrTrack === 'string' ? uriOrTrack : trackKey(uriOrTrack);
    if (!userId || !uri) return Promise.resolve(false);
    const row = db.get(`SELECT 1 FROM likes WHERE userId=? AND uri=?`, [userId, uri]);
    return Promise.resolve(!!row);
}

function getLikes(userId, { offset = 0, limit = 10 } = {}) {
    const total = (db.get(`SELECT COUNT(*) as cnt FROM likes WHERE userId=?`, [userId])?.cnt) || 0;
    const rows  = db.all(
        `SELECT uri,title,author,duration,likedAt FROM likes WHERE userId=? ORDER BY likedAt DESC LIMIT ? OFFSET ?`,
        [userId, limit, offset]
    ) || [];
    return Promise.resolve({ rows, total });
}

function getAllLikes(userId) {
    const rows = db.all(
        `SELECT uri,title,author,duration FROM likes WHERE userId=? ORDER BY likedAt DESC`,
        [userId]
    ) || [];
    return Promise.resolve(rows);
}

module.exports = { toggle, isLiked, getLikes, getAllLikes, trackKey };
