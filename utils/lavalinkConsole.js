'use strict';

const ENABLED = process.env.LAVALINK_STATUS_TABLE !== '0';
const MIN_INTERVAL_MS = Math.max(5_000, Number(process.env.LAVALINK_STATUS_TABLE_INTERVAL_MS || 15_000));
const DEBOUNCE_MS = Math.max(500, Number(process.env.LAVALINK_STATUS_TABLE_DEBOUNCE_MS || 2_000));
const MAX_ROWS = Math.max(0, Number(process.env.LAVALINK_STATUS_TABLE_MAX_ROWS || 0));

const records = new Map();
let flushTimer = null;
let lastFlushAt = 0;

function short(value, max = 70) {
    const text = String(value ?? '');
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
}

function keyFor(client, data = {}) {
    return data.key
        || client?.user?.id
        || data.botId
        || (data.token ? `token:${String(data.token).slice(-10)}` : null)
        || data.bot
        || 'unknown';
}

function botName(client, data = {}) {
    return short(
        data.bot
        || client?.user?.username
        || client?.user?.tag
        || (data.token ? `...${String(data.token).slice(-6)}` : 'Unknown'),
        28,
    );
}

function nodeName(node, data = {}) {
    return short(
        data.node
        || node?.options?.name
        || node?.options?.host
        || '-',
        24,
    );
}

function stateRank(state) {
    const normalized = String(state || '').toLowerCase();
    if (normalized.includes('error') || normalized.includes('failed')) return 0;
    if (normalized.includes('offline') || normalized.includes('disconnect')) return 1;
    if (normalized.includes('reconnect') || normalized.includes('retry') || normalized.includes('reinit')) return 2;
    if (normalized.includes('starting') || normalized.includes('boot')) return 3;
    if (normalized.includes('online') || normalized.includes('connect')) return 4;
    return 5;
}

function age(ms) {
    if (!ms) return '-';
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
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
    const previous = records.get(key) || {};
    const next = {
        ...previous,
        bot: botName(client, data),
        botId: data.botId || client?.user?.id || previous.botId || '-',
        node: data.node ? nodeName(null, data) : previous.node || '-',
        state: short(data.state || previous.state || 'unknown', 22),
        event: short(data.event || previous.event || data.state || 'update', 28),
        note: short(data.note || previous.note || '-', 80),
        reconnects: data.reconnects ?? previous.reconnects ?? 0,
        players: data.players ?? previous.players ?? 0,
        updatedAt: Date.now(),
        changes: (previous.changes || 0) + 1,
    };
    records.set(key, next);
    scheduleFlush();
}

function updateNode(node, state, data = {}) {
    const client = data.client || node?.audioManager?.client;
    updateBot(client, {
        ...data,
        node: nodeName(node, data),
        state,
        players: data.players ?? node?.audioManager?.players?.size ?? 0,
    });
}

function flush() {
    if (flushTimer) {
        clearTimeout(flushTimer);
    }
    flushTimer = null;
    if (!ENABLED || records.size === 0) return;
    lastFlushAt = Date.now();

    const rows = [...records.values()]
        .sort((a, b) => stateRank(a.state) - stateRank(b.state) || String(a.bot).localeCompare(String(b.bot)))
        .map(record => ({
            Bot: record.bot,
            Node: record.node,
            State: record.state,
            Event: record.event,
            Reconnects: record.reconnects,
            Players: record.players,
            Age: age(record.updatedAt),
            Note: record.note,
        }));

    const counts = rows.reduce((acc, row) => {
        const state = String(row.State || 'unknown');
        acc[state] = (acc[state] || 0) + 1;
        return acc;
    }, {});

    const visibleRows = MAX_ROWS > 0 ? rows.slice(0, MAX_ROWS) : rows;
    console.log(`[NodeLinkStatus] bots=${rows.length} states=${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    console.table(visibleRows);
    if (MAX_ROWS > 0 && rows.length > MAX_ROWS) {
        console.log(`[NodeLinkStatus] hidden=${rows.length - MAX_ROWS} rows; set LAVALINK_STATUS_TABLE_MAX_ROWS=0 to print all.`);
    }
}

module.exports = {
    updateBot,
    updateNode,
    flush,
};
