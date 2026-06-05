'use strict';

const MUSIC_EMOJIS = {
    loop:        { id: '1511836496053796879', name: 'loop' },
    volumeUp:    { id: '1511836494057312359', name: 'volumeUp' },
    pause:       { id: '1511836485815632065', name: 'pause' },
    volumeDown:  { id: '1511836491721085034', name: 'volumeDown' },
    skip:        { id: '1511836482170519604', name: 'skip' },
    stop:        { id: '1511836488797782037', name: 'stop' },
    like:        { id: '1511836479570313338', name: 'like' },
    dislike:     { id: '1511836476869181641', name: 'dislike' },
    queue:       { id: '1511836499392466974', name: 'queue' },
    settings:    { id: '1511856454838255616', name: 'settings' },
    filters:     { id: '1511837180530790592', name: 'filters' },
    artistTop:   { id: '1511836503096164595', name: 'artistTop' },
    smartSearch: { id: '1511837177800298669', name: 'smartSearch' },
    pageNext:    { id: '1251766110022537256', name: 'pageNext' },
    pagePrev:    { id: '1251766205111468043', name: 'pagePrev' },
    clear:       { id: '1240135421434925076', name: 'clear' },
    platforms: {
        ytsearch:  { id: '1511837171772821544', name: 'youtube' },
        ytmsearch: { id: '1511837171772821544', name: 'youtube' },
        scsearch:  { id: '1511837168824356925', name: 'soundcloud' },
        spsearch:  { id: '1511837174323085443', name: 'spotify' },
        amsearch:  { id: '1511837166014169228', name: 'applemusic' },
        dzsearch:  { id: '1511837155247259768', name: 'deezer' },
    },
};

// ── Emoji ID map (original ID → uploaded application emoji ID) ─────────────
// Set by syncMusicEmojis() at bot startup.  Maps the hard-coded IDs above to
// the IDs of the application emojis that were actually uploaded to this bot,
// allowing cachedEmoji() to find them in client.application.emojis.cache.
let _emojiIdMap = {};

function setEmojiMap(map) {
    _emojiIdMap = (map && typeof map === 'object') ? map : {};
}

// ── Reaction cache (populated once at startup, zero API calls at runtime) ───
// Maps original emoji ID → best resolvable for message.react():
//   • GuildEmoji object  (Method 1 — most reliable)
//   • ApplicationEmoji object  (Method 2 — works since Discord 2024)
//   • 'name:id' string  (Method 3 — guaranteed, API-call on first use)
const _reactionCache = new Map();

/**
 * loadMusicEmojis(client)
 *
 * Called ONCE at bot startup (after syncMusicEmojis + setEmojiMap).
 * Tries three methods in priority order and fills _reactionCache so that
 * every subsequent react() call is a plain Map lookup — no extra API calls.
 *
 * Method 1 — Guild scan
 *   Iterates every guild the bot is in and fetches its emoji list.
 *   Guild emojis are the gold standard for message reactions.
 *   Stops scanning guilds early once all IDs are resolved.
 *
 * Method 2 — Application emojis
 *   Reads client.application.emojis (already fetched by syncMusicEmojis).
 *   Discord has supported application emoji reactions since late 2024.
 *   Covers both original IDs and mapped (re-uploaded) IDs.
 *
 * Method 3 — Pre-built string cache
 *   For any emoji still unresolved, stores 'name:id' string.
 *   Discord validates access server-side on the first react; if rejected
 *   the ID is added to _reactionFailedIds so future calls go straight
 *   to the unicode fallback without another API round-trip.
 */
