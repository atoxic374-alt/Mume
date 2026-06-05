'use strict';

const fs   = require('fs');
const path = require('path');

const MAP_PATH = path.join(process.cwd(), 'settings', 'emojiMap.json');
const CDN_BASE = 'https://cdn.discordapp.com/emojis';

// ── Persistence helpers ───────────────────────────────────────────────────────

function loadMap() {
    try { return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); }
    catch { return {}; }
}

function saveMap(map) {
    try { fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2), 'utf8'); }
    catch (err) { console.warn('[EmojiSync] could not save map:', err?.message); }
}

// ── CDN download ──────────────────────────────────────────────────────────────

async function downloadAsBase64(emojiId, animated = false) {
    const ext  = animated ? 'gif' : 'png';
    const url  = `${CDN_BASE}/${emojiId}.${ext}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`CDN returned HTTP ${res.status} for ${url}`);
        const buf = Buffer.from(await res.arrayBuffer());
        return `data:image/${animated ? 'gif' : 'png'};base64,${buf.toString('base64')}`;
    } finally {
        clearTimeout(timer);
    }
}

// ── Emoji collection ──────────────────────────────────────────────────────────

function collectEmojis(MUSIC_EMOJIS) {
    const seen = new Map();
    const visit = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        if (value.id && value.name) {
            const id = String(value.id);
            if (!seen.has(id)) seen.set(id, { id, name: String(value.name), animated: value.animated === true });
            return;
        }
        Object.values(value).forEach(visit);
    };
    visit(MUSIC_EMOJIS);
    return [...seen.values()];
}

// ── Main sync ─────────────────────────────────────────────────────────────────

/**
 * Ensures every custom emoji in MUSIC_EMOJIS exists as an application emoji on
 * the given Discord client.  Missing emojis are downloaded from the public CDN
 * and uploaded via the Application Emojis REST endpoint.
 *
 * Returns a map of { originalEmojiId → applicationEmojiId }.
 *
 * Safe to call on every bot startup — already-uploaded emojis are skipped.
 */
async function syncMusicEmojis(client, MUSIC_EMOJIS) {
    if (!client?.application) {
        console.warn('[EmojiSync] client.application not available — skipping sync');
        return loadMap();
    }

    const emojis = collectEmojis(MUSIC_EMOJIS);
    if (!emojis.length) return {};

    // Fetch current application emojis into cache
    let appCache;
    try {
        appCache = await client.application.emojis.fetch();
    } catch (err) {
        console.warn(`[EmojiSync] fetch failed: ${err?.message || err} — using saved map`);
        return loadMap();
    }

    const map       = loadMap();
    const byName    = new Map([...appCache.values()].map(e => [e.name, e]));
    const byId      = new Map([...appCache.values()].map(e => [e.id,   e]));

    let uploaded = 0;
    let skipped  = 0;
    let failed   = 0;

    for (const emoji of emojis) {

        // Already mapped AND still exists in app cache → nothing to do
        if (map[emoji.id] && byId.has(map[emoji.id])) {
            skipped++;
            continue;
        }

        // Uploaded under the same name already → just record mapping
        if (byName.has(emoji.name)) {
            const appEmoji = byName.get(emoji.name);
            map[emoji.id]  = appEmoji.id;
            skipped++;
            continue;
        }

        // Need to download + upload
        let imageData;
        try {
            imageData = await downloadAsBase64(emoji.id, emoji.animated);
        } catch (err) {
            console.warn(`[EmojiSync] ✖ download failed for ${emoji.name} (${emoji.id}): ${err?.message}`);
            failed++;
            continue;
        }

        try {
            const created  = await client.application.emojis.create({ name: emoji.name, attachment: imageData });
            map[emoji.id]  = created.id;
            byName.set(created.name, created);
            byId.set(created.id,    created);
            uploaded++;
            console.log(`[EmojiSync] ✔ uploaded ${emoji.name}  ${emoji.id} → ${created.id}`);
        } catch (err) {
            console.warn(`[EmojiSync] ✖ upload failed for ${emoji.name} (${emoji.id}): ${err?.message}`);
            failed++;
        }
    }

    saveMap(map);

    const total = emojis.length;
    if (uploaded > 0 || failed > 0) {
        console.log(`[EmojiSync] finished — ${uploaded} uploaded, ${skipped} skipped, ${failed} failed (${total} total)`);
    } else {
        console.log(`[EmojiSync] all ${total} emojis already synced ✅`);
    }

    return map;
}

module.exports = { syncMusicEmojis, loadEmojiMap: loadMap };
