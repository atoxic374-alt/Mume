'use strict';
/**
 * likes.js — SQLite-based likes store (no JSON, lightweight, in-process)
 * Table: likes(userId TEXT, uri TEXT, title TEXT, author TEXT, duration INTEGER, likedAt INTEGER)
 * PRIMARY KEY (userId, uri) — one like per user per track, no duplicates
 */

const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(process.cwd(), 'settings', 'likes.db');

// Open (or create) the database synchronously using serialize
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('[Likes] DB open error:', err.message);
});

db.serialize(() => {
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

// ── Public API (all async via callbacks wrapped in Promises) ──────────────

/**
 * Toggle like for a track. Returns { liked: true/false }
 */
function toggle(userId, track) {
    return new Promise((resolve, reject) => {
        const { uri, title, author = '', length = 0 } = track?.info || {};
        if (!userId || !uri) return reject(new Error('missing userId or uri'));

        db.get(`SELECT 1 FROM likes WHERE userId=? AND uri=?`, [userId, uri], (err, row) => {
            if (err) return reject(err);
            if (row) {
                // already liked → remove
                db.run(`DELETE FROM likes WHERE userId=? AND uri=?`, [userId, uri], (e) => {
                    if (e) return reject(e);
                    resolve({ liked: false });
                });
            } else {
                // not liked → add
                db.run(
                    `INSERT INTO likes(userId, uri, title, author, duration, likedAt) VALUES(?,?,?,?,?,?)`,
                    [userId, uri, title, author, length, Date.now()],
                    (e) => {
                        if (e) return reject(e);
                        resolve({ liked: true });
                    }
                );
            }
        });
    });
}

/**
 * Check if a track is liked by the user. Returns boolean.
 */
function isLiked(userId, uri) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT 1 FROM likes WHERE userId=? AND uri=?`, [userId, uri], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
}

/**
 * Get paginated likes for a user.
 * Returns { rows: [...], total: number }
 */
function getLikes(userId, { offset = 0, limit = 10 } = {}) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) as cnt FROM likes WHERE userId=?`, [userId], (err, countRow) => {
            if (err) return reject(err);
            const total = countRow?.cnt || 0;

            db.all(
                `SELECT uri, title, author, duration, likedAt
                 FROM likes WHERE userId=? ORDER BY likedAt DESC LIMIT ? OFFSET ?`,
                [userId, limit, offset],
                (e2, rows) => {
                    if (e2) return reject(e2);
                    resolve({ rows: rows || [], total });
                }
            );
        });
    });
}

/**
 * Get all likes for a user (for queueing). Returns array of row objects.
 */
function getAllLikes(userId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT uri, title, author, duration FROM likes WHERE userId=? ORDER BY likedAt DESC`,
            [userId],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            }
        );
    });
}

module.exports = { toggle, isLiked, getLikes, getAllLikes };