async function loadMusicEmojis(client) {
    const entries = customEmojiEntries();
    if (!entries.length) return;

    // Working set: original ID → emoji data — removed as each ID is resolved
    const pending = new Map(entries.map(e => [e.emoji.id, e.emoji]));

    let byGuild = 0;
    let byApp   = 0;
    let byStr   = 0;

    // ── Method 1: Guild scan ──────────────────────────────────────────────────
    const guilds = [...(client.guilds?.cache?.values() || [])];
    for (const guild of guilds) {
        if (pending.size === 0) break;
        try {
            const fetched = await guild.emojis.fetch();
            for (const [id, guildEmoji] of fetched) {
                if (pending.has(id)) {
                    _reactionCache.set(id, guildEmoji);
                    pending.delete(id);
                    byGuild++;
                }
            }
        } catch { /* guild fetch failed — try next */ }
    }

    // ── Method 2: Application emojis ─────────────────────────────────────────
    if (pending.size > 0) {
        try {
            const appEmojis = await client.application.emojis.fetch();
            const byId = new Map([...appEmojis.values()].map(e => [e.id, e]));

            for (const [origId, emojiData] of [...pending]) {
                // Try the original ID directly (bot may own it as an app emoji)
                if (byId.has(origId)) {
                    _reactionCache.set(origId, byId.get(origId));
                    pending.delete(origId);
                    byApp++;
                    continue;
                }
                // Try the mapped/re-uploaded ID from syncMusicEmojis
                const mappedId = _emojiIdMap[origId];
                if (mappedId && byId.has(mappedId)) {
                    _reactionCache.set(origId, byId.get(mappedId));
                    pending.delete(origId);
                    byApp++;
                }
            }
        } catch { /* application emoji fetch failed */ }
    }

    // ── Method 3: Pre-built string cache ─────────────────────────────────────
    // Anything still pending gets a pre-built 'name:id' string.
    // react() will attempt this string once; failures are cached in
    // _reactionFailedIds so the next call goes straight to unicode.
    for (const [origId, emojiData] of pending) {
        const name = emojiData.name || 'emoji';
        _reactionCache.set(origId, `${name}:${origId}`);
        byStr++;
    }

    const total = entries.length;
    console.log(
        `[MusicEmojis] startup load — ${total} emojis: ` +
        `${byGuild} guild ✅  ${byApp} app ✅  ${byStr} string 🔤`
    );
}

// ── Core helpers ──────────────────────────────────────────────────────────────

function parseEmojiData(data) {
    if (!data) return null;

    if (typeof data === 'string') {
        const value = data.trim();
        const custom = value.match(/^<(?<animated>a?):(?<name>[A-Za-z0-9_~.-]+):(?<id>\d{17,20})>$/);
        if (custom?.groups) {
            return {
                id: custom.groups.id,
                name: custom.groups.name,
                animated: custom.groups.animated === 'a',
            };
        }
        if (/^\d{17,20}$/.test(value)) return { id: value };
        return { name: value };
    }

    if (typeof data === 'object') {
        const id = data.id ? String(data.id) : null;
        const name = data.name ? String(data.name) : null;
        if (!id && !name) return null;
        return { id, name, animated: data.animated === true };
    }

    return null;
}

