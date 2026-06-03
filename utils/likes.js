'use strict';
/**
 * likes.js — JSON-file-based likes store
 * Replaces the sqlite3 implementation to avoid native binary / GLIBC issues.
 * Data is stored in settings/likes.json, consistent with the rest of the codebase.
 *
 * Structure:
 *   { [userId]: { [uri]: { title, author, duration, likedAt } } }
 */

const fs   = require('fs');
const path = require('path');

const LIKES_FILE = path.join(process.cwd(), 'settings', 'likes.json');

function _read() {
    try {
        if (!fs.existsSync(LIKES_FILE)) fs.writeFileSync(LIKES_FILE, '{}', 'utf8');
        return JSON.parse(fs.readFileSync(LIKES_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function _write(data) {
    const tmp = LIKES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, LIKES_FILE);
}

const locks = new Map();

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

/**
 * Toggle like for a track. Returns { liked: true/false }
 */
function toggle(userId, track) {
    return withUserLock(userId, () => {
        const info  = track?.info || {};
        const uri   = trackKey(track);
        if (!userId || !uri) return Promise.reject(new Error('missing userId or uri'));

        const data   = _read();
        const bucket = data[userId] || (data[userId] = {});

        if (bucket[uri]) {
            delete bucket[uri];
            _write(data);
            return Promise.resolve({ liked: false });
        } else {
            bucket[uri] = {
                title:    info.title  || 'Unknown track',
                author:   info.author || '',
                duration: Number(info.length || 0),
                likedAt:  Date.now(),
            };
            _write(data);
            return Promise.resolve({ liked: true });
        }
    });
}

/**
 * Check if a track is liked by the user. Returns boolean.
 */
function isLiked(userId, uriOrTrack) {
    const uri = typeof uriOrTrack === 'string' ? uriOrTrack : trackKey(uriOrTrack);
    if (!userId || !uri) return Promise.resolve(false);
    const data = _read();
    return Promise.resolve(!!(data[userId] && data[userId][uri]));
}

/**
 * Get paginated likes for a user.
 * Returns { rows: [...], total: number }
 */
function getLikes(userId, { offset = 0, limit = 10 } = {}) {
    const data   = _read();
    const bucket = data[userId] || {};
    const all    = Object.entries(bucket)
        .map(([uri, v]) => ({ uri, ...v }))
        .sort((a, b) => b.likedAt - a.likedAt);
    const rows   = all.slice(offset, offset + limit);
    return Promise.resolve({ rows, total: all.length });
}

/**
 * Get all likes for a user (for queueing). Returns array of row objects.
 */
function getAllLikes(userId) {
    const data   = _read();
    const bucket = data[userId] || {};
    const rows   = Object.entries(bucket)
        .map(([uri, v]) => ({ uri, title: v.title, author: v.author, duration: v.duration }))
        .sort((a, b) => b.likedAt - a.likedAt);
    return Promise.resolve(rows);
}

module.exports = { toggle, isLiked, getLikes, getAllLikes, trackKey };
