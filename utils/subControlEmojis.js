'use strict';

const crypto = require('crypto');
const { tintPngBuffer } = require('./tintedThumbnail');

function sourceEntries(musicEmojis) {
    return {
        previous: { key: 'previous', emoji: musicEmojis.previous || musicEmojis.prev, fallback: '⏮️' },
        stop: { key: 'stop', emoji: musicEmojis.stop, fallback: '⏹️' },
        pause: { key: 'pause', emoji: musicEmojis.pause, fallback: '⏯️' },
        skip: { key: 'skip', emoji: musicEmojis.skip, fallback: '⏭️' },
        volumeDown: { key: 'volumeDown', emoji: musicEmojis.volumeDown, fallback: '🔉' },
        loop: { key: 'loop', emoji: musicEmojis.loop, fallback: '🔁' },
        queue: { key: 'queue', emoji: musicEmojis.queue, fallback: '📜' },
        volumeUp: { key: 'volumeUp', emoji: musicEmojis.volumeUp, fallback: '🔊' },
        like: { key: 'like', emoji: musicEmojis.like, fallback: '👍' },
        dislike: { key: 'dislike', emoji: musicEmojis.dislike, fallback: '👎' },
    };
}

function cleanName(value) {
    const raw = String(value || '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 18) || 'sub';
    return `sub_${raw}_${crypto.randomBytes(3).toString('hex')}`.slice(0, 32);
}

function emojiId(emoji) {
    return emoji?.id ? String(emoji.id) : null;
}

async function downloadPng(id) {
    const response = await fetch(`https://cdn.discordapp.com/emojis/${id}.png?size=128&quality=lossless`);
    if (!response.ok) throw new Error(`Discord CDN returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function createWithRetry(emojis, payload) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await emojis.create(payload);
        } catch (error) {
            lastError = error;
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 700 * attempt));
        }
    }
    throw lastError;
}

async function createTintedControlEmojis(client, musicEmojis, color, previousMap = {}) {
    if (!client?.application?.emojis) throw new Error('البوت لا يستطيع إدارة Application Emojis.');
    const entries = sourceEntries(musicEmojis);
    const next = {};
    const createdIds = [];
    const oldIds = Object.values(previousMap || {}).map(emojiId).filter(Boolean);
    try {
        const downloaded = await Promise.all(Object.entries(entries).map(async ([key, entry]) => {
            const sourceId = emojiId(entry.emoji);
            if (!sourceId) return { key, entry, tinted: null };
            const png = await downloadPng(sourceId);
            return { key, entry, tinted: tintPngBuffer(png, color) };
        }));

        // Downloads run in parallel; creates stay sequential per application to respect Discord limits.
        for (const { key, entry, tinted } of downloaded) {
            if (!tinted) {
                next[key] = { unicode: entry.fallback };
                continue;
            }
            const created = await createWithRetry(client.application.emojis, {
                name: cleanName(`${client.user?.id || 'bot'}_${key}`),
                attachment: tinted,
            });
            createdIds.push(created.id);
            next[key] = { id: created.id, name: created.name };
        }

        // New set is complete. Only now remove the old set and make the replacement visible.
        for (const id of oldIds) await client.application.emojis.delete(id).catch(() => {});
        return next;
    } catch (error) {
        // Preserve the old working set if any download/create step failed.
        await Promise.all(createdIds.map(id => client.application.emojis.delete(id).catch(() => {})));
        throw error;
    }
}

function controlEmojiData(map, key, fallback) {
    const item = map?.[key];
    if (item?.id && item?.name) return { id: item.id, name: item.name };
    return item?.unicode || fallback;
}

module.exports = {
    createTintedControlEmojis,
    controlEmojiData,
};
