'use strict';
/**
 * likes.js — SQLite-based likes store
 * Built from source via nixpacks.toml on Railway to avoid GLIBC issues.
 * Table: likes(userId, uri, title, author, duration, likedAt)
 * PRIMARY KEY (userId, uri)
 */

const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(process.cwd(), 'settings', 'likes.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('[Likes] DB open error:', err.message);
});

const locks = new Map();

db.serialize(() => {
    db.run(`PRAGMA journal_mode = WAL`);
    db.run(`PRAGMA busy_timeout = 5000`);
    db.run(`PRAGMA synchronous = NORMAL`);
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
});

function withUserLock(userId, task) {
    const key = String(userId || 'global');
    const previous = locks.get(key) || Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(task)
        .finally(() => {
            if (locks.get(key) === next) locks.delete(key);
        });
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
    return withUserLock(userId, () => new Promise((resolve, reject) => {
        const info   = track?.info || {};
        const uri    = trackKey(track);
        const title  = info.title  || 'Unknown track';
        const author = info.author || '';
        const length = Number(info.length || 0);
        if (!userId || !uri) return reject(new Error('missing userId or uri'));

        db.get(`SELECT 1 FROM likes WHERE userId=? AND uri=?`, [userId, uri], (err, row) => {
            if (err) return reject(err);
            if (row) {
                db.run(`DELETE FROM likes WHERE userId=? AND uri=?`, [userId, uri], (e) => {
                    if (e) return reject(e);
                    resolve({ liked: false });
                });
            } else {
                db.run(
                    `INSERT INTO likes(userId,uri,title,author,duration,likedAt) VALUES(?,?,?,?,?,?)`,
                    [userId, uri, title, author, length, Date.now()],
                    (e) => {
                        if (e) return reject(e);
                        resolve({ liked: true });
                    }
                );
            }
        });
    }));
}

function isLiked(userId, uriOrTrack) {
    return new Promise((resolve, reject) => {
        const uri = typeof uriOrTrack === 'string' ? uriOrTrack : trackKey(uriOrTrack);
        if (!userId || !uri) return resolve(false);
        db.get(`SELECT 1 FROM likes WHERE userId=? AND uri=?`, [userId, uri], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
}

function getLikes(userId, { offset = 0, limit = 10 } = {}) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) as cnt FROM likes WHERE userId=?`, [userId], (err, countRow) => {
            if (err) return reject(err);
            const total = countRow?.cnt || 0;
            db.all(
                `SELECT uri,title,author,duration,likedAt FROM likes WHERE userId=? ORDER BY likedAt DESC LIMIT ? OFFSET ?`,
                [userId, limit, offset],
                (e2, rows) => {
                    if (e2) return reject(e2);
                    resolve({ rows: rows || [], total });
                }
            );
        });
    });
}

function getAllLikes(userId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT uri,title,author,duration FROM likes WHERE userId=? ORDER BY likedAt DESC`,
            [userId],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            }
        );
    });
}

module.exports = { toggle, isLiked, getLikes, getAllLikes, trackKey };