function emojiStr(data) {
    const emoji = parseEmojiData(data);
    if (!emoji) return '';
    if (!emoji.id) return emoji.name || '';
    if (!emoji.name) return emoji.id;
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

/**
 * Returns the Discord emoji object from cache if the bot can access it.
 * Checks (in order):
 *   1. Guild emoji cache — original ID
 *   2. Application emoji cache — original ID
 *   3. Application emoji cache — mapped ID (after syncMusicEmojis upload)
 */
function cachedEmoji(data, client = null) {
    const emoji = parseEmojiData(data);
    if (!emoji?.id) return null;

    // 1 & 2: try original ID in guild + app cache
    const byOriginal = client?.emojis?.cache?.get?.(emoji.id)
        || client?.application?.emojis?.cache?.get?.(emoji.id);
    if (byOriginal) return byOriginal;

    // 3: try mapped ID (emoji was re-uploaded to this bot's application)
    const mappedId = _emojiIdMap[emoji.id];
    if (mappedId && mappedId !== emoji.id) {
        const byMapped = client?.emojis?.cache?.get?.(mappedId)
            || client?.application?.emojis?.cache?.get?.(mappedId);
        if (byMapped) return byMapped;
    }

    return null;
}

function isApplicationOnlyEmoji(data, client = null) {
    const emoji = parseEmojiData(data);
    if (!emoji?.id) return false;
    const inGuild = client?.emojis?.cache?.get?.(emoji.id);
    if (inGuild) return false;
    const inApp = client?.application?.emojis?.cache?.get?.(emoji.id);
    if (inApp) return true;
    const mappedId = _emojiIdMap[emoji.id];
    if (mappedId) {
        return !!(client?.application?.emojis?.cache?.get?.(mappedId));
    }
    return false;
}

function componentEmoji(data, client = null, fallback = null) {
    const emoji = parseEmojiData(data);
    if (!emoji) return fallback;
    if (!emoji.id) return emoji.name || fallback;

    const cached = cachedEmoji(data, client);
    if (cached) {
        return { id: cached.id, name: cached.name || emoji.name || 'emoji', animated: cached.animated === true };
    }

    return { id: emoji.id, name: emoji.name || 'emoji', animated: emoji.animated === true };
}

function messageEmoji(data, client = null, fallback = '') {
    const emoji = parseEmojiData(data);
    if (!emoji) return fallback;
    if (!emoji.id) return emoji.name || fallback;

    const cached = cachedEmoji(data, client);
    if (!cached) return fallback;
    return `<${cached.animated ? 'a' : ''}:${cached.name || emoji.name || 'emoji'}:${cached.id}>`;
}

function emojiResolvable(data, client = null) {
    const emoji = parseEmojiData(data);
    if (!emoji) return null;
    if (!emoji.id) return emoji.name || null;

    const guildEmoji = client?.emojis?.cache?.get?.(emoji.id);
    if (guildEmoji) return guildEmoji;

    const appEmoji = client?.application?.emojis?.cache?.get?.(emoji.id);
    if (appEmoji) return appEmoji;

    return { id: emoji.id, name: emoji.name || 'emoji', animated: emoji.animated === true };
}

function reactionIdentifier(data) {
    const emoji = parseEmojiData(data);
    if (!emoji?.id) return emoji?.name || null;
    return emoji.name ? `${emoji.name}:${emoji.id}` : emoji.id;
}

function customEmojiEntries() {
    const entries = [];
    const visit = (prefix, value) => {
        if (!value) return;
        if (typeof value === 'object' && !Array.isArray(value) && !value.id && !value.name) {
            Object.entries(value).forEach(([key, child]) => visit(prefix ? `${prefix}.${key}` : key, child));
            return;
        }
        const emoji = parseEmojiData(value);
        if (emoji?.id) entries.push({ key: prefix, emoji });
    };
    Object.entries(MUSIC_EMOJIS).forEach(([key, value]) => visit(key, value));
    return entries;
}

function validateCustomEmojis(client = null) {
    return customEmojiEntries().filter(entry => !cachedEmoji(entry.emoji, client));
}

// ── react() — universal emoji reaction ───────────────────────────────────────
//
// _reactionCache is populated once at startup by loadMusicEmojis().
// Normal operation: Map lookup → react() → done. Zero extra API calls.
//
// Startup race (message arrives before loadMusicEmojis finishes):
//   Falls back to 'name:id' string format. _reactionFailedIds remembers
//   IDs that Discord rejected so they're never retried (no delay).
//
// If a cached emoji stops working at runtime (bot left guild, emoji deleted):
//   Cache entry is removed; next call falls through to unicode.
//
const _reactionFailedIds = new Set();

async function react(message, emojiData, fallback = null, client = null) {
    const emoji = parseEmojiData(emojiData);

    if (emoji?.id) {
        // ── Fast path: startup cache hit ─────────────────────────────────────
        if (_reactionCache.has(emoji.id)) {
            const cached = _reactionCache.get(emoji.id);
            try {
                return await message.react(cached);
            } catch {
                // Cached value no longer valid (bot left guild, emoji deleted, etc.)
                // Remove it and fall through — next call gets unicode immediately
                _reactionCache.delete(emoji.id);
                _reactionFailedIds.add(emoji.id);
            }
        }

        // ── Slow path: cache not yet populated (startup race) ─────────────────
        if (!_reactionFailedIds.has(emoji.id)) {
            const name = emoji.name || 'emoji';
            try {
                return await message.react(`${name}:${emoji.id}`);
            } catch {
                _reactionFailedIds.add(emoji.id);
            }
        }
    }

    // ── Unicode fallback — always fast, no API ambiguity ─────────────────────
    if (fallback) {
        try { return await message.react(fallback); } catch {}
    }

    return '';
}

module.exports = MUSIC_EMOJIS;
module.exports.setEmojiMap        = setEmojiMap;
module.exports.loadMusicEmojis    = loadMusicEmojis;
module.exports.emojiStr           = emojiStr;
module.exports.parseEmojiData     = parseEmojiData;
module.exports.emojiResolvable    = emojiResolvable;
module.exports.componentEmoji     = componentEmoji;
module.exports.messageEmoji       = messageEmoji;
module.exports.reactionIdentifier = reactionIdentifier;
module.exports.customEmojiEntries = customEmojiEntries;
module.exports.validateCustomEmojis = validateCustomEmojis;
module.exports.react              = react;
