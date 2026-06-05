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

function emojiStr(data) {
    const emoji = parseEmojiData(data);
    if (!emoji) return '';
    if (!emoji.id) return emoji.name || '';
    if (!emoji.name) return emoji.id;
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

function cachedEmoji(data, client = null) {
    const emoji = parseEmojiData(data);
    if (!emoji?.id) return null;
    return client?.emojis?.cache?.get?.(emoji.id)
        || client?.application?.emojis?.cache?.get?.(emoji.id)
        || null;
}

// Returns true if the emoji exists only as an application emoji (not in any guild).
// Application emojis in reactions are not supported by third-party Discord clients
// such as Unicord, so we fall back to unicode in those cases.
function isApplicationOnlyEmoji(data, client = null) {
    const emoji = parseEmojiData(data);
    if (!emoji?.id) return false;
    const inGuild = client?.emojis?.cache?.get?.(emoji.id);
    if (inGuild) return false;
    const inApp = client?.application?.emojis?.cache?.get?.(emoji.id);
    return !!inApp;
}

function componentEmoji(data, client = null, fallback = null) {
    const emoji = parseEmojiData(data);
    if (!emoji) return fallback;
    if (!emoji.id) return emoji.name || fallback;

    const cached = cachedEmoji(data, client);
    if (cached) {
        return {
            id: cached.id,
            name: cached.name || emoji.name || 'emoji',
            animated: cached.animated === true,
        };
    }

    return {
        id: emoji.id,
        name: emoji.name || 'emoji',
        animated: emoji.animated === true,
    };
}

function messageEmoji(data, client = null, fallback = '') {
    const emoji = parseEmojiData(data);
    if (!emoji) return fallback;
    if (!emoji.id) return emoji.name || fallback;

    const cached = cachedEmoji(data, client);
    if (!cached) return fallback;
    return `<${cached.animated ? 'a' : ''}:${cached.name || emoji.name || 'emoji'}:${cached.id}>`;
}

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
        return {
            id,
            name,
            animated: data.animated === true,
        };
    }

    return null;
}

function emojiResolvable(data, client = null) {
    const emoji = parseEmojiData(data);
    if (!emoji) return null;
    if (!emoji.id) return emoji.name || null;

    const guildEmoji = client?.emojis?.cache?.get?.(emoji.id);
    if (guildEmoji) return guildEmoji;

    const appEmoji = client?.application?.emojis?.cache?.get?.(emoji.id);
    if (appEmoji) return appEmoji;

    return {
        id: emoji.id,
        name: emoji.name || 'emoji',
        animated: emoji.animated === true,
    };
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

// ── react() — universal emoji reaction with Unicord compatibility ─────────────
//
// Unicord (and other third-party Discord clients) do NOT render application
// emojis (emojis owned by the bot application, not a guild) in reactions.
// When the emoji is application-only we place the unicode fallback FIRST so
// every client sees a working reaction.  Guild emojis keep the custom-first
// order for regular Discord users.
//
async function react(message, emojiData, fallback = null, client = null) {
    const resolvedClient = client || message?.client || null;

    // Determine if this emoji is only an application emoji (no guild copy).
    // For application-only emojis, prefer the unicode fallback first so
    // third-party clients like Unicord see the reaction correctly.
    const appOnly = isApplicationOnlyEmoji(emojiData, resolvedClient);

    let candidates;
    if (appOnly && fallback) {
        // Unicord-safe order: unicode first, then custom emoji as secondary
        candidates = [
            fallback,
            cachedEmoji(emojiData, resolvedClient),
            reactionIdentifier(emojiData),
            emojiStr(emojiData),
        ].filter(Boolean);
    } else {
        // Normal order: custom emoji first, unicode fallback last
        candidates = [
            cachedEmoji(emojiData, resolvedClient),
            reactionIdentifier(emojiData),
            emojiStr(emojiData),
            fallback,
        ].filter(Boolean);
    }

    const seen = new Set();
    for (const candidate of candidates) {
        const key = typeof candidate === 'string'
            ? candidate
            : `${candidate.animated ? 'a:' : ''}${candidate.name || ''}:${candidate.id || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        try {
            return await message.react(candidate);
        } catch {}
    }

    return '';
}

module.exports = MUSIC_EMOJIS;
module.exports.emojiStr = emojiStr;
module.exports.parseEmojiData = parseEmojiData;
module.exports.emojiResolvable = emojiResolvable;
module.exports.componentEmoji = componentEmoji;
module.exports.messageEmoji = messageEmoji;
module.exports.reactionIdentifier = reactionIdentifier;
module.exports.customEmojiEntries = customEmojiEntries;
module.exports.validateCustomEmojis = validateCustomEmojis;
module.exports.react = react;
