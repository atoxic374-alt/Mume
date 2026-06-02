'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
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
            parsed.searchParams.set('size', '256');
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
            size: 256,
        });
    }

    if (typeof source.displayAvatarURL === 'function') {
        return source.displayAvatarURL({
            extension: 'png',
            forceStatic: true,
            size: 256,
        });
    }

    if (source.avatar) return normalizeDiscordCdnUrl(source.avatar);
    if (source.avatarURL) return normalizeDiscordCdnUrl(source.avatarURL);
    return null;
}

function dominantColorFromPixels(data, width, height) {
    const bins = new Map();
    let fallbackBin = null;
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const radius = Math.min(width, height) / 2;
    const radiusSq = radius * radius;

    for (let i = 0; i < data.length; i += 4) {
        const pixel = i / 4;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const dx = x - cx;
        const dy = y - cy;
        if ((dx * dx) + (dy * dy) > radiusSq) continue;

        const alpha = data[i + 3];
        if (alpha < 96) continue;

        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        const lightness = (max + min) / 510;
        const isFlatExtreme = saturation < 0.08 && (lightness < 0.05 || lightness > 0.96);
        const alphaWeight = alpha / 255;
        const saturationWeight = 0.55 + saturation * 1.45;
        const visibleWeight = 0.7 + Math.min(lightness, 1 - lightness) * 0.6;
        const weight = alphaWeight * saturationWeight * visibleWeight * (isFlatExtreme ? 0.18 : 1);
        const key = `${r >> 4}:${g >> 4}:${b >> 4}`;
        const bin = bins.get(key) || { weight: 0, r: 0, g: 0, b: 0 };
        bin.weight += weight;
        bin.r += r * weight;
        bin.g += g * weight;
        bin.b += b * weight;
        bins.set(key, bin);

        if (!fallbackBin || bin.weight > fallbackBin.weight) fallbackBin = bin;
    }

    let best = null;
    for (const bin of bins.values()) {
        if (!best || bin.weight > best.weight) best = bin;
    }

    if (!best || best.weight <= 0) best = fallbackBin;
    if (!best || best.weight <= 0) return null;
    const r = Math.round(best.r / best.weight);
    const g = Math.round(best.g / best.weight);
    const b = Math.round(best.b / best.weight);
    return (r << 16) + (g << 8) + b;
}

async function dominantColorFromImage(buffer) {
    const image = await loadImage(buffer);
    const size = 160;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    return dominantColorFromPixels(data, size, size);
}

async function fetchAvatarColor(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`avatar fetch failed: ${response.status}`);

    const type = response.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error(`unsupported avatar type: ${type || 'unknown'}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    return dominantColorFromImage(buffer);
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
