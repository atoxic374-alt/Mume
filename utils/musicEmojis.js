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
const _emojiMapsByClientId = new Map();

function clientKey(client = null) {
    return client?.application?.id || client?.user?.id || 'global';
}

function setEmojiMap(map, client = null) {
    const clean = (map && typeof map === 'object') ? map : {};
    if (client) {
        _emojiMapsByClientId.set(clientKey(client), clean);
    } else {
        _emojiIdMap = clean;
    }
}

function emojiMapFor(client = null) {
    if (client) {
        const key = clientKey(client);
        if (_emojiMapsByClientId.has(key)) return _emojiMapsByClientId.get(key);
    }
    return _emojiIdMap;
}

function reactionCacheKey(client, emojiId) {
    return `${clientKey(client)}:${emojiId}`;
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
    const map = emojiMapFor(client);

    let byApp   = 0;
    let byStr   = 0;
    let byGuild = 0;

    // ── Method 1: Application emojis ─────────────────────────────────────────
    if (pending.size > 0) {
        try {
            const appEmojis = await client.application.emojis.fetch();
            const byId = new Map([...appEmojis.values()].map(e => [e.id, e]));

            for (const [origId, emojiData] of [...pending]) {
                // Try the original ID directly (bot may own it as an app emoji)
                if (byId.has(origId)) {
                    _reactionCache.set(reactionCacheKey(client, origId), byId.get(origId));
                    pending.delete(origId);
                    byApp++;
                    continue;
                }
                // Try the mapped/re-uploaded ID from syncMusicEmojis
                const mappedId = map[origId];
                if (mappedId && byId.has(mappedId)) {
                    _reactionCache.set(reactionCacheKey(client, origId), byId.get(mappedId));
                    pending.delete(origId);
                    byApp++;
                }
            }
        } catch { /* application emoji fetch failed */ }
    }

    // ── Method 2: Pre-built string cache ─────────────────────────────────────
    // Application emoji reactions often resolve correctly through name:id even
    // before the app cache is available, so keep a per-application string too.
    for (const [origId, emojiData] of pending) {
        const name = emojiData.name || 'emoji';
        const mappedId = map[origId];
        _reactionCache.set(reactionCacheKey(client, origId), `${name}:${mappedId || origId}`);
        byStr++;
    }

    // ── Method 3: Guild scan ─────────────────────────────────────────────────
    // If the bot can also see the original emoji in a guild, keep that object
    // as a stronger fallback for clients that reject app-emoji reactions.
    const guilds = [...(client.guilds?.cache?.values() || [])];
    for (const guild of guilds) {
        try {
            const fetched = await guild.emojis.fetch();
            for (const entry of entries) {
                const guildEmoji = fetched.get(entry.emoji.id);
                if (guildEmoji) {
                    const key = reactionCacheKey(client, entry.emoji.id);
                    if (!_reactionCache.has(key)) _reactionCache.set(key, guildEmoji);
                    byGuild++;
                }
            }
        } catch { /* guild fetch failed — try next */ }
    }

    const total = entries.length;
    console.log(
        `[MusicEmojis] startup load — ${total} emojis: ` +
        `${byApp} app ✅  ${byStr} string 🔤  ${byGuild} guild ✅`
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
    const mappedId = emojiMapFor(client)[emoji.id];
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
    const mappedId = emojiMapFor(client)[emoji.id];
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

    const mappedId = emojiMapFor(client)[emoji.id];
    return { id: mappedId || emoji.id, name: emoji.name || 'emoji', animated: emoji.animated === true };
}

function messageEmoji(data, client = null, fallback = '') {
    const emoji = parseEmojiData(data);
    if (!emoji) return fallback;
    if (!emoji.id) return emoji.name || fallback;

    // ── Primary: use the cached emoji object (guild or application) ─────────
    const cached = cachedEmoji(data, client);
    if (cached) {
        return `<${cached.animated ? 'a' : ''}:${cached.name || emoji.name || 'emoji'}:${cached.id}>`;
    }

    // ── Fallback: string format works for app-emojis even without local cache ─
    // Some bots have emojis as application-emojis that are not in the guild
    // cache yet (slow startup) — the <:name:id> string is resolved server-side
    // by Discord and renders correctly as long as the bot owns the emoji.
    const mappedId = emojiMapFor(client)[emoji.id];
    const resolvedId = (mappedId && mappedId !== emoji.id) ? mappedId : emoji.id;
    const resolvedName = emoji.name || 'emoji';
    if (resolvedId && resolvedName) {
        return `<${emoji.animated ? 'a' : ''}:${resolvedName}:${resolvedId}>`;
    }

    return fallback;
}

function emojiResolvable(data, client = null) {
    const emoji = parseEmojiData(data);
    if (!emoji) return null;
    if (!emoji.id) return emoji.name || null;

    const guildEmoji = client?.emojis?.cache?.get?.(emoji.id);
    if (guildEmoji) return guildEmoji;

    const appEmoji = client?.application?.emojis?.cache?.get?.(emoji.id);
    if (appEmoji) return appEmoji;

    const mappedId = emojiMapFor(client)[emoji.id];
    if (mappedId) {
        const mappedAppEmoji = client?.application?.emojis?.cache?.get?.(mappedId);
        if (mappedAppEmoji) return mappedAppEmoji;
        return { id: mappedId, name: emoji.name || 'emoji', animated: emoji.animated === true };
    }

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
    const map = emojiMapFor(client);
    return customEmojiEntries().filter(entry => !cachedEmoji(entry.emoji, client) && !map[entry.emoji.id]);
}

// ── react() — universal emoji reaction ───────────────────────────────────────
//
// _reactionCache is populated once at startup by loadMusicEmojis().
// Normal operation: Map lookup → react() → done. Zero extra API calls.
//
// Startup race (message arrives before loadMusicEmojis finishes):
//   Falls back to 'name:mappedId' or 'name:id' string format.
//   _reactionFailedIds remembers IDs that Discord rejected; it is cleared
//   every 30 minutes so temporary failures don't become permanent.
//
// If a cached emoji object fails at runtime:
//   Try 'name:id' string format before giving up, then fall to unicode.
//
const _reactionFailedIds = new Set();

// Clear the failed-IDs set every 30 minutes so transient failures self-heal
setInterval(() => _reactionFailedIds.clear(), 30 * 60 * 1000);

async function react(message, emojiData, fallback = null, client = null) {
    const emoji = parseEmojiData(emojiData);

    if (emoji?.id) {
        // ── Fast path: startup cache hit ─────────────────────────────────────
        const cacheKey = reactionCacheKey(client, emoji.id);
        if (_reactionCache.has(cacheKey)) {
            const cached = _reactionCache.get(cacheKey);
            try {
                return await message.react(cached);
            } catch {
                // Object-based react failed — try name:id string format.
                // Application emojis often need the string form for reactions.
                if (cached && typeof cached === 'object' && cached.id) {
                    try {
                        const reactName = cached.name || emoji.name || 'emoji';
                        return await message.react(`${reactName}:${cached.id}`);
                    } catch {
                        // String form also failed — evict cache entry
                    }
                }
                _reactionCache.delete(cacheKey);
                _reactionFailedIds.add(emoji.id);
            }
        }

        // ── Slow path: cache not yet populated (startup race) ─────────────────
        if (!_reactionFailedIds.has(emoji.id)) {
            const name = emoji.name || 'emoji';
            // Prefer the mapped application emoji ID so Discord can resolve it
            const mappedId = emojiMapFor(client)[emoji.id];
            if (mappedId && mappedId !== emoji.id) {
                try {
                    return await message.react(`${name}:${mappedId}`);
                } catch { /* fall through to original ID */ }
            }
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
