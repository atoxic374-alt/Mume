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

function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    const chroma = max - min;

    if (chroma === 0) return { h: 0, s: 0, l: lightness };

    const saturation = chroma / (1 - Math.abs((2 * lightness) - 1));
    let hue;
    if (max === rn) hue = ((gn - bn) / chroma) % 6;
    else if (max === gn) hue = ((bn - rn) / chroma) + 2;
    else hue = ((rn - gn) / chroma) + 4;

    hue *= 60;
    if (hue < 0) hue += 360;
    return { h: hue, s: saturation, l: lightness };
}

function hslToRgb(h, s, l) {
    const chroma = (1 - Math.abs((2 * l) - 1)) * s;
    const hue = h / 60;
    const x = chroma * (1 - Math.abs((hue % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;

    if (hue >= 0 && hue < 1) [r, g, b] = [chroma, x, 0];
    else if (hue < 2) [r, g, b] = [x, chroma, 0];
    else if (hue < 3) [r, g, b] = [0, chroma, x];
    else if (hue < 4) [r, g, b] = [0, x, chroma];
    else if (hue < 5) [r, g, b] = [x, 0, chroma];
    else [r, g, b] = [chroma, 0, x];

    const m = l - (chroma / 2);
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255),
    };
}

function isLikelySkinTone(r, g, b, h, s, l) {
    return h >= 8 && h <= 52 && s >= 0.18 && s <= 0.76 && l >= 0.34 && l <= 0.84 && r > g && g > b;
}

function enhanceVibrantColor(r, g, b) {
    const hsl = rgbToHsl(r, g, b);
    if (hsl.s < 0.16) return (r << 16) + (g << 8) + b;

    const next = hslToRgb(
        hsl.h,
        Math.min(0.96, Math.max(hsl.s * 1.14, hsl.s >= 0.34 ? 0.66 : hsl.s)),
        Math.min(0.62, Math.max(0.22, hsl.l)),
    );

    return (next.r << 16) + (next.g << 8) + next.b;
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
        if (lightness < 0.035 || lightness > 0.97) continue;

        const { h } = rgbToHsl(r, g, b);
        const chroma = max - min;
        const isFlatExtreme = saturation < 0.08 && (lightness < 0.05 || lightness > 0.96);
        const alphaWeight = alpha / 255;
        const saturationWeight = 0.08 + Math.pow(saturation, 2.35) * 5.2;
        const chromaWeight = 0.25 + Math.pow(chroma / 255, 1.25) * 2.1;
        const visibleWeight = 0.62 + Math.min(lightness, 1 - lightness) * 0.92;
        const skinWeight = isLikelySkinTone(r, g, b, h, saturation, lightness) ? 0.42 : 1;
        const weight = alphaWeight
            * saturationWeight
            * chromaWeight
            * visibleWeight
            * skinWeight
            * (isFlatExtreme ? 0.14 : 1);
        const key = `${r >> 3}:${g >> 3}:${b >> 3}`;
        const bin = bins.get(key) || { weight: 0, r: 0, g: 0, b: 0, saturation: 0, chroma: 0 };
        bin.weight += weight;
        bin.r += r * weight;
        bin.g += g * weight;
        bin.b += b * weight;
        bin.saturation += saturation * weight;
        bin.chroma += chroma * weight;
        bins.set(key, bin);

        if (!fallbackBin || bin.weight > fallbackBin.weight) fallbackBin = bin;
    }

    let best = null;
    for (const bin of bins.values()) {
        const avgSaturation = bin.saturation / bin.weight;
        const avgChroma = bin.chroma / bin.weight;
        const score = bin.weight * (1 + avgSaturation * 1.35 + (avgChroma / 255) * 1.05);
        if (!best || score > best.score) best = { ...bin, score };
    }

    if (!best || best.weight <= 0) best = fallbackBin;
    if (!best || best.weight <= 0) return null;
    const r = Math.round(best.r / best.weight);
    const g = Math.round(best.g / best.weight);
    const b = Math.round(best.b / best.weight);
    return enhanceVibrantColor(r, g, b);
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
