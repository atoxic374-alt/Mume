'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

let crcTable = null;

function crc32(buffer) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[n] = c >>> 0;
        }
    }

    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc = crcTable[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function readChunks(buffer) {
    const signature = '89504e470d0a1a0a';
    if (!Buffer.isBuffer(buffer) || buffer.slice(0, 8).toString('hex') !== signature) {
        throw new Error('not a PNG file');
    }

    const chunks = [];
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) throw new Error('truncated PNG chunk');
        chunks.push({ type, data: buffer.slice(dataStart, dataEnd) });
        offset = dataEnd + 4;
        if (type === 'IEND') break;
    }
    return chunks;
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function decodePngToRgba(buffer) {
    const chunks = readChunks(buffer);
    const ihdr = chunks.find(chunk => chunk.type === 'IHDR')?.data;
    if (!ihdr) throw new Error('PNG is missing IHDR');

    const width = ihdr.readUInt32BE(0);
    const height = ihdr.readUInt32BE(4);
    const bitDepth = ihdr[8];
    const colorType = ihdr[9];
    const interlace = ihdr[12];
    if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${bitDepth}`);
    if (interlace !== 0) throw new Error('interlaced PNG is not supported');

    const channelsByType = {
        0: 1,
        2: 3,
        4: 2,
        6: 4,
    };
    const channels = channelsByType[colorType];
    if (!channels) throw new Error(`unsupported PNG color type: ${colorType}`);

    const compressed = Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data));
    const raw = zlib.inflateSync(compressed);
    const stride = width * channels;
    const expected = (stride + 1) * height;
    if (raw.length < expected) throw new Error('PNG image data is shorter than expected');

    const unfiltered = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const rawOffset = y * (stride + 1);
        const filter = raw[rawOffset];
        const src = rawOffset + 1;
        const dst = y * stride;
        const prev = y > 0 ? dst - stride : -1;

        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? unfiltered[dst + x - channels] : 0;
            const up = prev >= 0 ? unfiltered[prev + x] : 0;
            const upLeft = prev >= 0 && x >= channels ? unfiltered[prev + x - channels] : 0;
            const value = raw[src + x];

            if (filter === 0) unfiltered[dst + x] = value;
            else if (filter === 1) unfiltered[dst + x] = (value + left) & 0xFF;
            else if (filter === 2) unfiltered[dst + x] = (value + up) & 0xFF;
            else if (filter === 3) unfiltered[dst + x] = (value + Math.floor((left + up) / 2)) & 0xFF;
            else if (filter === 4) unfiltered[dst + x] = (value + paethPredictor(left, up, upLeft)) & 0xFF;
            else throw new Error(`unsupported PNG filter: ${filter}`);
        }
    }

    const rgba = Buffer.alloc(width * height * 4);
    for (let src = 0, dst = 0; src < unfiltered.length; src += channels, dst += 4) {
        if (colorType === 0) {
            rgba[dst] = unfiltered[src];
            rgba[dst + 1] = unfiltered[src];
            rgba[dst + 2] = unfiltered[src];
            rgba[dst + 3] = 255;
        } else if (colorType === 2) {
            rgba[dst] = unfiltered[src];
            rgba[dst + 1] = unfiltered[src + 1];
            rgba[dst + 2] = unfiltered[src + 2];
            rgba[dst + 3] = 255;
        } else if (colorType === 4) {
            rgba[dst] = unfiltered[src];
            rgba[dst + 1] = unfiltered[src];
            rgba[dst + 2] = unfiltered[src];
            rgba[dst + 3] = unfiltered[src + 1];
        } else {
            rgba[dst] = unfiltered[src];
            rgba[dst + 1] = unfiltered[src + 1];
            rgba[dst + 2] = unfiltered[src + 2];
            rgba[dst + 3] = unfiltered[src + 3];
        }
    }

    return { width, height, rgba };
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodeRgbaPng(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0;
        rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND'),
    ]);
}

function tintPngBuffer(buffer, color) {
    const { width, height, rgba } = decodePngToRgba(buffer);
    const { r, g, b } = colorParts(color);
    const targetLuma = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
    let visiblePixels = 0;

    for (let i = 0; i < rgba.length; i += 4) {
        const alpha = rgba[i + 3];
        if (!alpha) continue;
        visiblePixels++;

        const sourceLuma = (rgba[i] * 0.2126) + (rgba[i + 1] * 0.7152) + (rgba[i + 2] * 0.0722);
        rgba[i] = blendChannel(r, sourceLuma, targetLuma);
        rgba[i + 1] = blendChannel(g, sourceLuma, targetLuma);
        rgba[i + 2] = blendChannel(b, sourceLuma, targetLuma);
    }

    if (!visiblePixels) throw new Error('PNG has no visible pixels');
    return encodeRgbaPng(width, height, rgba);
}

function tintPngFile(filePath, color) {
    const resolvedPath = path.resolve(filePath);
    const stat = fs.statSync(resolvedPath);
    const { value } = colorParts(color);
    const cacheKey = `${resolvedPath}:${stat.mtimeMs}:${stat.size}:${value}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const parsed = path.parse(resolvedPath);
    const result = {
        attachment: tintPngBuffer(fs.readFileSync(resolvedPath), color),
        name: parsed.base,
    };

    clearOldCacheEntry();
    cache.set(cacheKey, result);
    return result;
}

function tintAttachmentPayload(payload, color) {
    const shouldTint = payload?.tintThumbnail !== false && process.env.TINT_ICON_THUMBNAILS !== '0';
    const cleanPayload = payload && Object.prototype.hasOwnProperty.call(payload, 'tintThumbnail')
        ? (() => {
            const next = { ...payload };
            delete next.tintThumbnail;
            return next;
        })()
        : payload;

    if (!shouldTint) return cleanPayload;
    if (!Array.isArray(cleanPayload.files) || !cleanPayload.files.length) return cleanPayload;

    // Find the attachment thumbnail URL — check top-level first, then first embed
    let thumbnailUrl = cleanPayload.thumbnail || null;

    if (!thumbnailUrl) {
        const firstEmbed = cleanPayload.embeds?.[0];
        if (firstEmbed) {
            const data = typeof firstEmbed.toJSON === 'function'
                ? firstEmbed.toJSON()
                : (firstEmbed.data || firstEmbed);
            thumbnailUrl = data?.thumbnail?.url || null;
        }
    }

    if (!thumbnailUrl) return cleanPayload;

    const match = String(thumbnailUrl).match(/^attachment:\/\/(.+)$/i);
    if (!match) return cleanPayload;

    const requestedName = match[1];
    const index = cleanPayload.files.findIndex(file => {
        if (typeof file !== 'string') return false;
        return path.basename(file).toLowerCase() === requestedName.toLowerCase();
    });

    if (index === -1) return cleanPayload;

    try {
        const tinted = tintPngFile(cleanPayload.files[index], color);
        const nextFiles = [...cleanPayload.files];
        nextFiles[index] = tinted;
        return {
            ...cleanPayload,
            files: nextFiles,
        };
    } catch (err) {
        console.warn(`[ThumbnailTint] failed: ${err?.message || err}`);
        return cleanPayload;
    }
}

module.exports = {
    tintAttachmentPayload,
    tintPngFile,
};
