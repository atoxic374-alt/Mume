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

function buildProgressBarAttachment({ position = 0, duration = 0, color, width = 1100, height = 76 } = {}) {
    const base = colorParts(color);
    const light = mixColor(base, { r: 255, g: 255, b: 255 }, 0.14);
    const dark = mixColor(base, { r: 0, g: 0, b: 0 }, 0.30);
    const durationMs = Number(duration || 0);
    const positionMs = Number(position || 0);
    const ratio = durationMs > 0 ? clamp(positionMs / durationMs, 0, 1) : 0;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, width, height);

    const railX = 54;
    const railW = width - railX * 2;
    const railH = 10;
    const railY = Math.round((height - railH) / 2);
    const radius = railH / 2;
    const knobRadius = 18;
    const fillW = railW * ratio;
    const knobX = railX + fillW;
    const knobY = railY + railH / 2;

    const bg = ctx.createLinearGradient(railX, railY, railX + railW, railY);
    bg.addColorStop(0, rgba(base, 0.11));
    bg.addColorStop(0.5, rgba(base, 0.07));
    bg.addColorStop(1, rgba(base, 0.10));
    ctx.fillStyle = bg;
    fillRoundedRect(ctx, railX, railY, railW, railH, radius);

    ctx.save();
    roundedRectPath(ctx, railX, railY, railW, railH, radius);
    ctx.clip();
    ctx.strokeStyle = rgba(light, 0.20);
    ctx.lineWidth = 3;
    for (let x = railX - 40; x < railX + railW + 40; x += 34) {
        ctx.beginPath();
        ctx.moveTo(x, railY + railH + 3);
        ctx.lineTo(x + 18, railY - 3);
        ctx.stroke();
    }
    ctx.restore();

    if (fillW > 0.5) {
        const fill = ctx.createLinearGradient(railX, railY, railX + railW, railY);
        fill.addColorStop(0, rgba(base, 1));
        fill.addColorStop(0.55, rgba(light, 1));
        fill.addColorStop(1, rgba(dark, 1));

        ctx.save();
        ctx.shadowColor = rgba(base, 0.42);
        ctx.shadowBlur = 6;
        ctx.fillStyle = fill;
        fillRoundedRect(ctx, railX, railY, fillW, railH, radius);
        ctx.restore();

        ctx.save();
        roundedRectPath(ctx, railX, railY, Math.max(fillW, railH), railH, radius);
        ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 3;
        for (let x = railX - 30; x < railX + fillW + 40; x += 34) {
            ctx.beginPath();
            ctx.moveTo(x, railY + railH + 3);
            ctx.lineTo(x + 18, railY - 3);
            ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.20)';
        fillRoundedRect(ctx, railX + 4, railY + 3, Math.max(0, fillW - 8), 3, 2);
        ctx.restore();
    }

    ctx.save();
    ctx.shadowColor = rgba(base, 0.62);
    ctx.shadowBlur = 12;
    const knob = ctx.createRadialGradient(knobX - 7, knobY - 8, 2, knobX, knobY, knobRadius);
    knob.addColorStop(0, rgba(light, 1));
    knob.addColorStop(0.48, rgba(base, 1));
    knob.addColorStop(1, rgba(dark, 1));
    ctx.fillStyle = knob;
    ctx.beginPath();
    ctx.arc(knobX, knobY, knobRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(knobX, knobY, knobRadius - 1.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(knobX - 8, knobY - 9, 5, 0, Math.PI * 2);
    ctx.fill();

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
