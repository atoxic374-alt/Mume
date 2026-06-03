'use strict';

const { createCanvas } = require('@napi-rs/canvas');

const PROGRESS_CACHE_MAX_ENTRIES = 768;
const PROGRESS_CACHE_MAX_BYTES = 12 * 1024 * 1024;
const PROGRESS_CACHE_TTL_MS = 10 * 60 * 1000;
const progressCache = new Map();
let progressCacheBytes = 0;

function normalizeColorNumber(input) {
    if (typeof input === 'number' && Number.isFinite(input)) {
        return input & 0xFFFFFF;
    }

    const raw = String(input || '').trim();
    if (!raw) return 0x7d8b7f;

    const hex = raw.startsWith('#') ? raw.slice(1) : raw.replace(/^0x/i, '');
    const parsed = parseInt(hex, 16);
    return Number.isFinite(parsed) ? parsed & 0xFFFFFF : 0x7d8b7f;
}

function colorParts(input) {
    const value = normalizeColorNumber(input);
    return {
        value,
        hex: value.toString(16).padStart(6, '0'),
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function rgba({ r, g, b }, alpha) {
    return `rgba(${r},${g},${b},${alpha})`;
}

function mixChannel(a, b, ratio) {
    return Math.round(a + (b - a) * ratio);
}

function mixColor(color, target, ratio) {
    return {
        r: mixChannel(color.r, target.r, ratio),
        g: mixChannel(color.g, target.g, ratio),
        b: mixChannel(color.b, target.b, ratio),
    };
}

function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function fillRoundedRect(ctx, x, y, width, height, radius) {
    if (width <= 0 || height <= 0) return;
    roundedRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
}

function compactLabelKey(currentLabel, durationLabel) {
    return `${currentLabel || 'x'}-${durationLabel || 'x'}`
        .replace(/[^a-z0-9]+/gi, '')
        .slice(0, 24) || 'labels';
}

function progressCacheGet(key) {
    const entry = progressCache.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
        progressCache.delete(key);
        progressCacheBytes -= entry.bytes;
        return null;
    }

    progressCache.delete(key);
    progressCache.set(key, entry);
    return {
        attachment: entry.attachment,
        name: entry.name,
        ratio: entry.ratio,
        cacheHit: true,
    };
}

function trimProgressCache() {
    while (
        progressCache.size > PROGRESS_CACHE_MAX_ENTRIES
        || progressCacheBytes > PROGRESS_CACHE_MAX_BYTES
    ) {
        const oldestKey = progressCache.keys().next().value;
        if (!oldestKey) break;
        const oldest = progressCache.get(oldestKey);
        progressCache.delete(oldestKey);
        progressCacheBytes -= oldest?.bytes || 0;
    }
}

function progressCacheSet(key, result) {
    if (!result?.attachment?.length) return result;
    const bytes = result.attachment.length;
    if (bytes > PROGRESS_CACHE_MAX_BYTES) return result;

    const old = progressCache.get(key);
    if (old) {
        progressCache.delete(key);
        progressCacheBytes -= old.bytes;
    }

    progressCache.set(key, {
        attachment: result.attachment,
        name: result.name,
        ratio: result.ratio,
        bytes,
        expiresAt: Date.now() + PROGRESS_CACHE_TTL_MS,
    });
    progressCacheBytes += bytes;
    trimProgressCache();
    return result;
}

function buildProgressBarAttachment({ position = 0, duration = 0, color, currentLabel = '', durationLabel = '', width = 860, height = 58, variant = 'default' } = {}) {
    const base = colorParts(color);
    const light = mixColor(base, { r: 255, g: 255, b: 255 }, 0.10);
    const dark = mixColor(base, { r: 0, g: 0, b: 0 }, 0.30);
    const durationMs = Number(duration || 0);
    const positionMs = Number(position || 0);
    const ratio = durationMs > 0 ? clamp(positionMs / durationMs, 0, 1) : 0;
    const bucket = durationMs > 0 ? Math.round(ratio * 1000) : 0;
    const labelKey = compactLabelKey(currentLabel, durationLabel);
    const cacheKey = [
        variant,
        base.hex,
        width,
        height,
        bucket,
        currentLabel || '',
        durationLabel || '',
    ].join('|');
    const cached = progressCacheGet(cacheKey);
    if (cached) return cached;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, width, height);

    if (variant === 'discordCompact') {
        // ── Discord-style single-row layout ──────────────────────────────
        // [currentTime]  ────────●─────────────────────  [totalTime]
        //
        // Height is caller-supplied (min 52 so knob r=10 and 24px font fit).
        const W = width;
        const H = Math.max(52, height);

        const FONT         = 'bold 24px sans-serif';
        const GUTTER       = 14;   // px between label and rail edge
        const RAIL_H       = 6;
        const KNOB_R       = 10;
        const LABEL_COLOR  = 'rgba(240,242,246,0.98)';
        const LABEL_BG     = 'rgba(10,11,14,0.62)';
        const RAIL_BG      = 'rgba(65,69,73,0.90)';      // Discord dark input bg
        const LABEL_SHADOW = 'rgba(0,0,0,0.0)';

        // Resize canvas to the canonical height
        const cDisc = createCanvas(W, H);
        const cx    = cDisc.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.clearRect(0, 0, W, H);
        cx.font          = FONT;
        cx.textBaseline  = 'middle';

        // Measure labels (fall back to fixed width if empty or font unmeasurable)
        const MIN_LABEL_W = 44;
        const curW  = currentLabel  ? Math.max(MIN_LABEL_W, Math.ceil(cx.measureText(currentLabel).width)  + 4) : 0;
        const totW  = durationLabel ? Math.max(MIN_LABEL_W, Math.ceil(cx.measureText(durationLabel).width) + 4) : 0;

        // Rail geometry
        const railX  = (curW  > 0 ? curW  + GUTTER * 2 : GUTTER);
        const railEnd = W - (totW > 0 ? totW + GUTTER * 2 : GUTTER);
        const railW  = Math.max(20, railEnd - railX);
        const railY  = Math.round((H - RAIL_H) / 2);
        const railR  = RAIL_H / 2;
        const fillW  = Math.max(0, Math.min(railW, railW * ratio));
        const knobX  = Math.max(railX + KNOB_R, Math.min(railX + fillW, railEnd - KNOB_R));
        const knobY  = railY + RAIL_H / 2;   // vertical center of rail

        // ── Draw current-time label (left) ───────────────────────────────
        if (currentLabel) {
            const PAD_X = 6, PAD_Y = 4;
            const bgW = curW + PAD_X * 2;
            const bgH = 30;
            const bgX = 0;
            const bgY = Math.round((H - bgH) / 2);
            cx.save();
            cx.fillStyle = LABEL_BG;
            fillRoundedRect(cx, bgX, bgY, bgW, bgH, 6);
            cx.textAlign   = 'right';
            cx.shadowColor = LABEL_SHADOW;
            cx.shadowBlur  = 0;
            cx.fillStyle   = LABEL_COLOR;
            cx.fillText(currentLabel, bgW - PAD_X, H / 2);
            cx.restore();
        }

        // ── Draw rail background ─────────────────────────────────────────
        cx.fillStyle = RAIL_BG;
        fillRoundedRect(cx, railX, railY, railW, RAIL_H, railR);

        // ── Draw fill ────────────────────────────────────────────────────
        if (fillW > 1) {
            cx.save();
            cx.fillStyle   = rgba(base, 0.97);
            cx.shadowColor = rgba(base, 0.35);
            cx.shadowBlur  = 3;
            fillRoundedRect(cx, railX, railY, fillW, RAIL_H, railR);
            cx.restore();
        }

        // ── Draw knob ────────────────────────────────────────────────────
        cx.save();
        cx.shadowColor = 'rgba(0,0,0,0.45)';
        cx.shadowBlur  = 4;
        cx.fillStyle   = 'rgba(254,254,255,0.98)';
        cx.beginPath();
        cx.arc(knobX, knobY, KNOB_R, 0, Math.PI * 2);
        cx.fill();
        cx.restore();

        // subtle ring on knob using accent color
        cx.strokeStyle = rgba(light, 0.55);
        cx.lineWidth   = 1.2;
        cx.beginPath();
        cx.arc(knobX, knobY, KNOB_R - 0.6, 0, Math.PI * 2);
        cx.stroke();

        // ── Draw total-duration label (right) ────────────────────────────
        if (durationLabel) {
            const PAD_X = 6;
            const bgW = totW + PAD_X * 2;
            const bgH = 30;
            const bgX = W - bgW;
            const bgY = Math.round((H - bgH) / 2);
            cx.save();
            cx.fillStyle = LABEL_BG;
            fillRoundedRect(cx, bgX, bgY, bgW, bgH, 6);
            cx.textAlign   = 'left';
            cx.shadowColor = LABEL_SHADOW;
            cx.shadowBlur  = 0;
            cx.fillStyle   = LABEL_COLOR;
            cx.fillText(durationLabel, bgX + PAD_X, H / 2);
            cx.restore();
        }

        return progressCacheSet(cacheKey, {
            attachment: cDisc.toBuffer('image/png'),
            name: `progress-compact-v4-${base.hex}-${W}x${H}-${bucket}-${labelKey}.png`,
            ratio,
        });
    }

    const railX = currentLabel ? 96 : 24;
    const railW = width - railX - (durationLabel ? 96 : 24);
    const railH = 18;
    const railY = Math.round((height - railH) / 2);
    const radius = 4;
    const knobRadius = railH / 2;
    const fillW = railW * ratio;
    const knobX = railX + fillW;
    const knobY = railY + railH / 2;

    if (currentLabel || durationLabel) {
        ctx.font = '600 25px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(242,243,248,0.92)';
        ctx.textAlign = 'left';
        if (currentLabel) ctx.fillText(currentLabel, 0, height / 2);
        ctx.textAlign = 'right';
        if (durationLabel) ctx.fillText(durationLabel, width, height / 2);
    }

    const bg = ctx.createLinearGradient(railX, railY, railX + railW, railY);
    bg.addColorStop(0, 'rgba(96,99,109,0.34)');
    bg.addColorStop(1, 'rgba(96,99,109,0.26)');
    ctx.fillStyle = bg;
    fillRoundedRect(ctx, railX, railY, railW, railH, radius);

    if (fillW > 0.5) {
        const fill = ctx.createLinearGradient(railX, railY, railX + railW, railY);
        fill.addColorStop(0, rgba(base, 1));
        fill.addColorStop(0.72, rgba(light, 1));
        fill.addColorStop(1, rgba(dark, 1));

        ctx.save();
        ctx.shadowColor = rgba(base, 0.28);
        ctx.shadowBlur = 4;
        ctx.fillStyle = fill;
        fillRoundedRect(ctx, railX, railY, fillW, railH, radius);
        ctx.restore();
    }

    ctx.save();
    ctx.shadowColor = rgba(base, 0.34);
    ctx.shadowBlur = 5;
    ctx.fillStyle = 'rgba(248,249,255,0.96)';
    ctx.beginPath();
    ctx.arc(knobX, knobY, knobRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = rgba(base, 0.72);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(knobX, knobY, knobRadius - 1, 0, Math.PI * 2);
    ctx.stroke();

    return progressCacheSet(cacheKey, {
        attachment: canvas.toBuffer('image/png'),
        name: `progress-${base.hex}-${bucket}.png`,
        ratio,
    });
}

module.exports = {
    buildProgressBarAttachment,
    normalizeColorNumber,
};
