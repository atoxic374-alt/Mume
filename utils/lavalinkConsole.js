'use strict';

const crypto = require('node:crypto');

const ENABLED = process.env.LAVALINK_STATUS_TABLE !== '0';
const MIN_INTERVAL_MS = Math.max(60_000, Number(process.env.LAVALINK_STATUS_TABLE_INTERVAL_MS || 60 * 60 * 1000));
const DEBOUNCE_MS = Math.max(500, Number(process.env.LAVALINK_STATUS_TABLE_DEBOUNCE_MS || 2_000));

const records = new Map();
const clientKeys = new WeakMap();
let fallbackClientId = 0;
let flushTimer = null;
let lastFlushAt = Date.now();

function tokenKey(token) {
    return `token:${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24)}`;
}

function keyFor(client, data = {}) {
    if (data.key) return String(data.key);

    if (client && (typeof client === 'object' || typeof client === 'function')) {
        const existing = clientKeys.get(client);
        if (existing) return existing;

        const token = data.token || client.token;
        const key = token
            ? tokenKey(token)
            : client.user?.id
                ? `user:${client.user.id}`
                : `client:${++fallbackClientId}`;
        clientKeys.set(client, key);
        return key;
    }

    if (data.token) return tokenKey(data.token);
    if (data.botId) return `user:${data.botId}`;
    return data.bot ? `bot:${String(data.bot)}` : 'unknown';
}

function scheduleFlush() {
    if (!ENABLED || flushTimer) return;
    const elapsed = Date.now() - lastFlushAt;
    const wait = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - elapsed);
    flushTimer = setTimeout(flush, wait);
    flushTimer.unref?.();
}

function updateBot(client, data = {}) {
    if (!ENABLED) return;
    const key = keyFor(client, data);
    const previous = records.get(key) || 'unknown';
    const state = String(data.state || previous).slice(0, 24);
    records.set(key, state);
    scheduleFlush();
}

function updateNode(node, state, data = {}) {
    const client = data.client || node?.poru?.client;
    updateBot(client, { ...data, state });
}

function removeBot(client, data = {}) {
    const key = keyFor(client, data);
    const removed = records.delete(key);
    if (client && (typeof client === 'object' || typeof client === 'function')) {
        clientKeys.delete(client);
    }
    if (removed) scheduleFlush();
    return removed;
}

function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!ENABLED || records.size === 0) return;

    const now = Date.now();
    if (now - lastFlushAt < MIN_INTERVAL_MS) return;
    lastFlushAt = now;

    const counts = new Map();
    for (const state of records.values()) {
        counts.set(state, (counts.get(state) || 0) + 1);
    }

    const rows = [
        { State: 'TOTAL', Count: records.size },
        ...[...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([State, Count]) => ({ State, Count })),
    ];

    console.log(`[LavalinkStatus] bots=${records.size} states=${[...counts.entries()].map(([state, count]) => `${state}:${count}`).join(', ')}`);
    console.table(rows);
}

if (ENABLED) {
    const reportTimer = setInterval(flush, MIN_INTERVAL_MS);
    reportTimer.unref?.();
}

module.exports = {
    updateBot,
    updateNode,
    removeBot,
    flush,
};
