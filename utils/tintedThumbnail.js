'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas, Image } = require('@napi-rs/canvas');

const cache = new Map();
const MAX_CACHE_ITEMS = 160;

function normalizeColor(input) {
    if (typeof input === 'number' && Number.isFinite(input)) {
        return input & 0xFFFFFF;
    }

    const raw = String(input || '').trim();
    if (!raw) return 0x7d8b7f;

    const hex = raw.startsWith('#') ? raw.slice(1) : raw.replace(/^0x/i, '');
    const parsed = parseInt(hex, 16);
    return Number.isFinite(parsed) ? parsed & 0xFFFFFF : 0x7d8b7f;
}

function colorParts(color) {
    const value = normalizeColor(color);
    return {
        value,
        hex: value.toString(16).padStart(6, '0'),
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

function clearOldCacheEntry() {
    if (cache.size < MAX_CACHE_ITEMS) return;
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
}

function blendChannel(target, sourceLuma, targetLuma) {
    const shade = 0.72 + (sourceLuma / 255) * 0.48;
    const contrastLift = targetLuma < 80 ? 18 : targetLuma > 190 ? -16 : 0;
    return Math.max(0, Math.min(255, Math.round(target * shade + contrastLift)));
}

function setupIconPaint(ctx, r, g, b, width) {
    ctx.clearRect(0, 0, width, width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = width * 0.035;
    ctx.shadowOffsetY = width * 0.014;
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
}

function strokeCircleArrow(ctx, x, y, radius, start, end, ccw = false) {
    ctx.beginPath();
    ctx.arc(x, y, radius, start, end, ccw);
    ctx.stroke();
    const angle = end;
    const ax = x + Math.cos(angle) * radius;
    const ay = y + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - Math.cos(angle - 0.8) * radius * 0.18, ay - Math.sin(angle - 0.8) * radius * 0.18);
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - Math.cos(angle + 0.8) * radius * 0.18, ay - Math.sin(angle + 0.8) * radius * 0.18);
    ctx.stroke();
}

function drawMusicNote(ctx, s, x = 0, y = 0, scale = 1) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.lineWidth = s * 0.045;
    ctx.beginPath();
    ctx.moveTo(s * 0.56, s * 0.20);
    ctx.lineTo(s * 0.56, s * 0.66);
    ctx.moveTo(s * 0.72, s * 0.16);
    ctx.lineTo(s * 0.72, s * 0.58);
    ctx.moveTo(s * 0.56, s * 0.20);
    ctx.lineTo(s * 0.72, s * 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(s * 0.45, s * 0.70, s * 0.11, s * 0.08, -0.35, 0, Math.PI * 2);
    ctx.ellipse(s * 0.61, s * 0.62, s * 0.11, s * 0.08, -0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawFallbackIcon(ctx, fileName, width, r, g, b) {
    const name = String(fileName || '').toLowerCase();
    const s = width;
    setupIconPaint(ctx, r, g, b, s);
    ctx.lineWidth = s * 0.055;

    if (name.includes('error')) {
        ctx.beginPath();
        ctx.moveTo(s * 0.50, s * 0.15);
        ctx.lineTo(s * 0.86, s * 0.78);
        ctx.lineTo(s * 0.14, s * 0.78);
        ctx.closePath();
        ctx.stroke();
        ctx.lineWidth = s * 0.06;
        ctx.beginPath();
        ctx.moveTo(s * 0.50, s * 0.36);
        ctx.lineTo(s * 0.50, s * 0.57);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(s * 0.50, s * 0.68, s * 0.025, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    if (name.includes('skip')) {
        ctx.beginPath();
        ctx.moveTo(s * 0.19, s * 0.23);
        ctx.lineTo(s * 0.47, s * 0.50);
        ctx.lineTo(s * 0.19, s * 0.77);
        ctx.closePath();
        ctx.moveTo(s * 0.47, s * 0.23);
        ctx.lineTo(s * 0.75, s * 0.50);
        ctx.lineTo(s * 0.47, s * 0.77);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(s * 0.82, s * 0.24);
        ctx.lineTo(s * 0.82, s * 0.76);
        ctx.stroke();
        return;
    }

    if (name.includes('volume')) {
        ctx.beginPath();
        ctx.moveTo(s * 0.17, s * 0.42);
        ctx.lineTo(s * 0.31, s * 0.42);
        ctx.lineTo(s * 0.49, s * 0.26);
        ctx.lineTo(s * 0.49, s * 0.74);
        ctx.lineTo(s * 0.31, s * 0.58);
        ctx.lineTo(s * 0.17, s * 0.58);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = s * 0.045;
        ctx.beginPath();
        ctx.arc(s * 0.52, s * 0.50, s * 0.13, -0.65, 0.65);
        ctx.stroke();
        if (!name.includes('dowwn') && !name.includes('down')) {
            ctx.beginPath();
            ctx.arc(s * 0.52, s * 0.50, s * 0.24, -0.60, 0.60);
            ctx.stroke();
        }
        return;
    }

    if (name.includes('loop')) {
        ctx.lineWidth = s * 0.05;
        strokeCircleArrow(ctx, s * 0.50, s * 0.50, s * 0.24, Math.PI * 0.15, Math.PI * 1.25);
        strokeCircleArrow(ctx, s * 0.50, s * 0.50, s * 0.24, Math.PI * 1.15, Math.PI * 2.25);
        if (name.includes('off')) {
            ctx.lineWidth = s * 0.07;
            ctx.beginPath();
            ctx.moveTo(s * 0.24, s * 0.78);
            ctx.lineTo(s * 0.78, s * 0.24);
            ctx.stroke();
        }
        return;
    }

    if (name.includes('seek')) {
        ctx.lineWidth = s * 0.045;
        ctx.beginPath();
        ctx.arc(s * 0.50, s * 0.50, s * 0.30, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s * 0.50, s * 0.50);
        ctx.lineTo(s * 0.50, s * 0.31);
        ctx.moveTo(s * 0.50, s * 0.50);
        ctx.lineTo(s * 0.66, s * 0.59);
        ctx.stroke();
        return;
    }

    if (name.includes('auto')) {
        ctx.beginPath();
        ctx.moveTo(s * 0.39, s * 0.30);
        ctx.lineTo(s * 0.70, s * 0.50);
        ctx.lineTo(s * 0.39, s * 0.70);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = s * 0.045;
        strokeCircleArrow(ctx, s * 0.50, s * 0.50, s * 0.32, Math.PI * 1.12, Math.PI * 0.12);
        return;
    }

    drawMusicNote(ctx, s);

    if (name.includes('add')) {
        ctx.lineWidth = s * 0.05;
        ctx.beginPath();
        ctx.moveTo(s * 0.73, s * 0.70);
        ctx.lineTo(s * 0.88, s * 0.70);
        ctx.moveTo(s * 0.805, s * 0.625);
        ctx.lineTo(s * 0.805, s * 0.775);
        ctx.stroke();
    }
}

function tintPngFile(filePath, color) {
    const resolvedPath = path.resolve(filePath);
    const stat = fs.statSync(resolvedPath);
    const { value, hex, r, g, b } = colorParts(color);
    const cacheKey = `${resolvedPath}:${stat.mtimeMs}:${stat.size}:${value}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const image = new Image();
    image.src = fs.readFileSync(resolvedPath);
    const width = image.width || 512;
    const height = image.height || 512;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, width, height);

    const img = ctx.getImageData(0, 0, width, height);
    const data = img.data;
    const targetLuma = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
    let visiblePixels = 0;

    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (!alpha) continue;
        visiblePixels++;

        const sourceLuma = (data[i] * 0.2126) + (data[i + 1] * 0.7152) + (data[i + 2] * 0.0722);
        data[i] = blendChannel(r, sourceLuma, targetLuma);
        data[i + 1] = blendChannel(g, sourceLuma, targetLuma);
        data[i + 2] = blendChannel(b, sourceLuma, targetLuma);
    }

    if (visiblePixels < 64) {
        drawFallbackIcon(ctx, path.basename(resolvedPath), width, r, g, b);
    } else {
        ctx.putImageData(img, 0, 0);
    }

    const parsed = path.parse(resolvedPath);
    const result = {
        attachment: canvas.toBuffer('image/png'),
        name: `${parsed.name}-${hex}.png`,
    };

    clearOldCacheEntry();
    cache.set(cacheKey, result);
    return result;
}

function tintAttachmentPayload(payload, color) {
    if (!Array.isArray(payload.files) || !payload.files.length) return payload;

    // Find the attachment thumbnail URL — check top-level first, then first embed
    let thumbnailUrl = payload.thumbnail || null;
    let embedRef = null;

    if (!thumbnailUrl) {
        const firstEmbed = payload.embeds?.[0];
        if (firstEmbed) {
            const data = typeof firstEmbed.toJSON === 'function'
                ? firstEmbed.toJSON()
                : (firstEmbed.data || firstEmbed);
            thumbnailUrl = data?.thumbnail?.url || null;
            if (thumbnailUrl && typeof firstEmbed.setThumbnail === 'function') {
                embedRef = firstEmbed;
            }
        }
    }

    if (!thumbnailUrl) return payload;

    const match = String(thumbnailUrl).match(/^attachment:\/\/(.+)$/i);
    if (!match) return payload;

    const requestedName = match[1];
    const index = payload.files.findIndex(file => {
        if (typeof file !== 'string') return false;
        return path.basename(file).toLowerCase() === requestedName.toLowerCase();
    });

    if (index === -1) return payload;

    try {
        const tinted = tintPngFile(payload.files[index], color);
        const nextFiles = [...payload.files];
        nextFiles[index] = tinted;
        const tintedUrl = `attachment://${tinted.name}`;

        if (embedRef) embedRef.setThumbnail(tintedUrl);

        return {
            ...payload,
            ...(payload.thumbnail ? { thumbnail: tintedUrl } : {}),
            files: nextFiles,
        };
    } catch (err) {
        console.warn(`[ThumbnailTint] failed: ${err?.message || err}`);
        return payload;
    }
}

module.exports = {
    tintAttachmentPayload,
    tintPngFile,
};
