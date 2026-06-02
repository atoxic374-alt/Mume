'use strict';

const { createCanvas } = require('@napi-rs/canvas');

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

function buildProgressBarAttachment({ position = 0, duration = 0, color, currentLabel = '', durationLabel = '', width = 860, height = 58, variant = 'default' } = {}) {
    const base = colorParts(color);
    const light = mixColor(base, { r: 255, g: 255, b: 255 }, 0.10);
    const dark = mixColor(base, { r: 0, g: 0, b: 0 }, 0.30);
    const durationMs = Number(duration || 0);
    const positionMs = Number(position || 0);
    const ratio = durationMs > 0 ? clamp(positionMs / durationMs, 0, 1) : 0;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, width, height);

    if (variant === 'discordCompact') {
        // Single-row: [currentTime] [====●────────────] [totalTime]
        ctx.font = '600 18px sans-serif';
        ctx.textBaseline = 'middle';

        const cy = height / 2;
        const railH = 8;
        const railY = Math.round(cy - railH / 2);
        const radius = railH / 2;
        const knobRadius = 8;

        const currentW = currentLabel ? Math.ceil(ctx.measureText(currentLabel).width) + 14 : 0;
        const durationW = durationLabel ? Math.ceil(ctx.measureText(durationLabel).width) + 14 : 0;
        const railX = currentW;
        const railW = Math.max(40, width - railX - durationW);
        const fillW = railW * ratio;
        const knobX = railX + fillW;
        const knobY = cy;

        // Current time — left of bar
        if (currentLabel) {
            ctx.fillStyle = 'rgba(159,159,167,0.98)';
            ctx.textAlign = 'left';
            ctx.fillText(currentLabel, 0, cy);
        }

        // Empty rail — #323234
        ctx.fillStyle = 'rgba(50,50,52,0.96)';
        fillRoundedRect(ctx, railX, railY, railW, railH, radius);

        // Filled portion — #9d9ad1 purple/lavender
        if (fillW > 0.5) {
            ctx.fillStyle = 'rgba(157,154,209,0.98)';
            fillRoundedRect(ctx, railX, railY, fillW, railH, radius);
        }

        // Knob — white #fefdff
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.32)';
        ctx.shadowBlur = 3;
        ctx.fillStyle = 'rgba(254,253,255,0.97)';
        ctx.beginPath();
        ctx.arc(knobX, knobY, knobRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Total time — right of bar
        if (durationLabel) {
            ctx.fillStyle = 'rgba(159,159,167,0.98)';
            ctx.textAlign = 'right';
            ctx.fillText(durationLabel, width, cy);
        }

        const bucket = durationMs > 0 ? Math.round(ratio * 1000) : 0;
        return {
            attachment: canvas.toBuffer('image/png'),
            name: `progress-compact-${base.hex}-${bucket}.png`,
            ratio,
        };
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

    const bucket = durationMs > 0 ? Math.round(ratio * 1000) : 0;
    return {
        attachment: canvas.toBuffer('image/png'),
        name: `progress-${base.hex}-${bucket}.png`,
        ratio,
    };
}

module.exports = {
    buildProgressBarAttachment,
    normalizeColorNumber,
};
