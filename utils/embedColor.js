'use strict';

const { PNG } = require('pngjs');
const { Colors: fallbackColor } = require('../config');

const COLOR_CACHE_TTL = 6 * 60 * 60 * 1000;
const colorCache = new Map();
const pending = new Map();

function fallback() {
    return fallbackColor || '#7d8b7f';
}

function isExplicitColor(value) {
    return value !== undefined && value !== null;
}

function normalizeDiscordCdnUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname.endsWith('discordapp.com') || parsed.hostname.endsWith('discord.com')) {
            parsed.pathname = parsed.pathname.replace(/\.(webp|jpg|jpeg|gif)$/i, '.png');
            parsed.searchParams.set('size', '64');
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function avatarUrlFrom(source) {
    if (!source) return null;
    if (typeof source === 'string') return normalizeDiscordCdnUrl(source);

    const user = source.user || source;
    if (typeof user.displayAvatarURL === 'function') {
        return user.displayAvatarURL({
            extension: 'png',
            forceStatic: true,
            size: 64,
        });
    }

    if (typeof source.displayAvatarURL === 'function') {
        return source.displayAvatarURL({
            extension: 'png',
            forceStatic: true,
            size: 64,
        });
    }

    if (source.avatar) return normalizeDiscordCdnUrl(source.avatar);
    if (source.avatarURL) return normalizeDiscordCdnUrl(source.avatarURL);
    return null;
}

function dominantColorFromPng(buffer) {
    const png = PNG.sync.read(buffer);
    const bins = new Map();

    for (let i = 0; i < png.data.length; i += 4) {
        const alpha = png.data[i + 3];
        if (alpha < 128) continue;

        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max - min;
        const brightness = max / 255;

        // Prefer visually meaningful avatar colors over large white/gray areas.
        const weight = (1 + saturation / 128) * (0.65 + brightness * 0.35);
        const key = `${r >> 3}:${g >> 3}:${b >> 3}`;
        const bin = bins.get(key) || { weight: 0, r: 0, g: 0, b: 0 };
        bin.weight += weight;
        bin.r += r * weight;
        bin.g += g * weight;
        bin.b += b * weight;
        bins.set(key, bin);
    }

    let best = null;
    for (const bin of bins.values()) {
        if (!best || bin.weight > best.weight) best = bin;
    }

    if (!best || best.weight <= 0) return null;
    const r = Math.round(best.r / best.weight);
    const g = Math.round(best.g / best.weight);
    const b = Math.round(best.b / best.weight);
    return (r << 16) + (g << 8) + b;
}

async function fetchAvatarColor(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`avatar fetch failed: ${response.status}`);

    const type = response.headers.get('content-type') || '';
    if (!type.includes('png')) throw new Error(`unsupported avatar type: ${type || 'unknown'}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    return dominantColorFromPng(buffer);
}

async function refreshEmbedColor(source) {
    const url = avatarUrlFrom(source);
    if (!url) return fallback();

    if (pending.has(url)) return pending.get(url);

    const task = fetchAvatarColor(url)
        .then(color => {
            const resolved = color || fallback();
            colorCache.set(url, { color: resolved, expiresAt: Date.now() + COLOR_CACHE_TTL });
            return resolved;
        })
        .catch(() => fallback())
        .finally(() => pending.delete(url));

    pending.set(url, task);
    return task;
}

function getEmbedColor(source, override) {
    if (isExplicitColor(override)) return override;

    const url = avatarUrlFrom(source);
    if (!url) return fallback();

    const cached = colorCache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.color;

    refreshEmbedColor(source).catch(() => {});
    return cached?.color || fallback();
}

async function resolveEmbedColor(source, override) {
    if (isExplicitColor(override)) return override;

    const url = avatarUrlFrom(source);
    if (!url) return fallback();

    const cached = colorCache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.color;

    return refreshEmbedColor(source);
}

module.exports = {
    getEmbedColor,
    resolveEmbedColor,
    refreshEmbedColor,
};
