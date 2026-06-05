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
// Root cause: TrueMusic clients have BaseGuildEmojiManager: 0 (guild emoji
// cache is intentionally zeroed to save memory). So client.emojis.cache is
// always empty — we CANNOT rely on it for reactions.
//
// Solution: bypass the cache entirely and pass 'name:id' directly to
// message.react(). Discord's API validates access server-side. If the bot is
// in the emoji's guild (or owns the application emoji), the reaction goes
// through; otherwise Discord returns a 400 and we fall back to unicode.
//
// To prevent delay on repeated failures: failed emoji IDs are tracked in
// _reactionFailedIds. Once an ID fails, it is skipped immediately on all
// subsequent calls (zero extra API calls, zero delay).
//
const _reactionFailedIds = new Set();

async function react(message, emojiData, fallback = null, client = null) {
    const emoji = parseEmojiData(emojiData);

    if (emoji?.id) {
        const name = emoji.name || 'emoji';

        // 1. Try original ID — works when bot is in the emoji's guild.
        //    Also works for application emojis since Discord 2024 update.
        if (!_reactionFailedIds.has(emoji.id)) {
            try {
                return await message.react(`${name}:${emoji.id}`);
            } catch {
                _reactionFailedIds.add(emoji.id);
            }
        }

        // 2. Try the mapped/uploaded ID (syncMusicEmojis application emoji)
        //    Only if different from original and not already known to fail.
        const mappedId = _emojiIdMap[emoji.id];
        if (mappedId && mappedId !== emoji.id && !_reactionFailedIds.has(mappedId)) {
            try {
                return await message.react(`${name}:${mappedId}`);
            } catch {
                _reactionFailedIds.add(mappedId);
            }
        }
    }

    // 3. Unicode fallback — always fast, no API ambiguity.
    if (fallback) {
        try { return await message.react(fallback); } catch {}
    }

    return '';
}

module.exports = MUSIC_EMOJIS;
module.exports.setEmojiMap      = setEmojiMap;
module.exports.emojiStr         = emojiStr;
module.exports.parseEmojiData   = parseEmojiData;
module.exports.emojiResolvable  = emojiResolvable;
module.exports.componentEmoji   = componentEmoji;
module.exports.messageEmoji     = messageEmoji;
module.exports.reactionIdentifier = reactionIdentifier;
module.exports.customEmojiEntries = customEmojiEntries;
module.exports.validateCustomEmojis = validateCustomEmojis;
module.exports.react            = react;
