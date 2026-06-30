const {
    Client,
    EmbedBuilder,
    Collection,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    StringSelectMenuBuilder,
    ActivityType,
    Options,
    ComponentType,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags,
    PermissionFlagsBits,
    AuditLogEvent,
} = require('discord.js');

const fs = require('fs');
const { Poru } = require('poru');
const { Agent: UndiciAgent, request: undiciRequest } = require('undici');
const lavalinkKeepAlive = require('./utils/lavalinkKeepAlive');
const lavalinkConsole = require('./utils/lavalinkConsole');

const { owners, TwitchUrl, statuses, logChannelId: _configLogChannelId } = require(`${process.cwd()}/config`);
const store = require('./utils/store');
const likes = require('./utils/likes');
const { getDisplay } = require('./utils/display');
const MUSIC_EMOJIS = require('./utils/musicEmojis');
const { syncMusicEmojis } = require('./utils/syncEmojis');
const { getEmbedColor, refreshEmbedColor } = require('./utils/embedColor');
const statusStore = require('./statusStore');
const { tintAttachmentPayload, warmTintCache } = require('./utils/tintedThumbnail');
const { buildProgressBarAttachment, normalizeColorNumber, prewarmProgressBarCache } = require('./utils/progressBar');
const { liftDiscordClientLimits } = require('./utils/discordClientTuning');

const runningBots = new Collection();
const warnedMissingMusicEmojiIds = new Set();
const botLastActivity = new Map();
const lavalinkRestAgents = new Map();
const tempData = new Collection();
tempData.set("bots", []);
const collection = new Collection();

// ── Lavalink Alert System ─────────────────────────────────────────────────────
// Shared state across all bot instances in this process
const _lavalinkAlertState = {
    disconnectSentAt: new Map(),   // nodeName → timestamp
    highLoadSentAt:   new Map(),   // nodeName → timestamp
    recoveredSentAt:  new Map(),   // nodeName → timestamp
};
const ALERT_COOLDOWN_MS      = 5 * 60_000;  // don't repeat same alert for 5 min
const HIGH_LOAD_THRESHOLD    = Number(process.env.LAVALINK_HIGH_LOAD_THRESHOLD || 0.80);
const HIGH_LOAD_CHECK_MS     = Number(process.env.LAVALINK_LOAD_CHECK_MS || 60_000);

async function sendLavalinkAlert(client, type, node, extraInfo = '') {
    const channelId = process.env.LAVALINK_ALERT_CHANNEL || _configLogChannelId;
    if (!channelId) return;

    const stateMap = type === 'disconnect' ? _lavalinkAlertState.disconnectSentAt
                   : type === 'highload'   ? _lavalinkAlertState.highLoadSentAt
                   :                         _lavalinkAlertState.recoveredSentAt;

    const nodeName = node?.options?.name || node?.options?.host || 'Unknown';
    const lastSent = stateMap.get(nodeName) || 0;
    if (Date.now() - lastSent < ALERT_COOLDOWN_MS) return;
    stateMap.set(nodeName, Date.now());

    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;

        const colors = { disconnect: 0xED4245, highload: 0xFEE75C, recovered: 0x57F287 };
        const titles = {
            disconnect: '🔴 Lavalink انقطع',
            highload:   '⚠️ Lavalink تحت ضغط عالي',
            recovered:  '🟢 Lavalink رجع ورسور',
        };

        const embed = new EmbedBuilder()
            .setColor(colors[type] || 0x5865F2)
            .setTitle(titles[type] || 'Lavalink Alert')
            .addFields({ name: 'Node', value: `\`${nodeName}\``, inline: true })
            .setTimestamp();

        if (extraInfo) embed.setDescription(extraInfo);

        if (type === 'disconnect') {
            embed.setDescription([
                extraInfo,
                '',
                '**البوتات ستعود تلقائياً عند رجوع الاتصال.**',
                'إذا استمر الانقطاع، يرجى إعادة تشغيل Lavalink يدوياً.',
            ].filter(Boolean).join('\n'));
        }

        if (type === 'highload') {
            embed.setDescription([
                extraInfo,
                '',
                '**الضغط العالي قد يسبب تأخير أو انقطاع الصوت.**',
                'يُنصح بإعادة تشغيل Lavalink أو تقليل عدد البوتات.',
            ].filter(Boolean).join('\n'));
        }

        await channel.send({ embeds: [embed] });
    } catch {}
}

// ── Per-node high-load monitor (started once per node on connect) ─────────────
const _nodeLoadMonitors = new Map(); // nodeName → intervalId

function startNodeLoadMonitor(node, client) {
    const nodeName = node?.options?.name || node?.options?.host || 'Unknown';
    if (_nodeLoadMonitors.has(nodeName)) return;

    const interval = setInterval(() => {
        if (!node.isConnected) {
            clearInterval(interval);
            _nodeLoadMonitors.delete(nodeName);
            return;
        }
        const cpu       = Number(node.stats?.cpu?.systemLoad   || 0);
        const lavalink  = Number(node.stats?.cpu?.lavalinkLoad || 0);
        const memUsed   = Number(node.stats?.memory?.used      || 0);
        const memMax    = Number(node.stats?.memory?.reservable|| node.stats?.memory?.allocated || 1);
        const memRatio  = memMax > 0 ? memUsed / memMax : 0;

        const overloaded = cpu >= HIGH_LOAD_THRESHOLD || lavalink >= HIGH_LOAD_THRESHOLD || memRatio >= 0.90;
        if (overloaded) {
            const detail = [
                cpu       >= HIGH_LOAD_THRESHOLD ? `CPU: ${(cpu * 100).toFixed(0)}%`      : null,
                lavalink  >= HIGH_LOAD_THRESHOLD ? `Lavalink CPU: ${(lavalink * 100).toFixed(0)}%` : null,
                memRatio  >= 0.90               ? `RAM: ${(memRatio * 100).toFixed(0)}%`  : null,
            ].filter(Boolean).join(' | ');
            sendLavalinkAlert(client, 'highload', node, detail).catch(() => {});
        }
    }, HIGH_LOAD_CHECK_MS);
    interval.unref?.();
    _nodeLoadMonitors.set(nodeName, interval);
}

function stopNodeLoadMonitor(nodeName) {
    const interval = _nodeLoadMonitors.get(nodeName);
    if (interval) {
        clearInterval(interval);
        _nodeLoadMonitors.delete(nodeName);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

function stableHash(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function normalizeLavalinkHostConfig(hostConfig) {
    return Array.isArray(hostConfig) ? hostConfig.filter(node => node?.host && node?.port) : [];
}

function selectLavalinkHostsForBot(hostConfig, token, serverId) {
    const nodes = normalizeLavalinkHostConfig(hostConfig);
    if (nodes.length <= 1) return nodes;

    const strategy = String(process.env.LAVALINK_NODE_STRATEGY || 'partition').toLowerCase();
    if (strategy === 'all' || strategy === 'full') return nodes;

    const replicaCount = Math.max(1, Math.min(
        nodes.length,
        Number(process.env.LAVALINK_NODE_REPLICAS || 1) || 1,
    ));
    const start = stableHash(`${serverId || ''}:${String(token || '').slice(-12)}`) % nodes.length;
    const selected = [];
    for (let offset = 0; offset < replicaCount; offset++) {
        selected.push(nodes[(start + offset) % nodes.length]);
    }
    return selected;
}

// ── limitGuard: over-limit DM cooldown (shared across all bot instances) ─────
// مشترك بين كل البوتات في نفس العملية — يمنع إرسال أكثر من رسالة للشخص الواحد
const _limitGuardCooldown = new Map(); // `${channelId}:${userId}` → timestamp
const _LIMIT_GUARD_COOLDOWN_MS = 30_000;
setInterval(() => {
    const cutoff = Date.now() - _LIMIT_GUARD_COOLDOWN_MS;
    for (const [k, ts] of _limitGuardCooldown) if (ts < cutoff) _limitGuardCooldown.delete(k);
}, 5 * 60_000).unref?.();

// ── onlyBot: audit-log cache per guild (TTL 2.5s) ────────────────────────────
// يُشارك بين كل البوتات في نفس الغيلد — يمنع مئات الطلبات المتزامنة
const _movedByBotCache = new Map(); // guildId → { result: bool, ts: number, pending: Promise|null }
const _MOVED_BY_BOT_TTL = 2500;
setInterval(() => {
    const cutoff = Date.now() - _MOVED_BY_BOT_TTL * 4; // احتياط: 10 ثواني
    for (const [k, v] of _movedByBotCache) if (!v.pending && v.ts < cutoff) _movedByBotCache.delete(k);
}, 60_000).unref?.();

async function checkMovedByBot(guild) {
    if (!guild) return false;
    const guildId = guild.id;
    const now = Date.now();
    const cached = _movedByBotCache.get(guildId);

    // نتيجة محفوظة وما زالت صالحة
    if (cached && !cached.pending && now - cached.ts < _MOVED_BY_BOT_TTL) return cached.result;

    // طلب جارٍ بالفعل — أرجع نتيجته بدون طلب ثانٍ
    if (cached?.pending) return cached.pending;

    const pending = (async () => {
        try {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberMove, limit: 1 });
            const entry = logs.entries.first();
            const result = !!(entry && Date.now() - entry.createdTimestamp < 3000 && entry.executor?.bot === true);
            _movedByBotCache.set(guildId, { result, ts: Date.now(), pending: null });
            return result;
        } catch {
            _movedByBotCache.set(guildId, { result: false, ts: Date.now(), pending: null });
            return false;
        }
    })();

    _movedByBotCache.set(guildId, { result: false, ts: now, pending });
    return pending;
}

// ── B: resolveTrack cache (1-hour TTL, max 500 entries) ──────────────────────
const _resolveTrackCache = new Map();
const RESOLVE_TRACK_TTL = 60 * 60 * 1000;
const _resolveTrackMaxRaw = Number(process.env.RESOLVE_TRACK_MAX);
const RESOLVE_TRACK_MAX = Number.isFinite(_resolveTrackMaxRaw) && _resolveTrackMaxRaw >= 100
    ? _resolveTrackMaxRaw
    : 2000;
async function resolveTrackCached(player, track) {
    const key = track?.info?.uri || track?.info?.identifier || track?.track;
    if (!key) return player.resolveTrack(track);
    const cached = _resolveTrackCache.get(key);
    if (cached && Date.now() - cached.at < RESOLVE_TRACK_TTL) {
        if (process.env.DEBUG_PREFETCH) console.log(`[ResolveCache] hit: ${track.info?.title}`);
        return cached.result;
    }
    const result = await player.resolveTrack(track);
    if (result?.track) {
        if (_resolveTrackCache.size >= RESOLVE_TRACK_MAX) {
            // Evict oldest entry (Map preserves insertion order)
            _resolveTrackCache.delete(_resolveTrackCache.keys().next().value);
        }
        _resolveTrackCache.set(key, { result, at: Date.now() });
    }
    return result;
}
// ── Periodic TTL eviction: every 30 min remove entries older than 1 hour ─────
// Without this, expired entries linger in RAM until the 500-slot cap forces
// LRU eviction — even if nothing ever reads them again.
setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of _resolveTrackCache) {
        if (now - entry.at >= RESOLVE_TRACK_TTL) {
            _resolveTrackCache.delete(key);
            evicted++;
        }
    }
    if (evicted > 0 && process.env.DEBUG_PREFETCH)
        console.log(`[ResolveCache] periodic eviction: removed ${evicted} stale entries, ${_resolveTrackCache.size} remain`);
}, 30 * 60 * 1000).unref();
// ─────────────────────────────────────────────────────────────────────────────

// ── G: Memory watchdog — warn every 5 min if heap > 300 MB ───────────────────
setInterval(() => {
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heapMB > 300) {
        console.warn(`[MemWatchdog] heap usage: ${heapMB.toFixed(1)} MB — possible memory leak`);
    }
}, 5 * 60 * 1000).unref();
// ─────────────────────────────────────────────────────────────────────────────

const FILTER_NAMES = {
    clear: 'None',
    bassboost: 'Bass Boost',
    bassboost2: 'Bass Boost+',
    nightcore: 'Nightcore',
    spedup: 'Sped Up',
    slowmode: 'Slow Mode',
    deep: 'Deep Voice',
    highpitch: 'High Pitch',
    '8d': '8D Audio',
    vaporwave: 'Vaporwave',
    karaoke: 'Karaoke',
    tremolo: 'Tremolo',
    vibrato: 'Vibrato',
    lowpass: 'Low Pass',
    muffled: 'Muffled',
    channelmix: 'Channel Mix',
    treble: 'Treble Boost',
    pop: 'Pop EQ',
    electronic: 'Electronic EQ',
    soft: 'Soft EQ',
};

const FILTER_OPTIONS = [
    { label: 'Clear Filters', value: 'clear', description: 'إزالة جميع الفلاتر', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Bass Boost', value: 'bassboost', description: 'جهير أوضح بدون تشويه', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Bass Boost+', value: 'bassboost2', description: 'جهير أقوى وواضح', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Nightcore', value: 'nightcore', description: 'سرعة ونبرة أعلى', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Sped Up', value: 'spedup', description: 'تسريع خفيف بدون رفع مبالغ', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Slow Mode', value: 'slowmode', description: 'إبطاء ناعم للأغنية', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Deep Voice', value: 'deep', description: 'نبرة أعمق وأثقل', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'High Pitch', value: 'highpitch', description: 'نبرة عالية وسريعة', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: '8D Audio', value: '8d', description: 'حركة صوتية خفيفة', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Vaporwave', value: 'vaporwave', description: 'أبطأ وأنعم', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Karaoke', value: 'karaoke', description: 'تقليل الصوت البشري', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Tremolo', value: 'tremolo', description: 'اهتزاز مستوى الصوت', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Vibrato', value: 'vibrato', description: 'اهتزاز النبرة', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Low Pass', value: 'lowpass', description: 'صوت أنعم', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Muffled', value: 'muffled', description: 'صوت مكتوم وواضح الفرق', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Channel Mix', value: 'channelmix', description: 'مزج خفيف للقنوات', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Treble Boost', value: 'treble', description: 'إبراز الأصوات العالية', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Pop EQ', value: 'pop', description: 'موازنة مناسبة للأغاني العامة', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Electronic EQ', value: 'electronic', description: 'إيقاع وحدّة أكثر', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
    { label: 'Soft EQ', value: 'soft', description: 'صوت أهدأ وأنظف', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.filters) },
];

const ARTIST_MENU_HEADER_VALUE = '__artist_header';
const TINTED_ICON_FILES = [
    './assets/image/icons/Queue.png',
    './assets/image/icons/seek.png',
    './assets/image/icons/Volumeup.png',
    './assets/image/icons/Volumedowwn.png',
    './assets/image/icons/VolumeInfo.png',
    './assets/image/icons/Skip.png',
    './assets/image/icons/NowPlaying.png',
    './assets/image/icons/LoopON.png',
    './assets/image/icons/LoopOFF.png',
    './assets/image/icons/Error.png',
    './assets/image/icons/AutoPlayON.png',
    './assets/image/icons/AutoPlayOFF.png',
    './assets/image/icons/AddSong.png',
];

function warnUnavailableMusicEmojis(client) {
    if (typeof MUSIC_EMOJIS.validateCustomEmojis !== 'function') return;
    const freshMissing = MUSIC_EMOJIS.validateCustomEmojis(client)
        .filter(({ emoji }) => {
            const key = `${emoji.id}:${emoji.name || ''}`;
            if (warnedMissingMusicEmojiIds.has(key)) return false;
            warnedMissingMusicEmojiIds.add(key);
            return true;
        });

    if (!freshMissing.length) return;
    console.log(`[MusicEmoji] ${freshMissing.length} emoji(s) not available in this bot app/guild yet: ${freshMissing.map(({ key, emoji }) => `${key}(${emoji.name || 'emoji'}:${emoji.id})`).join(', ')}`);
}

const BASE_FILTERS = {
    volume: 1.0,
    equalizer: [],
    karaoke: null,
    timescale: null,
    tremolo: null,
    vibrato: null,
    rotation: null,
    distortion: null,
    lowPass: null,
};

const FILTER_PRESETS = {
    clear: {},
    bassboost: {
        equalizer: [
            { band: 0, gain: 0.28 }, { band: 1, gain: 0.24 }, { band: 2, gain: 0.18 },
            { band: 3, gain: 0.11 }, { band: 4, gain: 0.05 }, { band: 5, gain: 0.00 },
            { band: 6, gain: -0.03 }, { band: 7, gain: -0.04 },
        ],
    },
    bassboost2: {
        equalizer: [
            { band: 0, gain: 0.40 }, { band: 1, gain: 0.34 }, { band: 2, gain: 0.26 },
            { band: 3, gain: 0.15 }, { band: 4, gain: 0.06 }, { band: 5, gain: -0.02 },
            { band: 6, gain: -0.05 }, { band: 7, gain: -0.06 },
        ],
    },
    nightcore: { timescale: { speed: 1.12, pitch: 1.10, rate: 1.0 } },
    spedup: { timescale: { speed: 1.16, pitch: 1.02, rate: 1.05 } },
    slowmode: { timescale: { speed: 0.86, pitch: 0.98, rate: 0.92 } },
    deep: { timescale: { speed: 0.96, pitch: 0.82, rate: 1.0 } },
    highpitch: { timescale: { speed: 1.06, pitch: 1.35, rate: 1.02 } },
    '8d': { rotation: { rotationHz: 0.14 } },
    vaporwave: { timescale: { speed: 0.92, pitch: 0.90, rate: 1.0 } },
    karaoke: { karaoke: { level: 0.35, monoLevel: 0.35, filterBand: 220.0, filterWidth: 90.0 } },
    tremolo: { tremolo: { frequency: 3.5, depth: 0.25 } },
    vibrato: { vibrato: { frequency: 4.5, depth: 0.25 } },
    lowpass: { lowPass: { smoothing: 5.0 } },
    muffled: { lowPass: { smoothing: 13.0 }, equalizer: [{ band: 10, gain: -0.12 }, { band: 11, gain: -0.16 }, { band: 12, gain: -0.20 }] },
    channelmix: { channelMix: { leftToLeft: 0.85, leftToRight: 0.15, rightToLeft: 0.15, rightToRight: 0.85 } },
    treble: {
        equalizer: [
            { band: 5, gain: 0.05 }, { band: 6, gain: 0.08 }, { band: 7, gain: 0.11 },
            { band: 8, gain: 0.13 }, { band: 9, gain: 0.15 }, { band: 10, gain: 0.13 },
            { band: 11, gain: 0.10 }, { band: 12, gain: 0.07 },
        ],
    },
    pop: {
        equalizer: [
            { band: 0, gain: 0.10 }, { band: 1, gain: 0.08 }, { band: 2, gain: 0.04 },
            { band: 5, gain: 0.05 }, { band: 6, gain: 0.07 }, { band: 8, gain: 0.06 },
            { band: 10, gain: 0.04 },
        ],
    },
    electronic: {
        equalizer: [
            { band: 0, gain: 0.16 }, { band: 1, gain: 0.12 }, { band: 2, gain: 0.07 },
            { band: 6, gain: 0.08 }, { band: 7, gain: 0.10 }, { band: 8, gain: 0.12 },
            { band: 10, gain: 0.10 },
        ],
        timescale: { speed: 1.03, pitch: 1.0, rate: 1.0 },
    },
    soft: {
        equalizer: [
            { band: 0, gain: -0.03 }, { band: 1, gain: -0.02 }, { band: 8, gain: -0.05 },
            { band: 9, gain: -0.07 }, { band: 10, gain: -0.08 }, { band: 11, gain: -0.10 },
        ],
        lowPass: { smoothing: 7.0 },
    },
};

function displaySettings(tokenObj) {
    const saved = tokenObj?.code ? getDisplay(tokenObj.code) : {};
    return {
        buttons: tokenObj?.buttons ? tokenObj.buttons === 'on' : saved.buttons !== false,
        embeds: tokenObj?.embeds ? tokenObj.embeds === 'on' : saved.embeds !== false,
        platform: tokenObj?.source || saved.platform || 'ytsearch',
        voiceStatus: tokenObj?.voiceStatus ? tokenObj.voiceStatus === 'on' : saved.voiceStatus === true,
        voiceStatusEmoji: tokenObj?.voiceStatusEmoji || saved.voiceStatusEmoji || '🎵',
    };
}

function subscriptionOwnersOf(tokenObj) {
    const raw = Array.isArray(tokenObj?.subOwners)
        ? tokenObj.subOwners
        : Array.isArray(tokenObj?.owners)
            ? tokenObj.owners
            : [];
    return [...new Set(raw.map(id => String(id || '').match(/\d{17,20}/)?.[0]).filter(Boolean))];
}

function canControlSubscription(tokenObj, userId) {
    const id = String(userId || '');
    if (!id) return false;
    return owners.includes(id)
        || tokenObj?.client === id
        || subscriptionOwnersOf(tokenObj).includes(id);
}

function shortDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return 'Live';
    const total = Math.floor(value / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function createMusicControlButtons(paused = false, liked = false, { includeLike = true, dangerStop = true, likeInPrevSlot = false } = {}) {
    const row1 = new ActionRowBuilder()
        .addComponents(
            likeInPrevSlot
                ? new ButtonBuilder()
                    .setCustomId('like')
                    .setEmoji(MUSIC_EMOJIS.componentEmoji(liked ? MUSIC_EMOJIS.dislike : MUSIC_EMOJIS.like))
                    .setStyle(ButtonStyle.Secondary)
                : new ButtonBuilder()
                    .setCustomId('prev')
                    .setEmoji('⏮')
                    .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('stop')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.stop))
                .setStyle(dangerStop ? ButtonStyle.Danger : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('pause')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.pause))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('skip')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.skip))
                .setStyle(ButtonStyle.Secondary),
        );
    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('volume_down')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.volumeDown))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('loop')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.loop))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('queue_btn')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.queue))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('volume_up')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.volumeUp))
                .setStyle(ButtonStyle.Secondary),
        );

    if (includeLike && !likeInPrevSlot) {
        row2.addComponents(
            new ButtonBuilder()
                .setCustomId('like')
                .setEmoji(MUSIC_EMOJIS.componentEmoji(liked ? MUSIC_EMOJIS.dislike : MUSIC_EMOJIS.like))
                .setStyle(ButtonStyle.Secondary),
        );
    }

    return [row1, row2];
}

function buildMusicComponents({ liked = false, paused = false, artistTracks = [], selectedFilter = 'clear', selectedArtistIndex = null, showControls = true, compactControls = false }) {
    const rows = [];

    if (showControls && artistTracks.length > 0) {
        const safeSelectedArtistIndex = Number.isInteger(selectedArtistIndex) ? selectedArtistIndex : null;
        const artistOptions = [
            {
                label: 'Suggest For You',
                value: ARTIST_MENU_HEADER_VALUE,
                description: 'Songs from the same artist',
                emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.artistTop),
                default: safeSelectedArtistIndex === null,
            },
            ...artistTracks.slice(0, 6).map((t, i) => ({
                label: (t.info.title || 'Unknown').slice(0, 99),
                value: String(i),
                description: `${shortDuration(t.info.length)} · ${(t.info.author || '').slice(0, 50)}`.slice(0, 99),
                emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.artistTop),
                default: safeSelectedArtistIndex === i,
            })),
        ];
        const artistMenu = new StringSelectMenuBuilder()
            .setCustomId('np_artist')
            .setPlaceholder('Suggest For You')
            .addOptions(artistOptions);
        rows.push(new ActionRowBuilder().addComponents(artistMenu));
    }

    if (showControls) {
        const safeSelectedFilter = FILTER_NAMES[selectedFilter] ? selectedFilter : 'clear';
        const activeFilterName = FILTER_NAMES[safeSelectedFilter] || FILTER_NAMES.clear;
        const filterMenu = new StringSelectMenuBuilder()
            .setCustomId('np_filter')
            .setPlaceholder(` Current Filter : ${activeFilterName}`)
            .addOptions(FILTER_OPTIONS.map(option => ({
                ...option,
                default: option.value === safeSelectedFilter,
            })));
        rows.push(new ActionRowBuilder().addComponents(filterMenu));
    }

    if (showControls) rows.push(...createMusicControlButtons(paused, liked, {
        includeLike: true,
        dangerStop: !compactControls,
        likeInPrevSlot: compactControls,
    }));

    return rows.slice(0, 5);
}

function buildNowPlayingPayload(TrueMusic, tokenObj, track, requester, options = {}) {
    const settings = displaySettings(tokenObj);
    const embedColor = getEmbedColor(TrueMusic);
    const title = cleanInlineText(track?.info?.title, 'Unknown track', 96);
    const author = cleanInlineText(track?.info?.author, 'Unknown artist', 72);
    const uri = track?.info?.uri;
    const duration = shortDuration(track?.info?.length);
    const requesterName = requester?.displayName || requester?.username || 'Unknown';
    const titleText = uri ? `[${title}](${uri})` : title;
    const autoPlayLine = autoPlayNowPlayingLine(track?.info, TrueMusic);
    const components = buildMusicComponents({
        liked: !!options.liked,
        artistTracks: options.artistTracks || [],
        selectedFilter: options.selectedFilter || 'clear',
        selectedArtistIndex: options.selectedArtistIndex ?? null,
        showControls: settings.buttons,
    });

    if (settings.embeds) {
        const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle('Now Playing')
            .setThumbnail('attachment://NowPlaying.png')
            .setDescription([
                `**${titleText}**`,
                autoPlayLine ? `*${autoPlayLine}*` : null,
            ].filter(Boolean).join('\n'))
            .addFields(
                { name: 'Duration', value: `\`${duration}\``, inline: true },
                { name: 'By', value: `**${requesterName}**`, inline: true },
            )
            .setFooter({
                text: TrueMusic.user?.displayName || TrueMusic.user?.username || 'Music',
                iconURL: TrueMusic.user?.displayAvatarURL?.({ dynamic: true }),
            });

        return tintAttachmentPayload({
            content: `🎶 **${TrueMusic.user?.displayName || TrueMusic.user?.username || 'Music'}**`,
            embeds: [embed],
            files: ['./assets/image/icons/NowPlaying.png'],
            components,
        }, embedColor);
    }

    return {
        content: [
            '**Now Playing**',
            `**${title}**`,
            autoPlayLine ? `*${autoPlayLine}*` : null,
            author !== 'Unknown artist'
                ? `**${author}** | By : **${requesterName}**`
                : `By : **${requesterName}**`,
        ].filter(Boolean).join('\n'),
        embeds: [],
        components,
    };
}

function plainMusicText(value) {
    return String(value || '')
        .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\s]+(?:\s+"[^"]*")?\)/gi, '$1')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/www\.\S+/gi, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function compactMusicText({ title, description, fields = [], footer = null }) {
    const parts = [];
    const cleanTitle = plainMusicText(title);
    const cleanDescription = plainMusicText(description);
    const cleanFooter = plainMusicText(footer);
    if (cleanTitle) parts.push(`**${cleanTitle}**`);
    if (cleanDescription) parts.push(cleanDescription);
    fields.forEach(field => {
        const name = plainMusicText(field?.name);
        const value = plainMusicText(field?.value);
        if (name && value) parts.push(`**${name}:** ${value}`);
    });
    if (cleanFooter) parts.push(cleanFooter);
    return parts.join('\n') || 'Done.';
}

function musicPayload(tokenObj, { title, description, fields = [], components = [], color = undefined, thumbnail = null, files = [], footer = null }) {
    const settings = displaySettings(tokenObj);
    const colorSource = tokenObj?.token ? runningBots.get(tokenObj.token) : null;
    const embedColor = getEmbedColor(colorSource, color);
    const payload = {
        components: settings.buttons && components.length ? components : [],
    };

    if (settings.embeds) {
        const embed = new EmbedBuilder().setColor(embedColor);
        if (title) embed.setTitle(title);
        if (description) embed.setDescription(description);
        if (thumbnail) embed.setThumbnail(thumbnail);
        if (fields.length) embed.addFields(fields);
        if (footer) embed.setFooter(typeof footer === 'string' ? { text: footer } : footer);
        payload.embeds = [embed];
        if (files.length) payload.files = files;
        return tintAttachmentPayload(payload, embedColor);
    } else {
        payload.content = compactMusicText({ title, description, fields, footer });
        payload.embeds = [];
    }

    return payload;
}

function cleanInlineText(value, fallback = 'Unknown', maxLength = 120) {
    const text = String(value || fallback).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
    return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 3))}...` : text;
}

function escapeMarkdownLinkText(value, maxLength = 100) {
    // Only escape ] — that's the only char that breaks a markdown link label.
    // Escaping ( ) or \ produces visible backslashes in Discord.
    return cleanInlineText(value, 'Unknown', maxLength)
        .replace(/\]/g, '\\]');
}

function autoPlayNowPlayingLine(info, client = null) {
    if (info?.autoPlay !== true) return '';
    const source = String(info?.sourceName || '').toLowerCase();
    const emojiKey = platformEmojiKey(source);
    const platformData = MUSIC_EMOJIS.platforms[emojiKey];
    const emoji = platformData
        ? (MUSIC_EMOJIS.messageEmoji?.(platformData, client, '') || '')
        : (MUSIC_EMOJIS.messageEmoji?.(MUSIC_EMOJIS.smartSearch, client, '') || '');
    const artist = cleanInlineText(info.autoPlayArtist, '', 48);
    return `${emoji ? `${emoji} ` : ''}Auto Play${artist ? ` : ${artist}` : ''}`;
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function trackArtworkUrl(track, client, requester = null) {
    const info = track?.info || {};
    const candidates = [
        info.artworkUrl,
        info.thumbnail,
        info.image,
        info.uri?.includes('i.ytimg.com') ? info.uri : null,
    ];

    const identifier = String(info.identifier || '').trim();
    const source = String(info.sourceName || '').toLowerCase();
    if (identifier && (source.includes('youtube') || /youtu\.?be/i.test(String(info.uri || '')))) {
        candidates.push(`https://img.youtube.com/vi/${identifier}/hqdefault.jpg`);
    }

    const found = candidates.find(isHttpUrl);
    if (found) return found;
    return requester?.displayAvatarURL?.({ extension: 'png', size: 256 })
        || requester?.user?.displayAvatarURL?.({ extension: 'png', size: 256 })
        || client.user?.displayAvatarURL?.({ extension: 'png', size: 256 })
        || null;
}

function buildTextProgressBar(position, duration, length = 20) {
    const total = Number(duration || 0);
    if (total <= 0) return '─'.repeat(10) + '🔴' + '─'.repeat(10);
    const current = Math.max(0, Number(position || 0));
    const filled = Math.max(0, Math.min(length, Math.floor((current / total) * length)));
    return '─'.repeat(filled) + '🔴' + '─'.repeat(length - filled);
}

function buildInlineProgressBar(position, duration, length = 22, meta = '') {
    const total = Number(duration || 0);
    const current = Math.max(0, Number(position || 0));
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    const filled = Math.floor(ratio * length);
    const filledBar = '─'.repeat(filled);
    const emptyBar  = '─'.repeat(Math.max(0, length - filled));
    const timeNow   = shortDuration(current);
    const timeTotal = shortDuration(total);
    // ANSI \u001b[37m ≈ #bfbfc7 (extracted from target image), \u001b[2;30m = dark empty bar
    const metaPart = meta ? `\u001b[2;37m  ${meta}\u001b[0m` : '';
    const line = `\u001b[37m${timeNow}  ${filledBar}\u001b[0m\u001b[1;37m●\u001b[0m\u001b[2;30m${emptyBar}\u001b[0m\u001b[37m  ${timeTotal}\u001b[0m${metaPart}`;
    return `\`\`\`ansi\n${line}\n\`\`\``;
}

function buildNowPlayingFallbackPayload(tokenObj, player, requester) {
    const current = player.currentTrack.info;
    const titleText = cleanInlineText(current.title, 'Unknown track', 96);
    const authorText = cleanInlineText(current.author, 'Unknown artist', 72);
    const requesterName = requester?.displayName || requester?.globalName || requester?.username || requester?.tag || 'Unknown';
    const autoPlayLine = autoPlayNowPlayingLine(current, player?.client);

    return musicPayload(tokenObj, {
        title: 'Now Playing',
        description:
            `**${titleText}**\n` +
            (autoPlayLine ? `*${autoPlayLine}*\n` : '') +
            (authorText !== 'Unknown artist'
                ? `**${authorText}** | By : **${requesterName}**`
                : `By : **${requesterName}**`),
    });
}

function compactPlatformName(source) {
    const value = String(source || '').toLowerCase();
    if (value === 'auto') return 'Smart Search';
    if (value === 'ytsearch') return 'YouTube';
    if (value === 'youtube') return 'YouTube';
    if (value === 'ytmsearch') return 'YouTube Music';
    if (value === 'youtubemusic') return 'YouTube Music';
    if (value === 'scsearch') return 'SoundCloud';
    if (value === 'soundcloud') return 'SoundCloud';
    if (value === 'spsearch') return 'Spotify';
    if (value === 'spotify') return 'Spotify';
    if (value === 'amsearch') return 'Apple Music';
    if (value === 'applemusic') return 'Apple Music';
    if (value === 'dzsearch') return 'Deezer';
    if (value === 'deezer') return 'Deezer';
    return source || 'YouTube';
}

function platformEmojiKey(source) {
    const value = String(source || '').toLowerCase();
    if (value === 'youtube') return 'ytsearch';
    if (value === 'youtubemusic') return 'ytmsearch';
    if (value === 'soundcloud') return 'scsearch';
    if (value === 'spotify') return 'spsearch';
    if (value === 'applemusic') return 'amsearch';
    if (value === 'deezer') return 'dzsearch';
    return value || 'ytsearch';
}

function buildNowPlayingMetaRow(tokenObj, currentTime, totalTime, refId = 'np', track = null, player = null, options = {}) {
    const platform = track?.info?.sourceName || displaySettings(tokenObj).platform;
    const emojiKey = platformEmojiKey(platform);
    const buttons = [];
    if (options.platform !== false) {
        const platformEmoji = MUSIC_EMOJIS.platforms[emojiKey]
            ? MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms[emojiKey])
            : null;
        const platformButton = new ButtonBuilder()
            .setCustomId(`${refId}_platform`)
            .setLabel(`Platform : ${compactPlatformName(platform)}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);
        if (platformEmoji) platformButton.setEmoji(platformEmoji);
        buttons.push(platformButton);
    }
    if (options.time !== false) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`${refId}_time`)
            .setLabel(`${shortDuration(currentTime)} / ${shortDuration(totalTime)}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true));
    }
    if (options.volume) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`${refId}_volume`)
            .setLabel(`Volume : ${Math.max(0, Number(player?.volume || 100))}%`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true));
    }
    if (options.loop) {
        const loopValue = player?.loop === 'TRACK' ? 'ON' : 'OFF';
        buttons.push(new ButtonBuilder()
            .setCustomId(`${refId}_loop`)
            .setLabel(`Loop : ${loopValue}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true));
    }
    if (options.requester) {
        const byName = typeof options.requester === 'string'
            ? options.requester
            : (options.requester?.displayName || options.requester?.globalName || options.requester?.username || 'Unknown');
        buttons.push(new ButtonBuilder()
            .setCustomId(`${refId}_requester`)
            .setLabel(`By: ${byName}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true));
    }
    return new ActionRowBuilder().addComponents(...buttons.slice(0, 5));
}

function buildNowPlayingV2Payload(TrueMusic, tokenObj, player, message, options = {}) {
    const track = options.track || player.currentTrack;
    const current = track.info;
    const settings = displaySettings(tokenObj);
    if (!settings.embeds) {
        // Always return an IS_COMPONENTS_V2 payload so edits stay compatible
        // (returning a content-based payload would break editing a V2 message)
        const _title = cleanInlineText(current.title, 'Unknown', 96);
        const _author = cleanInlineText(current.author, 'Unknown', 72);
        const _req = options.requester || current.requester || message?.author;
        const _reqName = cleanInlineText(_req?.displayName || _req?.globalName || _req?.username || _req?.tag, 'Unknown', 48);
        const { currentTime: _ct, totalTime: _tt } = safeProgressTimes(player, track, options);
        const _bar = buildInlineProgressBar(_ct, _tt, 20, `👤 ${_reqName}`);
        const _autoPlayLine = autoPlayNowPlayingLine(current, TrueMusic);
        const _ctr = new ContainerBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                `### ${_title}`,
                _autoPlayLine ? `*${_autoPlayLine}*` : null,
                `*${_author}*`,
                _bar,
            ].filter(Boolean).join('\n')));
        return { flags: MessageFlags.IsComponentsV2, components: [_ctr], allowedMentions: { parse: [] } };
    }

    const { currentTime, totalTime } = safeProgressTimes(player, track, options);
    const title = cleanInlineText(current.title, 'Unknown track', 96);
    const author = cleanInlineText(current.author, 'Unknown artist', 72);
    const uri = isHttpUrl(current.uri) ? current.uri : null;
    const titleLine = uri ? `[${escapeMarkdownLinkText(title, 96)}](${uri})` : title;
    const autoPlayLine = autoPlayNowPlayingLine(current, TrueMusic);
    const requester = options.requester || current.requester || message?.author;
    const requesterName = cleanInlineText(
        requester?.displayName || requester?.globalName || requester?.username || requester?.tag,
        'Unknown',
        64,
    );
    const loopMode = player.loop === 'TRACK' ? 'ON' : 'OFF';
    const volume = player.volume || 100;
    const artworkUrl = trackArtworkUrl(track, TrueMusic, requester);
    const compactPlayLayout = options.compactPlayLayout === true;
    const embedColor = getEmbedColor(TrueMusic);
    const accentColor = normalizeColorNumber(embedColor);
    const useEmbedAccent = options.useEmbedAccent === true;
    const showProgressLabels = options.showProgressLabels === true;
    const progressColor = useEmbedAccent ? accentColor : normalizeColorNumber(options.progressColor || '#9d9ad1');
    const showDisabledNowPlayingInfo = compactPlayLayout && options.includeControls && !settings.buttons;

    const interactiveRows = options.includeControls && settings.buttons
        ? buildMusicComponents({
            liked: !!options.liked,
            paused: !!player.isPaused,
            artistTracks: options.artistTracks || [],
            selectedFilter: options.selectedFilter || player.data?.activeFilter || 'clear',
            selectedArtistIndex: options.selectedArtistIndex ?? null,
            showControls: true,
            compactControls: compactPlayLayout,
        })
        : [];

    const section = new SectionBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent([
                `### ${titleLine}`,
                autoPlayLine ? `*${autoPlayLine}*` : null,
            ].filter(Boolean).join('\n')),
        );

    if (artworkUrl) {
        section.setThumbnailAccessory(new ThumbnailBuilder().setURL(artworkUrl).setDescription('\u200b'));
    }

    if (compactPlayLayout) {
        // ── Button-press fast path: reuse the last rendered progress bar ──────────
        // Canvas image generation is synchronous and CPU-heavy; running it on every
        // button click blocks the Node.js event loop for ALL bots in the process.
        // When reuseProgressBar=true (button presses), we reuse the last stored
        // image — the periodic progress-update timer still regenerates it every few
        // seconds, so it stays visually accurate without blocking on every click.
        const cachedBar = options.reuseProgressBar ? player?.data?._lastProgressBarCache : null;
        const progress = cachedBar || buildProgressBarAttachment({
            position: currentTime,
            duration: totalTime,
            color: progressColor,
            currentLabel: shortDuration(currentTime),
            durationLabel: shortDuration(totalTime),
            width: options.progressWidth || 800,
            height: 52,
            variant: 'discordCompact',
        });
        // Store for reuse by subsequent button presses
        if (player?.data && progress?.attachment) {
            player.data._lastProgressBarCache = progress;
        }

        const container = new ContainerBuilder()
            .addSectionComponents(section)
            .addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder()
                        .setURL(`attachment://${progress.name}`),
                ),
            );

        if (useEmbedAccent) container.setAccentColor(accentColor);

        if (options.showInfoRow === true || showDisabledNowPlayingInfo) {
            container.addActionRowComponents(buildNowPlayingMetaRow(
                tokenObj,
                currentTime,
                totalTime,
                'np',
                track,
                player,
                {
                    platform: options.infoPlatform !== false,
                    time: showDisabledNowPlayingInfo ? false : options.infoTime !== false,
                    volume: showDisabledNowPlayingInfo ? true : options.infoVolume === true,
                    loop: showDisabledNowPlayingInfo ? true : options.infoLoop === true,
                    requester: requester || null,
                },
            ));
        }

        if (interactiveRows.length) {
            container.addActionRowComponents(...interactiveRows);
        }

        return {
            flags: MessageFlags.IsComponentsV2,
            components: [container],
            files: [{ attachment: progress.attachment, name: progress.name }],
            attachments: [],
            allowedMentions: { parse: [] },
        };
    }

    const meta = `${loopMode}  ${volume}%  ${requesterName}`;
    const barLine = buildInlineProgressBar(currentTime, totalTime, 22, meta);

    const container = new ContainerBuilder()
        .addSectionComponents(section)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(barLine),
        );
    if (useEmbedAccent) container.setAccentColor(accentColor);

    if (interactiveRows.length) {
        container
            .addSeparatorComponents(
                new SeparatorBuilder()
                    .setDivider(false)
                    .setSpacing(SeparatorSpacingSize.Small),
            )
            .addActionRowComponents(...interactiveRows);
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        allowedMentions: { parse: [] },
    };
}

function platformDisplay(source, client = null) {
    const names = {
        auto: 'Smart Search',
        ytsearch: 'YouTube',
        ytmsearch: 'YouTube Music',
        scsearch: 'SoundCloud',
        spsearch: 'Spotify',
        amsearch: 'Apple Music',
        dzsearch: 'Deezer',
    };
    const emojiData = MUSIC_EMOJIS.platforms[source];
    const emoji = emojiData ? MUSIC_EMOJIS.messageEmoji(emojiData, client, typeof emojiData === 'string' ? emojiData : '') : '';
    return `${emoji ? `${emoji} ` : ''}${names[source] || source || 'YouTube'}`;
}

function buildBotInfoEmbed(TrueMusic, tokenObj, guildId) {
    const settings = displaySettings(tokenObj);
    const guild = TrueMusic.guilds.cache.get(guildId);
    const me = guild?.members?.me;
    const voiceChannel = me?.voice?.channel;
    const player = TrueMusic.poru.players.get(guildId);
    const currentTrack = player?.currentTrack;
    const nodeName = player?.node?.options?.name || player?.node?.options?.host || 'Offline';
    const activeFilter = player?.data?.activeFilter || 'clear';
    const uptime = TrueMusic.readyAt
        ? `<t:${Math.floor(TrueMusic.readyAt.getTime() / 1000)}:R>`
        : 'Unknown';

    const playback = currentTrack
        ? [
            `**Song :** **${(currentTrack.info?.title || 'Unknown').slice(0, 80)}**`,
            `**Volume :** \`${player.volume || 100}%\``,
            `**Loop :** \`${player.loop === 'TRACK' ? 'ON' : 'OFF'}\``,
            `**Autoplay :** \`${player.data?.autoPlay ? 'ON' : 'OFF'}\``,
            `**Filter :** \`${FILTER_NAMES[activeFilter] || activeFilter}\``,
        ].join('\n')
        : '> **Nothing is playing right now.**';

    return new EmbedBuilder()
        .setColor(getEmbedColor(TrueMusic))
        .setAuthor({
            name: TrueMusic.user?.username || 'Music Bot',
            iconURL: TrueMusic.user?.displayAvatarURL?.({ dynamic: true }),
        })
        .setTitle('Bot Info')
        .setThumbnail(TrueMusic.user?.displayAvatarURL?.({ dynamic: true, size: 256 }))
        .addFields(
            {
                name: 'Bot',
                value: [
                    `**Name :** **${TrueMusic.user?.username || 'Unknown'}**`,
                    `**ID :** \`${TrueMusic.user?.id || 'Unknown'}\``,
                    `**Ping :** \`${Math.round(TrueMusic.ws.ping || 0)}ms\``,
                    `**Uptime :** ${uptime}`,
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Music',
                value: [
                    `**Platform :** ${platformDisplay(settings.platform, TrueMusic)}`,
                    `**Voice :** ${voiceChannel ? `<#${voiceChannel.id}>` : '`Not Connected`'}`,
                    `**Node :** \`${nodeName}\``,
                ].join('\n'),
                inline: true,
            },
            {
                name: 'Display',
                value: [
                    `**Buttons :** \`${settings.buttons ? 'ON' : 'OFF'}\``,
                    `**Embeds :** \`${settings.embeds ? 'ON' : 'OFF'}\``,
                    `**Prefix :** \`${tokenObj?.prefix || 'No Prefix'}\``,
                ].join('\n'),
                inline: true,
            },
            {
                name: 'Now Playing',
                value: playback,
                inline: false,
            },
        )
        .setFooter({ text: TrueMusic.user?.username || 'Music Bot' })
        .setTimestamp();
}

function disableComponents(components = []) {
    const disableOne = (component) => {
        const data = typeof component?.toJSON === 'function'
            ? component.toJSON()
            : (component?.data || component || {});
        const type = data.type;

        if (type === ComponentType.Button || type === ComponentType.StringSelect) {
            return { ...data, disabled: true };
        }

        if (Array.isArray(data.components)) {
            return { ...data, components: data.components.map(disableOne) };
        }

        if (data.accessory) {
            return { ...data, accessory: disableOne(data.accessory) };
        }

        return data;
    };

    return components.map(disableOne);
}

function ensurePlayerData(player) {
    if (!player.data) player.data = {};
    if (!player.data.queuePanels) player.data.queuePanels = new Map();
    if (!Number.isFinite(player.data.queueVersion)) player.data.queueVersion = 0;
    return player.data;
}

function trackIdentity(track) {
    const info = track?.info || track || {};
    return track?.track || info.uri || info.identifier || [info.sourceName, info.author, info.title, info.length].filter(Boolean).join(':');
}

function warnPlayerOnce(player, key, message, minDelay = 30_000) {
    const data = ensurePlayerData(player);
    if (!data.warningLog) data.warningLog = {};
    const now = Date.now();
    if (now - Number(data.warningLog[key] || 0) < minDelay) return;
    data.warningLog[key] = now;
    console.warn(message);
}

function clearProgressInterval(player, reason = '') {
    if (!player?.data?.progressInterval) return;
    clearInterval(player.data.progressInterval);
    player.data.progressInterval = null;
    if (reason && process.env.DEBUG_PROGRESS) console.warn(`[ProgressUpdate] cleared interval: ${reason}`);
}

/**
 * Safe wrapper for editing a Discord message.
 * Components V2 messages (IS_COMPONENTS_V2 flag) cannot have `content`,
 * `embeds`, or `tts` fields. If the target message is V2 and the new
 * payload would include those fields, we skip the edit to avoid the
 * MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2 API error.
 */
async function safeEditMessage(msg, payload) {
    if (!msg || !payload) return;
    const isV2 = msg.flags?.has?.(MessageFlags.IsComponentsV2);
    if (isV2) {
        const payloadIsV2 = !!(payload.flags & MessageFlags.IsComponentsV2);
        if (!payloadIsV2) {
            // Payload is content/embed-based but message is V2 — skip to avoid API error
            return;
        }
        // Strip any accidental legacy fields
        const safe = { ...payload };
        delete safe.content;
        delete safe.embeds;
        delete safe.tts;
        return msg.edit(safe);
    }
    return msg.edit(payload);
}

function safeProgressTimes(player, track, options = {}) {
    ensurePlayerData(player);
    const totalTime = Math.max(0, Number(options.durationOverride ?? track?.info?.length ?? 0));
    const hasOverride = options.positionOverride !== undefined;
    let rawPosition = Number(options.positionOverride ?? player?.position ?? player?.data?.lastPosition ?? 0);

    if (!Number.isFinite(rawPosition) || rawPosition < 0) {
        warnPlayerOnce(
            player,
            'invalid-progress-position',
            `[ProgressUpdate] invalid position for ${trackIdentity(track) || 'unknown'}: ${rawPosition}`,
        );
        rawPosition = 0;
    }

    if (!hasOverride && totalTime > 0 && rawPosition > totalTime + 3000) {
        const lastPosition = Number(player?.data?.lastPosition || 0);
        const elapsed = player?.data?.trackStartedAt ? Date.now() - player.data.trackStartedAt : 0;
        const fallback = [lastPosition, elapsed]
            .filter(value => Number.isFinite(value) && value >= 0 && value <= totalTime + 3000)
            .sort((a, b) => b - a)[0] || 0;
        warnPlayerOnce(
            player,
            'overshoot-progress-position',
            `[ProgressUpdate] position overshoot ignored for ${trackIdentity(track) || 'unknown'}: ${rawPosition}/${totalTime}, using ${fallback}`,
        );
        rawPosition = fallback;
    }

    const currentTime = totalTime > 0 ? Math.min(rawPosition, totalTime) : Math.max(0, rawPosition);
    return { currentTime, totalTime };
}

function isNaturalTrackEnd(reason) {
    const value = String(reason || '').toLowerCase();
    return value === 'finished' || value === 'finish' || value.includes('finish');
}

function rememberTextChannel(player, channelId) {
    if (!player || !channelId) return;
    ensurePlayerData(player);
    player.textChannel = channelId;
    player.data.lastTextChannel = channelId;
}

function canSendMusicPanel(channel) {
    if (!channel || typeof channel.send !== 'function') return false;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return false;
    return true;
}

async function resolveNowPlayingTextChannel(client, player, tokenObj = null) {
    const data = ensurePlayerData(player);
    const candidates = [
        data.lastTextChannel,
        player?.textChannel,
        tokenObj?.chat,
        tokenObj?.textChannel,
        tokenObj?.logChannel,
    ].filter(Boolean);

    for (const candidate of candidates) {
        const id = typeof candidate === 'string' ? candidate : candidate?.id;
        let channel = id ? client.channels.cache.get(id) : candidate;
        if (!channel && id) channel = await client.channels.fetch(id).catch(() => null);
        if (canSendMusicPanel(channel)) {
            rememberTextChannel(player, channel.id);
            return channel;
        }
    }

    // Do not fall back to an arbitrary guild text channel. If the configured
    // channel candidates are missing/stale, skipping the panel is safer than
    // posting controls into staff/log/unrelated channels based on cache order.
    return null;
}

function ensureTrackRequester(track, player, fallbackUser) {
    if (!track?.info) return fallbackUser || null;
    const requester = track.info.requester || player?.data?.lastRequester || fallbackUser || null;
    if (requester) {
        track.info.requester = requester;
        if (player) ensurePlayerData(player).lastRequester = requester;
    }
    return requester;
}

function recoverableTrackErrorMessage(data) {
    return String(
        data?.reason
        || data?.exception?.message
        || data?.exception?.cause
        || data?.message
        || data?.type
        || ''
    );
}

function isRecoverableTrackError(data) {
    const message = recoverableTrackErrorMessage(data);
    return /voice|session|connection|websocket|socket|timeout|timed out|closed|reset|aborted|no such player|not connected|server update|endpoint/i.test(message);
}

function registerQueuePanel(player, message, version) {
    if (!player || !message) return;
    const data = ensurePlayerData(player);
    data.queuePanels.set(message.id, { message, version });
}

function totalDuration(tracks = []) {
    return tracks.reduce((sum, track) => {
        const length = Number(track?.info?.length || 0);
        return Number.isFinite(length) && length > 0 ? sum + length : sum;
    }, 0);
}

function queueTitle(guildName, client = null) {
    const emoji = MUSIC_EMOJIS.messageEmoji?.(MUSIC_EMOJIS.queue, client, '') || '';
    return `${emoji ? `${emoji} ` : ''}${guildName} Queue`;
}

function buildQueueFooter(player, page = 0, itemsPerPage = 8) {
    const totalPages = Math.max(1, Math.ceil(player.queue.length / itemsPerPage));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    return `Track : ${player.queue.length} | Page : ${safePage + 1}/${totalPages} | Total time : ${shortDuration(totalDuration(Array.from(player.queue || [])))}`;
}

function buildQueueDescription(player, page = 0, itemsPerPage = 8) {
    const totalPages = Math.max(1, Math.ceil(player.queue.length / itemsPerPage));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageTracks = player.queue.slice(safePage * itemsPerPage, (safePage + 1) * itemsPerPage);

    const queueTrackLink = (track, max = 68) => {
        const title = escapeMarkdownLinkText(track?.info?.title || 'Unknown', max);
        const url = isHttpUrl(track?.info?.uri) ? track.info.uri : null;
        return url ? `[${title}](${url})` : title;
    };

    const dur = (track) => shortDuration(track?.info?.length);
    const nowPlaying = player.currentTrack;

    const npAuthor = cleanInlineText(nowPlaying?.info?.author, '', 40);
    const npLine = [
        `> ${queueTrackLink(nowPlaying, 74)}`,
        `> \`${dur(nowPlaying)}\`${npAuthor ? ` • ${npAuthor}` : ''}`,
    ].join('\n');

    const queuedLines = pageTracks.map((track, i) => {
        const absolute = safePage * itemsPerPage + i + 1;
        return `**#${absolute} : ** ${queueTrackLink(track, 82)}`;
    });

    const upcomingHeader = '**Upcoming :**';

    return [
        '**Now Playing**',
        npLine,
        '',
        '',
        upcomingHeader,
        '',
        queuedLines.length ? queuedLines.join('\n\n') : '> No queued songs.',
    ].join('\n');
}

function buildQueueComponents(player, tokenObj, refId, page = 0, itemsPerPage = 8) {
    if (!displaySettings(tokenObj).buttons || player.queue.length === 0) return [];
    const totalPages = Math.max(1, Math.ceil(player.queue.length / itemsPerPage));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageTracks = player.queue.slice(safePage * itemsPerPage, (safePage + 1) * itemsPerPage);
    const dur = (track) => shortDuration(track?.info?.length);
    const rows = [];
    if (pageTracks.length) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`queue_${refId}_reorder`)
                .setPlaceholder('Select tracks to move to top')
                .setMinValues(1)
                .setMaxValues(Math.min(pageTracks.length, 25))
                .addOptions(pageTracks.map((track, i) => {
                    const absolute = safePage * itemsPerPage + i;
                    const label = `${absolute + 1}. ${track.info.title || 'Unknown'}`.slice(0, 99);
                    return {
                        label,
                        value: String(absolute),
                        description: `${dur(track)} · ${(track.info.author || 'Unknown').slice(0, 70)}`.slice(0, 99),
                    };
                }))
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`queue_${refId}_prev`)
            .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.pagePrev))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage === 0),
        new ButtonBuilder()
            .setCustomId(`queue_${refId}_next`)
            .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.pageNext))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage >= totalPages - 1),
        new ButtonBuilder()
            .setCustomId(`queue_${refId}_clear`)
            .setLabel('Clear Queue')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`queue_${refId}_close`)
            .setLabel('Close')
            .setStyle(ButtonStyle.Secondary),
    ));
    return rows;
}

async function expireQueuePanels(player, reason = 'queue_changed', preserveMessageId = null) {
    const panels = player?.data?.queuePanels;
    if (!panels?.size) return;

    const entries = [...panels.entries()];
    const toDisable = [];
    panels.clear();

    for (const [messageId, entry] of entries) {
        if (preserveMessageId && messageId === preserveMessageId) {
            panels.set(messageId, entry);
        } else {
            toDisable.push(entry);
        }
    }

    await Promise.allSettled(toDisable.map(async ({ message }) => {
        if (!message?.editable && typeof message?.edit !== 'function') return;
        const components = message.components?.length ? disableComponents(message.components) : [];
        await message.edit({ components }).catch(() => {});
    }));

    player.data.lastQueuePanelReason = reason;
}

async function bumpQueueVersion(player, reason = 'queue_changed', preserveMessageId = null) {
    if (!player) return 0;
    const data = ensurePlayerData(player);
    data.queueVersion += 1;
    await expireQueuePanels(player, reason, preserveMessageId);
    return data.queueVersion;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function hasPlayerVoiceSession(player) {
    const voice = player?.connection?.voice;
    return !!(voice?.sessionId && voice?.token && voice?.endpoint);
}

function markPlayerNeedsVoiceRefresh(player, reason = 'idle') {
    if (!player) return false;
    const data = ensurePlayerData(player);
    data.needsVoiceRefresh = true;
    data.voiceRefreshReason = reason;
    data.voiceRefreshMarkedAt = Date.now();
    if (process.env.DEBUG_RECOVERY) {
        console.log(`[VoiceRefresh] marked player ${player.guildId} for voice refresh: ${reason}`);
    }
    return true;
}

async function requestPlayerVoiceStateRefresh(player, reason = 'voice_refresh', forceToggle = false) {
    if (!player?.voiceChannel || typeof player.connect !== 'function') return false;

    // Guard: make sure the Discord WS shard is READY before sending voice state.
    // When Lavalink exhausts resources it can stall the Node.js event loop long
    // enough for Discord to close the gateway.  The shard reconnects shortly
    // after, but poru's recovery loop may fire before it is ready, producing
    // "RangeError: Shard 0 not found" and leaving the player stuck forever.
    const discordClient = player.poru?.client;
    if (discordClient?.ws?.shards?.size > 0) {
        try {
            const guildId = player.guildId;
            const shardCount = discordClient.ws.shards.size;
            const shardId = guildId
                ? Number((BigInt(guildId) >> 22n) % BigInt(shardCount))
                : 0;
            const shard = discordClient.ws.shards.get(shardId);
            // WebSocketShardStatus.Ready === 0 in discord.js v14
            if (!shard || shard.status !== 0) {
                markPlayerNeedsVoiceRefresh(player, `${reason}:shard_not_ready`);
                return false;
            }
        } catch {
            // If the shard check itself throws, bail out safely
            markPlayerNeedsVoiceRefresh(player, `${reason}:shard_check_error`);
            return false;
        }
    }

    const payload = (deaf = player.deaf ?? true) => ({
        guildId: player.guildId,
        voiceChannel: player.voiceChannel,
        textChannel: player.textChannel,
        deaf,
        mute: player.mute ?? false,
    });

    try {
        if (forceToggle) {
            player.connect(payload(!(player.deaf ?? true)));
            await wait(80);
        }
        player.connect(payload(player.deaf ?? true));
        ensurePlayerData(player).lastVoiceStateRefreshRequest = { reason, at: Date.now(), forceToggle };
        return true;
    } catch (err) {
        // Shard disappeared between the check and the send — mark for retry
        if (err instanceof RangeError && String(err.message).includes('Shard')) {
            markPlayerNeedsVoiceRefresh(player, `${reason}:shard_gone`);
            return false;
        }
        warnPlayerOnce(player, 'voice-state-refresh-failed', `[VoiceRefresh] gateway refresh failed for ${player.guildId}: ${err?.message || err}`);
        return false;
    }
}

async function refreshPlayerVoiceSession(player, reason = 'play') {
    if (!player) return false;
    const data = ensurePlayerData(player);
    if (!player.node?.isConnected || !player.node?.rest) {
        markPlayerNeedsVoiceRefresh(player, `${reason}:node_offline`);
        return false;
    }

    if (!hasPlayerVoiceSession(player)) {
        await requestPlayerVoiceStateRefresh(player, `${reason}:missing_voice`, false);
        await waitUntil(() => hasPlayerVoiceSession(player), 800, 25);
    }

    if (!hasPlayerVoiceSession(player)) {
        markPlayerNeedsVoiceRefresh(player, `${reason}:missing_voice`);
        warnPlayerOnce(player, 'voice-session-missing', `[VoiceRefresh] missing Discord voice session for ${player.guildId}; play will retry on next voice update`);
        return false;
    }

    const applyVoice = async () => {
        await updateLavalinkPlayer(player, {
            voice: player.connection.voice,
            paused: false,
        }, 'voice session refresh');
    };

    try {
        await applyVoice();
    } catch (err) {
        await requestPlayerVoiceStateRefresh(player, `${reason}:retry`, true);
        await waitUntil(() => hasPlayerVoiceSession(player), 400, 25);
        await applyVoice();
    }

    data.needsVoiceRefresh = false;
    data.lastVoiceRefreshAt = Date.now();
    data.lastVoiceRefreshReason = reason;

    // Fix #6: أعد إرسال الفلاتر — session جديد = Lavalink ينسى كل شيء
    lavalinkKeepAlive.reapplyPlayerFilters(player).catch(() => {});

    return true;
}

function scheduleSafePlayRetry(player, reason = 'voice_retry') {
    if (!player?.queue?.length) return false;
    const data = ensurePlayerData(player);
    if (data.pendingVoicePlayRetry) return true;
    const attempts = Number(data.voicePlayRetryAttempts || 0);
    if (attempts >= 2) return false;

    data.voicePlayRetryAttempts = attempts + 1;
    data.pendingVoicePlayRetry = true;
    const timer = setTimeout(() => {
        data.pendingVoicePlayRetry = false;
        safePlay(player).catch(err => {
            warnPlayerOnce(player, 'voice-play-retry-failed', `[VoiceRefresh] retry play failed for ${player.guildId}: ${err?.message || err}`);
        });
    }, 1500);
    timer.unref?.();
    data.lastVoicePlayRetryReason = reason;
    return true;
}

async function safePlay(player) {
    if (!player?.queue?.length) return false;
    if (player.isPlaying || player.isPaused) return false;
    const data = ensurePlayerData(player);
    const idleTooLong = !player.currentTrack
        && !player.isPlaying
        && data.lastIdleAt
        && Date.now() - data.lastIdleAt >= IDLE_PLAYER_REFRESH_MS;
    const isFreshConnection = data.createdAt && Date.now() - data.createdAt < 5000;
    const missingEstablishedVoice = !hasPlayerVoiceSession(player) && !isFreshConnection;
    if (data.needsVoiceRefresh || idleTooLong || missingEstablishedVoice) {
        const refreshed = await refreshPlayerVoiceSession(player, 'safe_play');
        if (!refreshed) return scheduleSafePlayRetry(player, 'voice_not_ready');
    }
    const queuedTrack = player.queue[0] || null;
    try {
        await player.play();
    } catch (err) {
        if (player.currentTrack && player.currentTrack === queuedTrack && typeof player.queue?.unshift === 'function') {
            player.queue.unshift(player.currentTrack);
        }
        player.currentTrack = null;
        player.isPlaying = false;
        player.isPaused = false;
        markPlayerNeedsVoiceRefresh(player, `play_error:${err?.message || 'unknown'}`);
        if (scheduleSafePlayRetry(player, 'play_error')) return false;
        throw err;
    }
    if (player.isPlaying) {
        data.voicePlayRetryAttempts = 0;
        data.pendingVoicePlayRetry = false;
    }
    return true;
}

function runBackground(label, task) {
    setImmediate(() => {
        Promise.resolve()
            .then(task)
            .catch(err => console.warn(`[${label}] ${err?.message || err}`));
    });
}

function firePlayerAction(label, task) {
    try {
        Promise.resolve(task())
            .catch(err => console.warn(`[${label}] ${err?.message || err}`));
    } catch (err) {
        console.warn(`[${label}] ${err?.message || err}`);
    }
}

const MUSIC_CONTROL_SYNC_TIMEOUT_MS = Math.max(100, Number(process.env.MUSIC_CONTROL_SYNC_TIMEOUT_MS || 250));
const LAVALINK_FAST_REST_TIMEOUT_MS = Math.max(200, Number(process.env.LAVALINK_FAST_REST_TIMEOUT_MS || 600));
const LAVALINK_FAST_REST_ENABLED = process.env.LAVALINK_FAST_REST !== 'off';

function playerVolumeValue(player) {
    const value = Number(player?.volume);
    return Number.isFinite(value) ? value : 100;
}

function clampPlayerVolume(volume) {
    const value = Number(volume);
    if (!Number.isFinite(value)) return 100;
    return Math.max(0, Math.min(1000, Math.round(value)));
}

function assertLavalinkRestOk(response, label = 'Lavalink request') {
    if (!response) throw new Error(`${label} did not return a response`);
    if (response.error || Number(response.status) >= 400) {
        throw new Error(response.message || response.error || `${label} failed`);
    }
}

function lavalinkRestOrigin(node) {
    const origin = node?.rest?.url || node?.restURL;
    if (origin) return String(origin).replace(/\/+$/, '');
    const host = node?.options?.host;
    const port = node?.options?.port;
    if (!host || !port) return '';
    return `http${node.secure ? 's' : ''}://${host}:${port}`;
}

function lavalinkRestAgent(origin) {
    if (!origin) return undefined;
    let agent = lavalinkRestAgents.get(origin);
    if (!agent) {
        agent = new UndiciAgent({
            connections: Math.max(4, Number(process.env.LAVALINK_REST_CONNECTIONS || 16)),
            pipelining: Math.max(4, Number(process.env.LAVALINK_REST_PIPELINING || 8)),
            keepAliveTimeout: Math.max(30_000, Number(process.env.LAVALINK_REST_KEEPALIVE_MS || 120_000)),
            keepAliveMaxTimeout: Math.max(60_000, Number(process.env.LAVALINK_REST_KEEPALIVE_MAX_MS || 300_000)),
            connect: { timeout: 2000 },
        });
        lavalinkRestAgents.set(origin, agent);
    }
    return agent;
}

async function readUndiciBody(body) {
    if (!body) return '';
    if (typeof body.text === 'function') return body.text().catch(() => '');
    if (typeof body.dump === 'function') {
        await body.dump().catch(() => {});
        return '';
    }
    return '';
}

async function drainUndiciBody(body) {
    if (!body) return;
    if (typeof body.dump === 'function') {
        await body.dump().catch(() => {});
        return;
    }
    if (typeof body.text === 'function') await body.text().catch(() => {});
}

function parseRestErrorText(text) {
    if (!text) return '';
    try {
        const parsed = JSON.parse(text);
        return parsed.message || parsed.error || text;
    } catch {
        return text;
    }
}

async function fastUpdateLavalinkPlayer(player, data, label = 'Lavalink update') {
    if (!LAVALINK_FAST_REST_ENABLED) throw new Error('fast rest disabled');
    const node = player?.node;
    const sessionId = node?.sessionId || node?.rest?.sessionId;
    const origin = lavalinkRestOrigin(node);
    const password = node?.password || node?.rest?.password;
    if (!player?.guildId || !node?.isConnected || !sessionId || !origin || !password) {
        throw new Error('fast rest unavailable');
    }

    const endpoint = `${origin}/v4/sessions/${sessionId}/players/${player.guildId}?noReplace=false`;
    const response = await undiciRequest(endpoint, {
        method: 'PATCH',
        dispatcher: lavalinkRestAgent(origin),
        headers: {
            'content-type': 'application/json',
            authorization: password,
        },
        body: JSON.stringify(data),
        headersTimeout: LAVALINK_FAST_REST_TIMEOUT_MS,
        bodyTimeout: LAVALINK_FAST_REST_TIMEOUT_MS,
    });

    if (response.statusCode >= 400) {
        const text = await readUndiciBody(response.body);
        throw new Error(parseRestErrorText(text) || `${label} failed with ${response.statusCode}`);
    }

    await drainUndiciBody(response.body);
    return { status: response.statusCode, ok: true };
}

async function updateLavalinkPlayer(player, data, label = 'Lavalink update') {
    if (!player?.node?.rest) throw new Error('player is not connected');
    try {
        return await fastUpdateLavalinkPlayer(player, data, label);
    } catch (err) {
        if (process.env.DEBUG_FAST_REST) {
            console.warn(`[FastRest] fallback for ${label}: ${err?.message || err}`);
        }
    }

    const response = await player.node.rest.updatePlayer({
        guildId: player.guildId,
        data,
    });
    assertLavalinkRestOk(response, label);
    return response;
}

function waitUntil(predicate, timeoutMs = 500, intervalMs = 25) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const tick = () => {
            if (predicate()) return resolve(true);
            if (Date.now() - startedAt >= timeoutMs) return resolve(false);
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

async function setPlayerVolumeSynced(player, volume) {
    const nextVolume = clampPlayerVolume(volume);
    player.volume = nextVolume;
    updateLavalinkPlayer(player, { volume: nextVolume }, 'volume update').catch(() => {});
    return nextVolume;
}

function waitForPlaybackTransition(poru, player, previousTrack, timeoutMs = MUSIC_CONTROL_SYNC_TIMEOUT_MS) {
    if (!poru || !player) return Promise.resolve(false);
    const previousId = trackIdentity(previousTrack || player.currentTrack);

    return new Promise(resolve => {
        let settled = false;
        let timer = null;
        const samePlayer = target => target?.guildId === player.guildId;
        const cleanup = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            poru.off?.('trackStart', onTrackStart);
            poru.off?.('queueEnd', onQueueEnd);
            resolve(result);
        };
        const onTrackStart = (target, track) => {
            if (!samePlayer(target)) return;
            const nextId = trackIdentity(track);
            if (!previousId || !nextId || nextId !== previousId) cleanup(true);
        };
        const onQueueEnd = (target) => {
            if (samePlayer(target)) cleanup(true);
        };

        poru.on('trackStart', onTrackStart);
        poru.on('queueEnd', onQueueEnd);
        timer = setTimeout(() => cleanup(false), timeoutMs);

        const currentId = trackIdentity(player.currentTrack);
        if (!player.currentTrack || (previousId && currentId && currentId !== previousId)) cleanup(true);
    });
}

async function skipPlayerSynced(poru, player, currentTrack) {
    // Reset pause state before skipping so the next queued track starts playing
    player.isPaused = false;
    player.position = 0;
    player.isPlaying = false;
    // Fire skip to Lavalink without awaiting — local state is already updated so
    // the bot feels instant. Lavalink will emit trackEnd which triggers the next
    // track regardless of how long the network roundtrip takes.
    updateLavalinkPlayer(player, { track: { encoded: null } }, 'skip update').catch(() => {});
    return true;
}

async function pausePlayerSynced(player, pause) {
    player.isPaused = pause;
    player.isPlaying = !pause;
    await updateLavalinkPlayer(player, { paused: pause }, pause ? 'pause update' : 'resume update');
    return pause;
}

async function runSyncedControl(label, task) {
    try {
        await task();
        return true;
    } catch (err) {
        console.warn(`[${label}] ${err?.message || err}`);
        return false;
    }
}

function finalUiOptionsFor(player, track, options = {}) {
    return {
        track,
        complete: options.complete === true,
        positionOverride: Math.max(0, Number(player?.position || player?.data?.lastPosition || 0)),
        durationOverride: Math.max(0, Number(track?.info?.length || 0)),
    };
}

async function stopPlayerAudio(player, options = {}) {
    if (!player) return false;
    const hadTrack = !!player.currentTrack;
    // Set local state immediately before the REST call so the bot
    // reflects stopped state even before Lavalink confirms
    player.isPaused = false;
    player.isPlaying = false;
    let stopRequest = Promise.resolve();
    if (player.node?.rest) {
        // Send paused:true + track:null together in one PATCH — Lavalink
        // silences the audio buffer immediately instead of draining it first
        stopRequest = updateLavalinkPlayer(
            player,
            { paused: true, track: { encoded: null } },
            'stop update'
        );
        if (options.wait === false) stopRequest = stopRequest.catch(() => {});
    }
    if (options.wait !== false) await stopRequest;
    player.currentTrack = null;
    player.isPlaying = false;
    player.isPaused = false;
    return hadTrack;
}

function isProbablyUrl(value) {
    if (!value) return false;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol);
    } catch {
        return false;
    }
}

function hasConnectedPoruNode(poru) {
    return [...(poru?.nodes?.values?.() || [])].some(node => node?.isConnected);
}

function restorePoruNodes(poru, client, reason = 'restore') {
    if (!poru) return false;
    if (!poru.userId && client?.user?.id) poru.userId = client.user.id;

    lavalinkKeepAlive.prepareNodes(poru);

    const nodes = [...(poru.nodes?.values?.() || [])];
    if (nodes.length > 0) {
        nodes.forEach(node => {
            try {
                node.attempt = 0;
                clearTimeout(node.reconnectAttempt);
                node.reconnectAttempt = null;
                const wsState = node.ws?.readyState;
                if (!node.isConnected && wsState !== 0 && wsState !== 1) {
                    node.connect?.().catch(() => {});
                }
            } catch {}
        });
        return true;
    }

    if (!Array.isArray(poru._nodes) || poru._nodes.length === 0) return false;

    if (!poru.isActivated) {
        poru.init().catch?.(() => {});
        return true;
    }

    poru._nodes.forEach(nodeOptions => {
        if (!nodeOptions?.name || poru.nodes?.has?.(nodeOptions.name)) return;
        Promise.resolve(poru.addNode(nodeOptions)).catch(err => {
            lavalinkConsole.updateBot(client, {
                state: 'restore_failed',
                event: 'restore_node_failed',
                node: nodeOptions.name,
                note: `${reason}: ${err?.message || err}`,
            });
        });
    });

    return true;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function promiseWithTimeout(promise, ms, label = 'operation timed out') {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(label)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function resolveWithNodeRetry(client, options, retries = 1) {
    const poru = client?.poru;
    if (!poru) throw new Error('Poru is not initialized.');
    const timeoutMs = Math.max(5000, Number(process.env.MUSIC_RESOLVE_TIMEOUT_MS || 9000));

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (!hasConnectedPoruNode(poru)) {
            restorePoruNodes(poru, client, 'resolve retry');
            if (attempt < retries) await wait(1200);
        }

        try {
            return await promiseWithTimeout(
                poru.resolve(options),
                timeoutMs,
                `Lavalink resolve timed out after ${timeoutMs}ms`,
            );
        } catch (err) {
            const message = err?.message || String(err || '');
            const noNodes = /no nodes are available/i.test(message);
            const retryable = noNodes || /timed out|timeout|econnreset|etimedout/i.test(message);
            if (!retryable || attempt >= retries) throw err;
            restorePoruNodes(poru, client, 'resolve failure');
            await wait(1200);
        }
    }

    return promiseWithTimeout(
        poru.resolve(options),
        timeoutMs,
        `Lavalink resolve timed out after ${timeoutMs}ms`,
    );
}

function isMemberDeafened(member) {
    const voice = member?.voice;
    return !!(voice?.deaf || voice?.selfDeaf || voice?.serverDeaf);
}

function deafenedPlaybackPayload(tokenObj) {
    return musicPayload(tokenObj, {
        title: 'Voice Deafened',
        description: 'فك الديفن أولاً ثم شغّل الأغنية.',
        thumbnail: 'attachment://Error.png',
        files: ['./assets/image/icons/Error.png'],
    });
}

function normalizeArabicSearch(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[إأآا]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/\s+/g, ' ')
        .trim();
}

const SEARCH_STOP_WORDS = new Set([
    'official', 'audio', 'video', 'lyrics', 'lyric', 'remix', 'cover', 'live', 'hd', '4k',
    'music', 'song', 'track', 'visualizer', 'remastered', 'feat', 'ft', 'prod',
    'clip', 'mv', 'version', 'full', 'sped', 'slowed', 'nightcore', 'bassboost',
    'اغنيه', 'اغنية', 'اغاني', 'أغنية', 'رسمي', 'الرسمية', 'كلمات', 'فيديو', 'كليب',
    'صوتي', 'موسيقي', 'موسيقى', 'حصري', 'جديد', 'نسخه', 'نسخة', 'ريمكس', 'لايف',
    'مسرع', 'بطيء', 'بطيئ', 'بدون', 'ايقاع', 'إيقاع',
]);

function normalizeSearchText(value) {
    return normalizeArabicSearch(String(value || '').toLowerCase())
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function searchTokens(value) {
    return normalizeSearchText(value)
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length > 1 && !SEARCH_STOP_WORDS.has(token));
}

function buildSearchVariants(query) {
    const raw = String(query || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeArabicSearch(raw);
    const variants = [
        raw,
        normalized,
        `${raw} official audio`,
        `${raw} lyrics`,
    ];

    return [...new Set(variants.filter(Boolean))];
}

function dedupeTracks(tracks = []) {
    const seen = new Set();
    const unique = [];

    for (const track of tracks) {
        const info = track?.info || {};
        const key = trackIdentity(track)
            || `${(info.title || '').toLowerCase()}|${(info.author || '').toLowerCase()}|${info.length || 0}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(track);
    }

    return unique;
}

function scoreTrackForQuery(track, query) {
    const tokens = searchTokens(query);
    if (!tokens.length) return { score: 1, coverage: 1, phraseHit: true };

    const info = track?.info || {};
    const title = normalizeSearchText(info.title);
    const author = normalizeSearchText(info.author);
    const combined = `${title} ${author}`.trim();
    const phrase = normalizeSearchText(query);
    const titleWords = new Set(title.split(' ').filter(Boolean));
    const authorWords = new Set(author.split(' ').filter(Boolean));
    let score = 0;
    let matched = 0;
    let phraseHit = false;

    if (phrase.length > 1) {
        if (title.includes(phrase)) {
            score += 70;
            phraseHit = true;
        } else if (combined.includes(phrase)) {
            score += 45;
            phraseHit = true;
        }
    }

    for (const token of tokens) {
        if (titleWords.has(token)) {
            score += 22;
            matched++;
        } else if (title.includes(token)) {
            score += 16;
            matched++;
        } else if (authorWords.has(token)) {
            score += 12;
            matched++;
        } else if (author.includes(token)) {
            score += 8;
            matched++;
        } else if (combined.includes(token)) {
            score += 5;
            matched++;
        }
    }

    const coverage = matched / tokens.length;
    score += coverage * 35;
    if (matched === tokens.length) score += 24;
    if (!matched && !phraseHit) score -= 80;

    const duration = Number(info.length || 0);
    if (duration > 0 && duration < 35000) score -= 6;
    if (duration > 0 && duration > 20 * 60 * 1000) score -= 4;

    return { score, coverage, phraseHit };
}

function rankTracksForQuery(tracks, query, { strict = false } = {}) {
    const unique = dedupeTracks(tracks);
    const tokens = searchTokens(query);
    if (!tokens.length) return unique;

    const minScore = strict ? (tokens.length === 1 ? 24 : 34) : 8;
    const minCoverage = strict ? (tokens.length <= 2 ? 1 : 0.55) : 0.25;

    const ranked = unique
        .map((track, index) => ({ track, index, ...scoreTrackForQuery(track, query) }))
        .filter(item => item.score >= minScore && (item.phraseHit || item.coverage >= minCoverage))
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .map(item => item.track);

    if (strict) return ranked;
    return ranked.length ? ranked : unique;
}

async function resolveSmartTracks(poru, query, source, limit = 20, options = {}) {
    const timeoutMs = Math.max(4000, Number(process.env.MUSIC_SMART_RESOLVE_TIMEOUT_MS || 8000));
    if (isProbablyUrl(query)) {
        const result = await withTimeout(poru.resolve({ query }), timeoutMs, null);
        return dedupeTracks(result?.tracks || []).slice(0, limit);
    }

    const variants = Array.isArray(options.variants) && options.variants.length
        ? [...new Set(options.variants.filter(Boolean))]
        : buildSearchVariants(query);
    const sources = source === 'auto'
        ? ['ytmsearch', 'ytsearch', 'scsearch', 'spsearch', 'amsearch', 'dzsearch']
        : [source || 'ytsearch'];
    const tracks = [];
    const prefetchLimit = Math.max(limit, limit * Math.max(1, Number(options.prefetchMultiplier || 2)));
    const perResolveLimit = Math.max(1, Math.min(8, Number(options.perResolveLimit || 8)));

    for (const searchSource of sources) {
        for (const variant of variants) {
            if (tracks.length >= prefetchLimit) break;
            const result = await withTimeout(
                poru.resolve({ query: variant, source: searchSource }).catch(() => null),
                timeoutMs,
                null,
            );
            if (result?.tracks?.length) tracks.push(...result.tracks.slice(0, perResolveLimit));
        }
    }

    return rankTracksForQuery(tracks, query, { strict: options.strict }).slice(0, limit);
}

const PLAY_PROGRESS_WIDTH = 400;
const STOP_RECONNECT_SUPPRESS_MS = Math.max(90_000, Number(process.env.MUSIC_STOP_RECONNECT_SUPPRESS_MS || 90_000));
const IDLE_PLAYER_REFRESH_MS = Math.max(5 * 60_000, Number(process.env.MUSIC_IDLE_PLAYER_REFRESH_MS || 30 * 60_000));
const GENERIC_LABEL_WORDS_PATTERN = /\b(?:records?|recordings?|label|music|musics|official|channel|productions?|producer|publisher|publishing|studios?|entertainment|media|network|group|company|distribution|distributor|digital|sound|audio|video|tv|vevo|youtube)\b|ري?كورد(?:ز)?|ميوزك|موسيقي|موسيقى|قناه|قناة|رسمي|رسميه|الرسمية|شركة|شركه|انتاج|الانتاج|للانتاج|للإنتاج|توزيع|ناشر|نشر|استوديو|ستوديو|ميديا|شبكه|شبكة|جروب|مجموعة|قروب|ساوند|صوت|تلفزيون|يوتيوب/i;
const KNOWN_LABEL_NAMES = [
    'rotana', 'rotana music', 'rotana audio', 'rotana video', 'rotana records',
    'mazzika', 'mazika', 'maziika', 'melody music', 'melody hits', 'nogoum records',
    'alam el fan', 'alam el phan', 'free music', 'platinum records', 'watary', 'watary production',
    'lifestylez studios', 'lifestylez', 'chabaka', 'qanawat', 'sono cairo', 'delta sound',
    'sout el hob', 'sout el fan', 'arabica music', 'arabica tv', 'music masters',
    'universal music', 'universal music group', 'sony music', 'sony music middle east',
    'warner music', 'warner music mena', 'emi', 'virgin music', 'believe music',
    'believe digital', 'awal', 'orchard', 'the orchard', 'tunecore', 'distrokid',
    'sony', 'warner', 'universal', 'virgin', 'believe', 'platinum', 'tseries',
    'zee', 'saregama', 'tips', 'venus', 'speed', 'spinnin', 'armada', 'ultra',
    'vevo', 'spinnin records', 'armada music', 'monstercat', 'ultra records',
    't series', 't-series', 'zee music', 'zee music company', 'saregama', 'speed records',
    'tips music', 'venus music', 'times music', 'coke studio', 'mtv', 'mbc',
    'روتانا', 'روتانا ميوزك', 'روتانا صوتيات', 'روتانا فيديو', 'مزيكا', 'مزيكا ميوزك',
    'ميلودي', 'ميلودي ميوزك', 'نجوم ريكوردز', 'نجوم', 'عالم الفن', 'فري ميوزك',
    'بلاتينوم ريكوردز', 'بلاتينيوم ريكوردز', 'وتري', 'واتري', 'لايف ستايلز',
    'لايف ستايلز ستوديوز', 'شبكة قنوات', 'قنوات', 'سونو كايرو', 'صوت القاهره',
    'صوت القاهرة', 'دلتا ساوند', 'صوت الحب', 'صوت الفن', 'ارابيكا', 'أرابيكا',
    'ميوزك ماسترز', 'يونيفرسال ميوزك', 'سوني ميوزك', 'وارنر ميوزك',
    'يونيفرسال', 'سوني', 'وارنر', 'بلاتينوم', 'بلاتينيوم',
    'تي سيريز', 'زي ميوزك', 'ساريغاما', 'سبيد ريكوردز', 'كوك ستوديو',
];
const NORMALIZED_LABEL_NAMES = KNOWN_LABEL_NAMES.map(normalizeSearchText).filter(Boolean);
const ARTIST_TRACK_CACHE_TTL_MS = 10 * 60 * 1000;
const ARTIST_TRACK_CACHE_MAX = 200;
const AUTOPLAY_HISTORY_MAX = 30;
const ARTIST_RANDOM_SOURCES = ['ytmsearch', 'spsearch', 'scsearch'];
const artistTrackCache = new Map();

function trimArtistCandidate(value) {
    return String(value || '')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/\s*(?:-|–|—)?\s*topic$/i, ' ')
        .replace(/\bvevo\b/ig, ' ')
        .replace(/\b(official|video|audio|lyrics?|lyric|clip|remix|hd|4k|music|channel)\b/ig, ' ')
        .replace(/\b(?:feat(?:uring)?|ft\.?|with|prod\.?)\b.*$/ig, ' ')
        .replace(/(?:مع|بمشاركة|برود)\s+.*$/g, ' ')
        .replace(/رسمي|الرسمية|فيديو|كليب|صوتي|كلمات|حصري|جديد|اغنيه|اغنية/g, ' ')
        .replace(/^[\s\-–—|:،,]+|[\s\-–—|:،,]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isLikelyLabelAuthor(author) {
    const raw = String(author || '').trim();
    if (!raw) return false;
    const normalized = normalizeSearchText(raw);
    if (GENERIC_LABEL_WORDS_PATTERN.test(raw) || GENERIC_LABEL_WORDS_PATTERN.test(normalized)) return true;
    const words = new Set(normalized.split(' ').filter(Boolean));
    return NORMALIZED_LABEL_NAMES.some((label) => {
        if (normalized === label) return true;
        const labelWords = label.split(' ').filter(Boolean);
        if (labelWords.length === 1) return words.has(label);
        return normalized.includes(label);
    });
}

function inferArtistFromTitle(title) {
    const raw = String(title || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';

    const parts = raw.split(/\s+(?:-|–|—|\|)\s+|\s*[–—|]\s*/).map(trimArtistCandidate).filter(Boolean);
    const candidate = parts[0] || '';
    const tokenCount = searchTokens(candidate).length;

    if (!candidate || candidate.length < 2 || candidate.length > 80) return '';
    if (tokenCount > 7 || isLikelyLabelAuthor(candidate)) return '';

    return candidate;
}

function artistQueryForTrack(track) {
    const info = track?.info || {};
    const rawAuthor = String(info.author || '').replace(/\s+/g, ' ').trim();
    const author = trimArtistCandidate(rawAuthor);
    const titleArtist = inferArtistFromTitle(info.title);
    const authorCandidate = author && !isLikelyLabelAuthor(author) ? author : '';

    if (titleArtist) {
        return {
            primary: titleArtist,
            fallback: authorCandidate && normalizeSearchText(authorCandidate) !== normalizeSearchText(titleArtist)
                ? authorCandidate
                : '',
        };
    }

    return {
        primary: authorCandidate,
        fallback: '',
    };
}

function artistCacheKey(source, artistName) {
    const normalized = normalizeSearchText(artistName);
    return `${source || 'auto'}:${normalized}`;
}

function getCachedArtistTracks(key) {
    const cached = artistTrackCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        artistTrackCache.delete(key);
        return null;
    }
    return cached.tracks;
}

function setCachedArtistTracks(key, tracks) {
    if (artistTrackCache.size >= ARTIST_TRACK_CACHE_MAX) {
        const oldest = artistTrackCache.keys().next().value;
        if (oldest) artistTrackCache.delete(oldest);
    }
    artistTrackCache.set(key, {
        expiresAt: Date.now() + ARTIST_TRACK_CACHE_TTL_MS,
        tracks,
    });
}

function stripArtistPrefixFromTitle(title) {
    const raw = String(title || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const parts = raw.split(/\s+(?:-|–|—|\|)\s+|\s*[–—|]\s*/).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return raw;

    const artist = trimArtistCandidate(parts[0]);
    const tokenCount = searchTokens(artist).length;
    if (!artist || tokenCount > 7 || isLikelyLabelAuthor(artist)) return raw;
    return parts.slice(1).join(' ').trim() || raw;
}

function canonicalTrackTitle(title) {
    const withoutArtist = stripArtistPrefixFromTitle(title);
    const cleaned = withoutArtist
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
        .replace(/\b(?:official|audio|video|lyrics?|lyric|clip|visualizer|remaster(?:ed)?|hd|4k|mv|m\/v|music|song|track|full|version)\b/ig, ' ')
        .replace(/\b(?:feat(?:uring)?|ft\.?|with|prod\.?|remix|cover|live|sped\s*up|slowed|nightcore)\b.*$/ig, ' ')
        .replace(/رسمي|الرسمية|فيديو|كليب|صوتي|كلمات|حصري|جديد|اغنيه|اغنية|نسخة|ريمكس|لايف|مسرع|بطيء/g, ' ');
    return searchTokens(cleaned).join(' ') || normalizeSearchText(cleaned);
}

const ARABIC_TO_LATIN_CHARS = {
    ا: 'a', أ: 'a', إ: 'a', آ: 'a', ٱ: 'a',
    ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh',
    د: 'd', ذ: 'th', ر: 'r', ز: 'z', س: 's', ش: 'sh',
    ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a', غ: 'gh',
    ف: 'f', ق: 'q', ك: 'k', گ: 'g', ل: 'l', م: 'm',
    ن: 'n', ه: 'h', ة: 'a', و: 'o', ي: 'i', ى: 'a',
    ئ: 'i', ؤ: 'o', لا: 'la',
};

const ARABIZI_DIGITS = new Map([
    ['2', 'a'],
    ['3', 'a'],
    ['4', 'sh'],
    ['5', 'kh'],
    ['6', 't'],
    ['7', 'h'],
    ['8', 'gh'],
    ['9', 's'],
]);

const TITLE_SIGNAL_STOP_WORDS = new Set([
    ...SEARCH_STOP_WORDS,
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'from', 'by', 'me',
    'my', 'you', 'your', 'i', 'we', 'us', 'يا', 'اي', 'أي', 'من', 'في', 'على', 'علي',
    'عن', 'مع', 'انا', 'انت', 'انتي', 'هذا', 'هذه', 'هو', 'هي', 'كل', 'كان',
]);

function roughLatinizeArabic(value) {
    return normalizeArabicSearch(value)
        .replace(/لا/g, 'la')
        .split('')
        .map(ch => ARABIC_TO_LATIN_CHARS[ch] || ch)
        .join('');
}

function normalizeCrossScriptText(value) {
    return roughLatinizeArabic(value)
        .toLowerCase()
        .replace(/[23456789]/g, digit => ARABIZI_DIGITS.get(digit) || digit)
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function latinSkeleton(value) {
    return normalizeCrossScriptText(value)
        .replace(/[aeiou]+/g, '')
        .replace(/(.)\1+/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleSignalTokens(value) {
    const direct = canonicalTrackTitle(value)
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length > 1 && !TITLE_SIGNAL_STOP_WORDS.has(token));
    const latin = normalizeCrossScriptText(canonicalTrackTitle(value))
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length > 1 && !TITLE_SIGNAL_STOP_WORDS.has(token));
    return [...new Set([...direct, ...latin])];
}

function distinctiveTitleTokens(value) {
    return titleSignalTokens(value).filter(token => {
        if (token.length >= 5) return true;
        if (/[\u0600-\u06FF]/.test(token) && token.length >= 4) return true;
        return latinSkeleton(token).length >= 4;
    });
}

function trackTitleFingerprints(trackOrTitle) {
    const rawTitle = typeof trackOrTitle === 'string'
        ? trackOrTitle
        : trackOrTitle?.info?.title;
    const canonical = canonicalTrackTitle(rawTitle);
    if (!canonical) return new Set();

    const tokens = titleSignalTokens(canonical);
    const sortedTokens = [...tokens].sort().join(' ');
    const compact = tokens.join('');
    const latin = normalizeCrossScriptText(canonical);
    const latinSorted = latin.split(' ').filter(Boolean).sort().join(' ');
    const skeleton = latinSkeleton(canonical);
    const tokenSkeletons = tokens
        .map(token => latinSkeleton(token))
        .filter(token => token.length >= 3)
        .sort()
        .join(' ');

    return new Set([
        canonical,
        sortedTokens,
        compact,
        latin,
        latinSorted,
        skeleton,
        tokenSkeletons,
    ].filter(value => value && value.length >= 3));
}

function sharesAnyFingerprint(a, b) {
    if (!a?.size || !b?.size) return false;
    for (const key of a) {
        if (b.has(key)) return true;
    }
    return false;
}

function songDuplicateKey(track) {
    const keys = [...trackTitleFingerprints(track)]
        .filter(key => key.length >= 3)
        .sort((a, b) => b.length - a.length);
    return keys[0]
        || normalizeSearchText(`${track?.info?.author || ''} ${track?.info?.title || ''}`)
        || trackIdentity(track);
}

function isNearSameTrackTitle(track, currentTrack) {
    const currentTitle = currentTrack?.info?.title;
    const nextTitle = track?.info?.title;
    if (!currentTitle || !nextTitle) return false;

    const currentFingerprints = trackTitleFingerprints(currentTitle);
    const nextFingerprints = trackTitleFingerprints(nextTitle);
    if (sharesAnyFingerprint(currentFingerprints, nextFingerprints)) return true;

    const currentCanonical = canonicalTrackTitle(currentTitle);
    const nextCanonical = canonicalTrackTitle(nextTitle);
    if (!currentCanonical || !nextCanonical) return false;
    if (currentCanonical === nextCanonical) return true;

    const currentTokens = new Set(currentCanonical.split(' ').filter(Boolean));
    const nextTokens = new Set(nextCanonical.split(' ').filter(Boolean));
    if (!currentTokens.size || !nextTokens.size) return false;

    let shared = 0;
    for (const token of currentTokens) {
        if (nextTokens.has(token)) shared++;
    }

    const smaller = Math.min(currentTokens.size, nextTokens.size);
    const larger = Math.max(currentTokens.size, nextTokens.size);
    if (smaller === 1) return shared === 1 && larger <= 2;
    return shared / smaller >= 0.8 && shared / larger >= 0.55;
}

function leaksCurrentTitleSignal(track, currentTrack) {
    const currentTitle = currentTrack?.info?.title;
    const nextTitle = track?.info?.title;
    if (!currentTitle || !nextTitle) return false;

    const artistSignals = new Set(titleSignalTokens(trimArtistCandidate(currentTrack?.info?.author)).flatMap(token => ([
        normalizeSearchText(token),
        normalizeCrossScriptText(token),
        latinSkeleton(token),
    ])));
    const currentDistinctive = distinctiveTitleTokens(currentTitle).filter(token => {
        const forms = [normalizeSearchText(token), normalizeCrossScriptText(token), latinSkeleton(token)];
        return !forms.some(form => form && artistSignals.has(form));
    });
    if (!currentDistinctive.length) return false;

    const nextText = normalizeSearchText(nextTitle);
    const nextLatinText = normalizeCrossScriptText(nextTitle);
    const nextSkeletonWords = new Set(latinSkeleton(nextTitle).split(' ').filter(Boolean));

    return currentDistinctive.some(token => {
        const normalized = normalizeSearchText(token);
        const latin = normalizeCrossScriptText(token);
        const skeleton = latinSkeleton(token);
        return (normalized.length >= 4 && nextText.split(' ').includes(normalized))
            || (latin.length >= 4 && nextLatinText.split(' ').includes(latin))
            || (skeleton.length >= 4 && nextSkeletonWords.has(skeleton));
    });
}

function trackMatchesArtist(track, artistName) {
    const artist = trimArtistCandidate(artistName);
    const artistTokens = searchTokens(artist);
    if (!artistTokens.length) return true;

    const info = track?.info || {};
    const authorText = normalizeSearchText(trimArtistCandidate(info.author));
    const titleText = normalizeSearchText(info.title);
    const combinedWords = new Set(`${authorText} ${titleText}`.split(' ').filter(Boolean));
    const artistPhrase = normalizeSearchText(artist);
    const artistPhraseWords = artistPhrase.split(' ').filter(Boolean);

    if (artistPhraseWords.length > 1 && (authorText.includes(artistPhrase) || titleText.includes(artistPhrase))) return true;
    if (artistPhraseWords.length === 1 && combinedWords.has(artistPhrase)) return true;

    let matched = 0;
    for (const token of artistTokens) {
        if (combinedWords.has(token)) matched++;
    }

    const required = artistTokens.length <= 2 ? artistTokens.length : Math.ceil(artistTokens.length * 0.67);
    return matched >= required;
}

function autoPlayDuplicateKey(track) {
    const duplicateKey = songDuplicateKey(track);
    if (duplicateKey) return duplicateKey;
    return normalizeSearchText(`${track?.info?.author || ''} ${track?.info?.title || ''}`) || trackIdentity(track);
}

function rememberAutoPlayHistory(player, track) {
    if (!player || !track) return;
    const key = autoPlayDuplicateKey(track);
    if (!key) return;
    const fingerprints = [...trackTitleFingerprints(track)].filter(k => k && k.length >= 3);
    const allKeys = [...new Set([key, ...fingerprints])];
    const data = ensurePlayerData(player);
    const history = Array.isArray(data.autoPlayHistory) ? data.autoPlayHistory : [];
    const existingSet = new Set(history);
    const toAdd = allKeys.filter(k => !existingSet.has(k));
    data.autoPlayHistory = [...toAdd, ...history].slice(0, AUTOPLAY_HISTORY_MAX * 7);
}

function autoPlayHistorySet(player) {
    const history = ensurePlayerData(player).autoPlayHistory;
    return new Set(Array.isArray(history) ? history.filter(Boolean) : []);
}

function clearAutoPlaySessionData(player) {
    if (!player?.data) return;
    delete player.data.autoPlayHistory;
    delete player.data.autoPlaySeedArtist;
}

function clearStoppedPlaybackCaches(player) {
    if (!player?.data) return;
    // Clear artistTrackCache entries for the seed artist of this player
    const seedArtist = player.data.autoPlaySeedArtist?.primary;
    if (seedArtist) {
        const normalized = normalizeSearchText(seedArtist);
        for (const key of artistTrackCache.keys()) {
            if (key.endsWith(`:${normalized}`)) artistTrackCache.delete(key);
        }
    }
    clearAutoPlaySessionData(player);
    if (player.data.ui) {
        player.data.ui.artistTracks = [];
        player.data.ui.selectedArtistIndex = null;
    }
}

function setAutoPlayState(player, enabled) {
    if (!player) return false;
    const data = ensurePlayerData(player);
    data.autoPlay = enabled === true;
    if (!data.autoPlay) clearAutoPlaySessionData(player);
    return data.autoPlay;
}

function hasHumanVoiceListener(client, player) {
    const guild = client?.guilds?.cache?.get?.(player?.guildId);
    const channelId = player?.voiceChannel || guild?.members?.me?.voice?.channelId;
    const states = guild?.voiceStates?.cache;
    if (!guild || !channelId || !states) return true;

    for (const state of states.values()) {
        if (state.channelId !== channelId) continue;
        if (state.id === client.user?.id) continue;
        const cachedUser = client.users?.cache?.get?.(state.id);
        const isBot = state.member?.user?.bot === true || cachedUser?.bot === true;
        if (!isBot) return true;
    }

    return false;
}

function disableIdlePlaybackModesIfAlone(client, player, reason = 'idle_voice') {
    if (!player || hasHumanVoiceListener(client, player)) return false;

    let changed = false;
    if (player.loop && player.loop !== 'NONE') {
        player.setLoop('NONE');
        changed = true;
    }
    if (player.data?.autoPlay) {
        setAutoPlayState(player, false);
        changed = true;
    }

    if (changed) {
        ensurePlayerData(player).lastIdleModeDisableReason = reason;
        if (process.env.DEBUG_IDLE_MODES) {
            console.warn(`[IdleModes] disabled loop/autoplay for ${player.guildId}: ${reason}`);
        }
    }

    return changed;
}

function filterArtistTracks(tracks, currentTrack, limit, artistName = '', options = {}) {
    const currentId = currentTrack?.info?.uri || currentTrack?.info?.identifier;
    const unique = dedupeTracks(tracks)
        .filter(t => (t.info.uri || t.info.identifier) !== currentId);
    const seenSongs = new Set();
    const uniqueSongs = [];
    for (const track of shuffleTracks(unique)) {
        const key = songDuplicateKey(track);
        if (key && seenSongs.has(key)) continue;
        const fingerprints = trackTitleFingerprints(track);
        if ([...fingerprints].some(item => seenSongs.has(item))) continue;
        if (key) seenSongs.add(key);
        for (const item of fingerprints) seenSongs.add(item);
        uniqueSongs.push(track);
    }
    const artistPool = artistName ? uniqueSongs.filter(t => trackMatchesArtist(t, artistName)) : uniqueSongs;
    const pool = artistPool.length ? artistPool : uniqueSongs;
    const history = options.historySet instanceof Set ? options.historySet : null;
    const withoutSameSong = pool.filter(t => !isNearSameTrackTitle(t, currentTrack) && !leaksCurrentTitleSignal(t, currentTrack));
    const withoutHistory = history
        ? withoutSameSong.filter(t => {
            if (history.has(autoPlayDuplicateKey(t))) return false;
            const fps = trackTitleFingerprints(t);
            return ![...fps].some(fp => history.has(fp));
        })
        : withoutSameSong;

    return shuffleTracks(withoutHistory).slice(0, limit);
}

function buildArtistCatalogQueries(artistName) {
    const artist = trimArtistCandidate(artistName);
    return [
        `${artist} songs`,
        artist,
    ].filter(Boolean);
}

function artistSearchSources(source) {
    const normalized = String(source || 'auto').toLowerCase();
    const mapped = normalized === 'ytsearch' ? 'ytmsearch' : normalized;
    const sources = ARTIST_RANDOM_SOURCES.includes(mapped)
        ? [mapped, ...ARTIST_RANDOM_SOURCES.filter(item => item !== mapped)]
        : ARTIST_RANDOM_SOURCES;
    return shuffleTracks(sources);
}

function withTimeout(promise, ms, fallback = []) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]).finally(() => clearTimeout(timer));
}

function randomTrack(tracks) {
    if (!tracks.length) return null;
    return tracks[Math.floor(Math.random() * tracks.length)] || null;
}

function shuffleTracks(tracks = []) {
    const copy = [...tracks];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

async function resolveQuickAutoPlayTrack(poru, artistQuery, source, currentTrack, player) {
    const artistName = typeof artistQuery === 'string' ? artistQuery : artistQuery?.primary;
    const fallbackName = typeof artistQuery === 'object' ? artistQuery.fallback : '';
    if (!artistName) return null;

    const historySet = autoPlayHistorySet(player);
    const sourceOrder = artistSearchSources(source);

    const names = [artistName];
    if (fallbackName && normalizeSearchText(fallbackName) !== normalizeSearchText(artistName)) {
        names.push(fallbackName);
    }

    for (const name of shuffleTracks(names)) {
        const artist = trimArtistCandidate(name);
        const query = `${artist} songs`;
        const variants = shuffleTracks([query, artist]).filter(Boolean);
        const results = await Promise.allSettled(sourceOrder.map(searchSource => withTimeout(
            resolveSmartTracks(poru, query, searchSource, 5, {
                variants,
                prefetchMultiplier: 1,
                perResolveLimit: 5,
            }),
            2500,
            [],
        )));
        const tracks = shuffleTracks(results.flatMap(item => item.status === 'fulfilled' ? item.value || [] : []));
        const candidates = filterArtistTracks(tracks, currentTrack, 12, name, { historySet });
        const picked = randomTrack(candidates);
        if (picked) return picked;
    }

    return null;
}

async function resolveCachedArtistQuery(poru, query, source, limit) {
    const key = artistCacheKey(source, query);
    let tracks = getCachedArtistTracks(key);

    if (!tracks) {
        const sources = artistSearchSources(source);
        const perSourceLimit = Math.max(4, Math.min(8, limit));
        const results = await Promise.allSettled(sources.map(artistSource => withTimeout(
            resolveSmartTracks(poru, query, artistSource, perSourceLimit, {
                variants: [query],
                prefetchMultiplier: 1,
                perResolveLimit: perSourceLimit,
            }),
            3500,
            [],
        )));
        tracks = dedupeTracks(results.flatMap(item => item.status === 'fulfilled' ? item.value || [] : []));
        setCachedArtistTracks(key, tracks);
    }

    return shuffleTracks(tracks);
}

async function resolveArtistCatalogTracks(poru, artistName, source, limit) {
    const queries = shuffleTracks(buildArtistCatalogQueries(artistName));
    const perQueryLimit = Math.max(4, Math.min(8, limit));
    const results = await Promise.allSettled(queries.map(query => (
        resolveCachedArtistQuery(poru, query, source, perQueryLimit).catch(() => [])
    )));
    const tracks = results.flatMap(item => item.status === 'fulfilled' ? item.value || [] : []);

    return shuffleTracks(dedupeTracks(tracks));
}

async function resolveFreshArtistCatalogTracks(poru, artistName, source, limit) {
    const artist = trimArtistCandidate(artistName);
    const sources = artistSearchSources(source);
    const perSourceLimit = Math.max(4, Math.min(8, limit));
    const query = `${artist} songs`;
    const variants = shuffleTracks([query, artist]).filter(Boolean);

    const tasks = sources.map(artistSource => withTimeout(
        resolveSmartTracks(poru, query, artistSource, perSourceLimit, {
            variants,
            prefetchMultiplier: 1,
            perResolveLimit: perSourceLimit,
        }),
        3500,
        [],
    ));

    const results = await Promise.allSettled(tasks);
    return shuffleTracks(dedupeTracks(results.flatMap(item => item.status === 'fulfilled' ? item.value || [] : [])));
}

async function resolveArtistTracks(poru, artistQuery, source, currentTrack, limit = 5, options = {}) {
    const artistName = typeof artistQuery === 'string' ? artistQuery : artistQuery?.primary;
    const fallbackName = typeof artistQuery === 'object' ? artistQuery.fallback : '';
    if (!artistName) return [];
    const filterOptions = {
        historySet: options.historySet instanceof Set ? options.historySet : null,
    };

    const tracks = await resolveFreshArtistCatalogTracks(poru, artistName, source || 'auto', Math.max(18, limit * 4));
    const primaryTracks = filterArtistTracks(tracks, currentTrack, limit, artistName, filterOptions);
    const needsFallback = fallbackName
        && normalizeSearchText(fallbackName) !== normalizeSearchText(artistName)
        && primaryTracks.length < Math.min(3, limit);

    if (!needsFallback) return primaryTracks;

    const fallbackTracks = filterArtistTracks(
        await resolveFreshArtistCatalogTracks(poru, fallbackName, source || 'auto', Math.max(18, limit * 4)),
        currentTrack,
        limit,
        fallbackName,
        filterOptions,
    );

    return dedupeTracks([...primaryTracks, ...fallbackTracks]).slice(0, limit);
}

function compactTrackStatusTitle(title) {
    const cleaned = String(title || 'Music')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/official|video|audio|lyrics?|visualizer|remaster(ed)?|HD|4K/ig, ' ')
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = cleaned.split(' ').filter(Boolean).slice(0, 5);
    return (words.join(' ') || String(title || 'Music')).slice(0, 64);
}

async function setVoiceChannelStatus(client, channelId, status) {
    if (!client?.rest || !channelId) return false;
    const body = { status: status ? String(status).slice(0, 500) : null };
    await client.rest.put(`/channels/${channelId}/voice-status`, { body });
    return true;
}

async function updatePlaybackVoiceStatus(client, tokenObj, player, track = null) {
    const settings = displaySettings(tokenObj);
    if (!settings.voiceStatus) return;

    const channelId = player?.voiceChannel || client.guilds.cache.get(player?.guildId)?.members?.me?.voice?.channelId;
    if (!channelId) return;

    const status = track
        ? `${settings.voiceStatusEmoji || '🎵'} ${compactTrackStatusTitle(track.info?.title)}`
        : null;

    ensurePlayerData(player);
    if (player.data.lastVoiceStatusChannelId === channelId && player.data.lastVoiceStatus === status) return;

    try {
        await setVoiceChannelStatus(client, channelId, status);
        player.data.lastVoiceStatusChannelId = channelId;
        player.data.lastVoiceStatus = status;
        player.data.voiceStatusWarned = false;
    } catch (err) {
        if (!player.data.voiceStatusWarned) {
            const code = err?.code || err?.status || err?.rawError?.code || 'unknown';
            console.warn(`[VoiceStatus] failed for ${channelId}: ${code} ${err?.message || ''}`.trim());
            player.data.voiceStatusWarned = true;
        }
    }
}

async function finalizePlayerUi(player, options = {}) {
    clearProgressInterval(player);
    const msg = player?.data?.nowPlayingMessage;
    if (msg?.components?.length) {
        const context = player?.data?.nowPlayingContext;
        const track = options.track || player?.currentTrack || player?.previousTrack || player?.data?.lastTrack || context?.track;
        const client = context?.client;
        if (client && track?.info) {
            const tokenObj = (store.get('tokens') || []).find(t => t.token === context.token);
            const totalTime = Math.max(0, Number(options.durationOverride ?? track.info.length ?? 0));
            const safeTimes = safeProgressTimes(player, track, { durationOverride: totalTime });
            const finalPosition = options.complete && totalTime > 0
                ? totalTime
                : safeTimes.currentTime;
            const ui = player?.data?.ui || {};
            const payload = buildNowPlayingV2Payload(client, tokenObj, player, { author: track.info.requester || context.requester }, {
                track,
                requester: track.info.requester || context.requester,
                includeControls: true,
                liked: !!ui.liked,
                artistTracks: ui.artistTracks || [],
                selectedFilter: ui.selectedFilter || player?.data?.activeFilter || 'clear',
                selectedArtistIndex: ui.selectedArtistIndex ?? null,
                compactPlayLayout: ui.compactPlayLayout !== false,
                showProgressLabels: true,
                showInfoRow: false,
                useEmbedAccent: false,
                progressWidth: PLAY_PROGRESS_WIDTH,
                positionOverride: finalPosition,
                durationOverride: totalTime,
            });
            payload.components = disableComponents(payload.components);
            await safeEditMessage(msg, payload).catch(() => {});
        } else {
            // Disable components without touching content/flags
            const isV2 = msg.flags?.has?.(MessageFlags.IsComponentsV2);
            if (isV2) {
                await msg.edit({ components: disableComponents(msg.components) }).catch(() => {});
            } else {
                await msg.edit({ components: disableComponents(msg.components) }).catch(() => {});
            }
        }
    }
    if (player?.data) {
        player.data.nowPlayingMessage = null;
        player.data.nowPlayingToken = null;
        player.data.nowPlayingTrackIdentity = null;
        player.data.nowPlayingSentAt = null;
        player.data.nowPlayingSendLock = null;
        player.data.nowPlayingContext = null;
        player.data.ui = null;
    }
}

module.exports = {
    runsys: async function runBotSystem(token, idbot) {
        if (runningBots.has(token)) {
            return;
        }
        let hostConfig = store.get('host');
        if (process.env.LAVALINK_HOST) {
            // ── #9: Warn if default Lavalink password is used ────────────────
            if (!process.env.LAVALINK_PASS) {
                console.warn('[Security] LAVALINK_PASS env var is not set — using default password. Set it in your environment secrets.');
            }
            hostConfig = [{
                name: 'main',
                host: process.env.LAVALINK_HOST,
                port: parseInt(process.env.LAVALINK_PORT || '2333'),
                secure: process.env.LAVALINK_SECURE === 'true',
                password: process.env.LAVALINK_PASS || 'youshallnotpass',
            }];
        }
        hostConfig = selectLavalinkHostsForBot(hostConfig, token, idbot);
        if (hostConfig.length === 0) {
            console.warn(`[Lavalink] no valid nodes configured for bot …${String(token).slice(-6)}`);
        }

        const TrueMusic = new Client({
            shards: "auto",
            allowedMentions: {
                parse: ["users"],
                repliedUser: false,
            },
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildVoiceStates,
            ],
            makeCache: Options.cacheWithLimits({
                ...Options.DefaultMakeCacheSettings,
                ReactionManager: 0,
                GuildMemberManager: { maxSize: 5, keepOverLimit: m => m.id === m.client.user?.id },
                MessageManager: { maxSize: 8 },
                PresenceManager: 0,
                GuildBanManager: 0,
                GuildInviteManager: 0,
                GuildScheduledEventManager: 0,
                GuildStickerManager: 0,
                StageInstanceManager: 0,
                ThreadManager: 0,
                ThreadMemberManager: 0,
                AutoModerationRuleManager: 0,
                BaseGuildEmojiManager: 0,
            }),
            sweepers: {
                ...Options.DefaultSweeperSettings,
                messages: { interval: 60, lifetime: 120 },
            },
            ws: { compress: true },
            rest: { timeout: 15000, retries: 2 },
            failIfNotExists: false,
        });
        liftDiscordClientLimits(TrueMusic);


        runningBots.set(token, TrueMusic);
        lavalinkConsole.updateBot(TrueMusic, {
            token,
            state: 'starting',
            event: 'client_create',
            note: 'Discord login pending',
        });

        // ── E: per-instance error handlers — catch unhandled rejections from this bot ──
        TrueMusic.on('error', (err) => {
            console.error(`[SubBot:${String(token).slice(-6)}] client error:`, err?.message || err);
        });
        TrueMusic.on('warn', (info) => {
            console.warn(`[SubBot:${String(token).slice(-6)}] warn:`, info);
        });
        // ─────────────────────────────────────────────────────────────────────────────

        TrueMusic.poru = new Poru(TrueMusic, hostConfig, {
            defaultPlatform: 'ytsearch',
            reconnectTries: 80,
            reconnectTimeout: 5000,
            resumeTimeout: Number(process.env.LAVALINK_RESUME_TIMEOUT_SEC || 600),
            autoResume: false,
            bypassChecks: false,
        });

        // Poru registers its own raw listener during init(). Keep this listener
        // activity-only so voice packets are not processed twice.
        let lastMusicEventAt = Date.now();
        TrueMusic.on('raw', () => {
            lastMusicEventAt = Date.now();
        });

        const voiceEnsureLocks = new Map();
        const playConnectionLocks = new Map();

        // Tracks when the user manually stopped the bot.
        // Auto-reconnect and voice-guard are suppressed for this duration.
        let stopUntil = 0;
        function markStopped(durationMs = STOP_RECONNECT_SUPPRESS_MS) {
            stopUntil = Date.now() + durationMs;
        }
        function clearStopped() { stopUntil = 0; }
        function isStopped() { return Date.now() < stopUntil; }

        async function ensureConfiguredVoice(guild, tokenObj, reason = 'guard') {
            if (!guild || !tokenObj?.channel || tokenObj.awaitingReplacement) return null;
            if (!TrueMusic.poru?.leastUsedNodes?.length) return null;

            const lockKey = `${guild.id}:${tokenObj.channel}`;
            if (voiceEnsureLocks.has(lockKey)) return voiceEnsureLocks.get(lockKey);

            const task = (async () => {
                const targetChannel = guild.channels.cache.get(tokenObj.channel)
                    || await guild.channels.fetch(tokenObj.channel).catch(() => null);
                if (!targetChannel) return null;

                const player = TrueMusic.poru.players.get(guild.id);
                const currentVoiceId = guild.members.me?.voice?.channelId;
                const backToVoice = tokenObj.backToVoice !== 'off';

                if (currentVoiceId === targetChannel.id) return player || null;
                if (currentVoiceId && !backToVoice) return player || null;

                if (player) {
                    if (tokenObj.chat && !player.data?.lastTextChannel) rememberTextChannel(player, tokenObj.chat);
                    if (!player.isConnected || player.voiceChannel !== targetChannel.id || !currentVoiceId) {
                        try {
                            player.setVoiceChannel(targetChannel.id, { deaf: true, mute: false });
                        } catch (err) {
                            if (!(err instanceof ReferenceError)) throw err;
                            await requestPlayerVoiceStateRefresh(player, `${reason}:same_channel_refresh`, false);
                        }
                        markPlayerNeedsVoiceRefresh(player, `${reason}:voice_channel_sync`);
                    }
                    return player;
                }

                const created = await TrueMusic.poru.createConnection({
                    guildId: guild.id,
                    voiceChannel: targetChannel.id,
                    textChannel: tokenObj.chat || targetChannel.id,
                    deaf: true,
                    group: tokenObj.token,
                });
                ensurePlayerData(created);
                created.data.createdAt = Date.now();
                if (tokenObj.chat) rememberTextChannel(created, tokenObj.chat);
                created.data.voiceEnsureReason = reason;
                return created;
            })().finally(() => {
                // ── #7: Release lock immediately when operation completes,
                // not after an arbitrary fixed timeout ─────────────────────
                voiceEnsureLocks.delete(lockKey);
            });

            voiceEnsureLocks.set(lockKey, task);
            return task;
        }

        async function getPlayablePlayer(guild, voiceChannelId, textChannelId, tokenObj, reason = 'play') {
            if (!guild || !voiceChannelId) return null;
            if (!TrueMusic.poru?.leastUsedNodes?.length) {
                requestPoruInit(`${reason}: no connected Lavalink nodes`, 15_000);
                return null;
            }

            const lockKey = `${guild.id}:${voiceChannelId}`;
            if (playConnectionLocks.has(lockKey)) return playConnectionLocks.get(lockKey);

            const task = (async () => {
                let player = TrueMusic.poru.players.get(guild.id);
                if (player) {
                    ensurePlayerData(player);
                    rememberTextChannel(player, textChannelId);

                    if (!player.node?.isConnected && !player.currentTrack && !player.isPlaying) {
                        // Fix #7: اختر الـ node الأخف تحميلاً بدل أول node في القائمة
                        const freshNode = lavalinkKeepAlive.getBestNode(TrueMusic.poru)
                            || TrueMusic.poru.leastUsedNodes?.[0];
                        if (freshNode) {
                            player.node = freshNode;
                            markPlayerNeedsVoiceRefresh(player, `${reason}:node_reassigned`);
                        }
                    }

                    const currentVoiceId = guild.members.me?.voice?.channelId;
                    if (!player.isConnected || player.voiceChannel !== voiceChannelId || currentVoiceId !== voiceChannelId) {
                        try {
                            player.setVoiceChannel(voiceChannelId, { deaf: true, mute: false });
                        } catch (err) {
                            if (!(err instanceof ReferenceError)) throw err;
                            await requestPlayerVoiceStateRefresh(player, `${reason}:same_channel_refresh`, false);
                        }
                        markPlayerNeedsVoiceRefresh(player, `${reason}:voice_channel_sync`);
                    }

                    return player;
                }

                const created = await TrueMusic.poru.createConnection({
                    guildId: guild.id,
                    voiceChannel: voiceChannelId,
                    textChannel: textChannelId,
                    deaf: true,
                    autoPlay: false,
                    group: tokenObj.token,
                });
                ensurePlayerData(created);
                created.data.createdAt = Date.now();
                rememberTextChannel(created, textChannelId);
                setAutoPlayState(created, false);
                return created;
            })().finally(() => {
                // ── Same fix as voiceEnsureLocks: release lock when the
                // operation finishes, not after a fixed 1500ms timeout ────────
                playConnectionLocks.delete(lockKey);
            });

            playConnectionLocks.set(lockKey, task);
            return task;
        }

        async function waitForClientPoruReady(botClient, timeoutMs = 12_000) {
            if (botClient === TrueMusic) return waitForPoruReady(timeoutMs);
            if (botClient?.poru?.leastUsedNodes?.length) return true;
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (botClient?.poru?.leastUsedNodes?.length) return true;
                await new Promise(r => setTimeout(r, 500));
            }
            return !!(botClient?.poru?.leastUsedNodes?.length);
        }

        function isSupportedVoiceTarget(channel) {
            return !!channel && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type);
        }

        async function validateBotVoiceChannel(botClient, guild, channel) {
            if (!botClient?.user?.id) return { ok: false, reason: 'bot_not_ready' };
            if (!guild) return { ok: false, reason: 'missing_guild' };
            if (!isSupportedVoiceTarget(channel) || channel.guildId !== guild.id) return { ok: false, reason: 'invalid_voice_channel' };

            const member = guild.members.cache.get(botClient.user.id)
                || await guild.members.fetch(botClient.user.id).catch(() => null);
            if (!member) return { ok: false, reason: 'bot_not_in_server' };

            const permissions = channel.permissionsFor(member);
            if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return { ok: false, reason: 'missing_view_channel_permission' };
            if (!permissions.has(PermissionFlagsBits.Connect)) return { ok: false, reason: 'missing_connect_permission' };

            const currentVoiceId = member.voice?.channelId;
            const userLimit = Number(channel.userLimit || 0);
            const isFull = userLimit > 0 && channel.members?.size >= userLimit && currentVoiceId !== channel.id;
            if (isFull && !permissions.has(PermissionFlagsBits.MoveMembers)) return { ok: false, reason: 'voice_channel_full' };

            return { ok: true, member, currentVoice: member.voice?.channel || null };
        }

        async function setConfiguredVoiceChannelFor(botClient, targetToken, targetTokenObj, guild, channel, textChannelId, commandName, { renameToChannel = false } = {}) {
            if (!guild || !channel?.id) return { ok: false, reason: 'missing_channel' };
            const validation = await validateBotVoiceChannel(botClient, guild, channel);
            if (!validation.ok) return { ok: false, ready: false, channel, tokenObj: targetTokenObj, reason: validation.reason };

            const currentTokens = store.get('tokens') || [];
            const updatedTokens = currentTokens.map((tokenBot) => {
                if (tokenBot.token === targetToken) {
                    return { ...tokenBot, channel: channel.id };
                }
                return tokenBot;
            });
            store.set('tokens', updatedTokens);

            const freshTokenObj = updatedTokens.find((tokenBot) => tokenBot.token === targetToken) || targetTokenObj;
            let connected = false;
            let ready = false;
            let error = null;

            try {
                ready = await waitForClientPoruReady(botClient, 12_000);
                const member = validation.member;
                const existingPlayer = botClient.poru?.players?.get(guild.id);
                if (existingPlayer) {
                    ensurePlayerData(existingPlayer);
                    rememberTextChannel(existingPlayer, textChannelId);
                    if (!existingPlayer.isConnected || existingPlayer.voiceChannel !== channel.id || member?.voice?.channelId !== channel.id) {
                        existingPlayer.setVoiceChannel(channel.id, { deaf: true, mute: false });
                        markPlayerNeedsVoiceRefresh(existingPlayer, `${commandName}:manual_voice_select`);
                    }
                    connected = true;
                } else if (botClient.poru && ready) {
                    const created = await botClient.poru.createConnection({
                        guildId: guild.id,
                        voiceChannel: channel.id,
                        textChannel: textChannelId,
                        deaf: true,
                        group: targetToken,
                    });
                    ensurePlayerData(created);
                    created.data.createdAt = Date.now();
                    rememberTextChannel(created, textChannelId);
                    connected = true;
                }
            } catch (err) {
                error = err;
            }

            if (renameToChannel) {
                const cooldownTime = 5000;
                const lastChangeTime = botClient.user.lastChangeTime || 0;
                if (Date.now() - lastChangeTime >= cooldownTime) {
                    botClient.user.setUsername(channel.name).then(() => {
                        botClient.user.lastChangeTime = Date.now();
                    }).catch(() => {});
                }
            }

            return {
                ok: connected,
                ready,
                channel,
                tokenObj: freshTokenObj,
                reason: error?.message || (!ready ? 'no_lavalink_nodes' : null),
            };
        }

        async function setConfiguredVoiceChannel(guild, channel, textChannelId, commandName, currentTokenObj, { renameToChannel = false } = {}) {
            return setConfiguredVoiceChannelFor(TrueMusic, token, currentTokenObj, guild, channel, textChannelId, commandName, { renameToChannel });
        }

        function buildVoiceSelectEmbed(commandName, actor, selectedChannel = null, state = 'waiting', reason = null) {
            const isSetup = commandName === 'setup';
            const currentVoice = TrueMusic.guilds.cache
                .map(guild => guild.members.cache.get(TrueMusic.user.id)?.voice?.channel)
                .find(Boolean);
            const titles = {
                waiting: isSetup ? 'Setup Voice Room | اختيار روم الإعداد' : 'Join Voice Room | اختيار روم الدخول',
                working: 'Connecting | جاري الاتصال',
                success: isSetup ? 'Setup Complete | تم الإعداد' : 'Joined Voice | تم الدخول',
                failed: 'Voice Setup Failed | فشل ضبط الروم',
                expired: 'Voice Selection Expired | انتهى اختيار الروم',
                skipped: 'Voice Selection Skipped | تم تخطي البوت',
                cancelled: 'Voice Selection Cancelled | تم إلغاء الاختيار',
            };
            const statusLine = {
                waiting: '*اختر روم صوت من المنيو بالأسفل لأنك لست داخل روم صوتي.*',
                working: '*جاري حفظ الروم ومحاولة إدخال البوت...*',
                success: '*تم حفظ الروم وتحديث حالة البوت بنجاح.*',
                failed: '*تعذر إدخال البوت الآن، تم حفظ الاختيار إذا أمكن.*',
                expired: '*انتهى وقت المنيو بدون اختيار روم.*',
                skipped: '*تم تخطي هذا البوت بدون تغيير رومه الحالي.*',
                cancelled: '*تم إلغاء العملية بدون تغيير روم البوت.*',
            }[state] || '*بانتظار الاختيار.*';

            return new EmbedBuilder()
                .setColor(getEmbedColor(TrueMusic))
                .setAuthor({
                    name: TrueMusic.user?.username || 'Music Bot',
                    iconURL: TrueMusic.user?.displayAvatarURL?.({ dynamic: true }),
                })
                .setTitle(titles[state] || titles.waiting)
                .setDescription([
                    statusLine,
                    '',
                    `**Bot :** <@${TrueMusic.user.id}>`,
                    `**Request By :** <@${actor.id}>`,
                    `**Command :** \`${commandName}\``,
                    `**Current Voice :** ${currentVoice ? `<#${currentVoice.id}>` : '`Not Connected`'}`,
                    `**Voice :** ${selectedChannel ? `<#${selectedChannel.id}>` : '`Not Selected`'}`,
                    reason ? `**Note :** \`${String(reason).slice(0, 120)}\`` : null,
                ].filter(Boolean).join('\n'))
                .setFooter({ text: 'Searchable voice menu • يدعم البحث داخل قائمة الرومات' });
        }

        async function promptVoiceChannelSelection(message, commandName, currentTokenObj, { renameToChannel = false } = {}) {
            const customId = `voice_select:${TrueMusic.user.id}:${message.id}:${commandName}`;
            const selectRow = new ActionRowBuilder().addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId(customId)
                    .setPlaceholder(`Select voice room for ${TrueMusic.user?.username || 'bot'} | اختر روم صوت`)
                    .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
                    .setMinValues(1)
                    .setMaxValues(1),
            );
            const controlsRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`voice_select_skip:${TrueMusic.user.id}:${message.id}:${commandName}`)
                    .setLabel('Skip Bot')
                    .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.skip, TrueMusic, '⏭️'))
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`voice_select_cancel:${TrueMusic.user.id}:${message.id}:${commandName}`)
                    .setLabel('Cancel')
                    .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.stop, TrueMusic, '✖️'))
                    .setStyle(ButtonStyle.Danger),
            );

            const panel = await message.reply({
                embeds: [buildVoiceSelectEmbed(commandName, message.author)],
                components: [selectRow, controlsRow],
                allowedMentions: { users: [message.author.id, TrueMusic.user.id], repliedUser: false },
            }).catch(() => null);
            if (!panel) return;

            const collector = panel.createMessageComponentCollector({
                filter: i => i.user.id === message.author.id
                    && [customId, `voice_select_skip:${TrueMusic.user.id}:${message.id}:${commandName}`, `voice_select_cancel:${TrueMusic.user.id}:${message.id}:${commandName}`].includes(i.customId),
                time: 90_000,
                max: 1,
            });

            collector.on('collect', async (interaction) => {
                if (interaction.customId.startsWith('voice_select_skip:')) {
                    return interaction.update({
                        embeds: [buildVoiceSelectEmbed(commandName, message.author, null, 'skipped')],
                        components: [],
                    }).catch(() => {});
                }
                if (interaction.customId.startsWith('voice_select_cancel:')) {
                    return interaction.update({
                        embeds: [buildVoiceSelectEmbed(commandName, message.author, null, 'cancelled', 'cancelled by user')],
                        components: [],
                    }).catch(() => {});
                }
                const channelId = interaction.values?.[0];
                const channel = message.guild.channels.cache.get(channelId)
                    || await message.guild.channels.fetch(channelId).catch(() => null);
                if (!isSupportedVoiceTarget(channel)) {
                    return interaction.update({
                        embeds: [buildVoiceSelectEmbed(commandName, message.author, null, 'failed', 'invalid voice channel')],
                        components: [],
                    }).catch(() => {});
                }
                const validation = await validateBotVoiceChannel(TrueMusic, message.guild, channel);
                if (!validation.ok) {
                    return interaction.update({
                        embeds: [buildVoiceSelectEmbed(commandName, message.author, channel, 'failed', validation.reason)],
                        components: [],
                    }).catch(() => {});
                }

                await interaction.update({
                    embeds: [buildVoiceSelectEmbed(commandName, message.author, channel, 'working')],
                    components: [],
                }).catch(() => {});

                const result = await setConfiguredVoiceChannel(message.guild, channel, message.channel.id, commandName, currentTokenObj, { renameToChannel });
                await panel.edit({
                    embeds: [buildVoiceSelectEmbed(commandName, message.author, channel, result.ok ? 'success' : 'failed', result.reason)],
                    components: [],
                    allowedMentions: { users: [message.author.id, TrueMusic.user.id], repliedUser: false },
                }).catch(() => {});
            });

            collector.on('end', async (collected) => {
                if (collected.size) return;
                await panel.edit({
                    embeds: [buildVoiceSelectEmbed(commandName, message.author, null, 'expired')],
                    components: [],
                    allowedMentions: { users: [message.author.id, TrueMusic.user.id], repliedUser: false },
                }).catch(() => {});
            });
        }

        function isSameVoiceAsThisBot(message) {
            const memberVoiceId = message.member?.voice?.channelId;
            const botVoiceId = message.guild?.members?.cache?.get(TrueMusic.user.id)?.voice?.channelId
                || message.guild?.members?.me?.voice?.channelId;
            return !!(memberVoiceId && botVoiceId && memberVoiceId === botVoiceId);
        }

        function markVoiceScopedUtilityHandled(message, name) {
            if (!global._voiceScopedUtilityMsgIds) global._voiceScopedUtilityMsgIds = new Map();
            const key = `${message.id}:${String(name || '').toLowerCase()}`;
            if (global._voiceScopedUtilityMsgIds.has(key)) return false;
            global._voiceScopedUtilityMsgIds.set(key, TrueMusic.user.id);
            setTimeout(() => global._voiceScopedUtilityMsgIds?.delete(key), 30_000).unref?.();
            return true;
        }

        function claimVoiceScopedUtility(message, name) {
            if (!isSameVoiceAsThisBot(message)) return false;
            return markVoiceScopedUtilityHandled(message, name);
        }

        async function sendFullHelpPanel(message, tokenObj) {
            const botOwnerId = tokenObj.client;
            const embedColor = getEmbedColor(TrueMusic);
            const avatarUrl = message.author.displayAvatarURL({ dynamic: true, size: 256 });

            const EN_DESC = [
                '***Music Commands :***',
                '',
                '``play`` : Play a song or add it to the queue',
                '``search`` : Search across the enabled music platforms',
                '``autoplay`` : Toggle auto music player',
                '``stop`` : Stop the music and clear playback',
                '``skip`` : Skip the current song',
                '``volume`` : Set the music volume',
                '``nowplaying`` : Show the song playing now',
                '``info`` : Show bot and subscription details',
                '``queue`` : Show the server playlist',
                '``loop`` : Loop the current song',
                '``pause`` : Pause the music',
                '``seek`` : Seek to a specific time',
                '``forward`` : Move forward in the current song',
                '``remove`` : Remove a song from the queue',
                '``mylikes`` : Show your liked songs',
                '',
                '***Owner Commands :***',
                '',
                '``join`` : Set bot voice channel & enable 24/7',
                '``join all`` : Set every subscription bot voice channel',
                '``setup`` : Set bot voice channel, enable 24/7, and rename bot',
                '``setup all`` : Setup every subscription bot',
                '``leave`` : Leave voice channel & disable 24/7',
                '``setchat`` : Set commands chat',
                '``unchat`` : Clear commands chat',
                '``setprefix`` : Change the bot prefix',
                '``unsetprefix`` : Remove the bot prefix',
                '``settings`` : Display subscription bot settings',
                '``setname`` : Change the bot name',
                '``setavatar`` : Change the bot avatar',
                '``streaming`` : Change the bot status',
                '``restart`` : Restart the bot',
                '``ping`` : Show bot response speed',
            ].join('\n');

            const AR_DESC = [
                '***أوامر الموسيقى :***',
                '',
                '``play`` : شغّل أغنية أو أضفها للقائمة',
                '``search`` : ابحث في منصات الموسيقى المفعّلة',
                '``autoplay`` : تشغيل/إيقاف التشغيل التلقائي',
                '``stop`` : أوقف الموسيقى وامسح التشغيل',
                '``skip`` : تخطّ الأغنية الحالية',
                '``volume`` : اضبط مستوى الصوت',
                '``nowplaying`` : اعرض الأغنية التي تعمل الآن',
                '``info`` : اعرض معلومات البوت والاشتراك',
                '``queue`` : اعرض قائمة الانتظار',
                '``loop`` : كرّر الأغنية الحالية',
                '``pause`` : وقّف الموسيقى مؤقتاً',
                '``seek`` : اذهب لوقت محدد في الأغنية',
                '``forward`` : تقدّم للأمام في الأغنية الحالية',
                '``remove`` : احذف أغنية من القائمة',
                '``mylikes`` : اعرض أغانيك المفضّلة',
                '',
                '***أوامر المالك :***',
                '',
                '``join`` : حدّد قناة الصوت وفعّل 24/7',
                '``join all`` : حدّد روم كل بوتات الاشتراك',
                '``setup`` : حدّد الروم وفعّل 24/7 وغيّر اسم البوت',
                '``setup all`` : إعداد جماعي لكل بوتات الاشتراك',
                '``leave`` : اخرج من القناة وأوقف 24/7',
                '``setchat`` : حدّد قناة الأوامر',
                '``unchat`` : امسح قناة الأوامر',
                '``setprefix`` : غيّر البادئة',
                '``unsetprefix`` : احذف البادئة',
                '``settings`` : اعرض إعدادات البوت',
                '``setname`` : غيّر اسم البوت',
                '``setavatar`` : غيّر صورة البوت',
                '``streaming`` : غيّر حالة البوت',
                '``restart`` : أعد تشغيل البوت',
                '``ping`` : اعرض سرعة استجابة البوت',
            ].join('\n');

            const buildHelpRow = (isArabic) => new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Support Server')
                    .setStyle(ButtonStyle.Link)
                    .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.settings, TrueMusic, '⚙️'))
                    .setURL('https://discord.gg/ens'),
                new ButtonBuilder()
                    .setCustomId('help_translate')
                    .setLabel(isArabic ? 'English' : 'عربي')
                    .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.smartSearch, TrueMusic, '🌐'))
                    .setStyle(ButtonStyle.Secondary),
            );

            const buildHelpEmbed = (isArabic) => new EmbedBuilder()
                .setColor(embedColor)
                .setThumbnail(avatarUrl)
                .setDescription(isArabic ? AR_DESC : EN_DESC);

            const additionalEmbed = new EmbedBuilder()
                .setColor(embedColor)
                .setDescription(`**Bot :** <@${TrueMusic.user.id}>\n**Owner :** <@${botOwnerId}>\n**Owner ID :** \`${botOwnerId}\``);

            return message.author.send({
                embeds: [buildHelpEmbed(false), additionalEmbed],
                components: [buildHelpRow(false)],
                allowedMentions: { users: [TrueMusic.user.id, botOwnerId].filter(Boolean) },
            }).then(async (dmMsg) => {
                const helpdma = new EmbedBuilder()
                    .setColor(embedColor)
                    .setDescription('> **تم إرسال الاوامر في الخاص.**')
                    .setFooter({ text: 'Ens 𝐒𝐭𝐨𝐫𝐞' });
                message.reply({ embeds: [helpdma], allowedMentions: { repliedUser: false } }).catch(() => 0);

                let isArabic = false;
                const collector = dmMsg.createMessageComponentCollector({
                    filter: i => i.customId === 'help_translate' && i.user.id === message.author.id,
                    time: 10 * 60 * 1000,
                });
                collector.on('collect', async i => {
                    isArabic = !isArabic;
                    await i.update({
                        embeds: [buildHelpEmbed(isArabic), additionalEmbed],
                        components: [buildHelpRow(isArabic)],
                    }).catch(() => {});
                });
            }).catch(() => {
                message.react('🔒').catch(() => 0);
            });
        }

        function subscriptionVoiceTargets(message, allTokens, baseTokenObj) {
            const sameCode = String(baseTokenObj?.code || '');
            const sameClient = String(baseTokenObj?.client || '');
            const sameServer = String(baseTokenObj?.Server || '');
            return allTokens
                .filter(t => t?.token && (
                    (sameCode && t.code === sameCode)
                    || (!sameCode && sameClient && t.client === sameClient && (!sameServer || t.Server === sameServer))
                ))
                .map(t => ({ token: t.token, tokenObj: t, bot: runningBots.get(t.token) }))
                .filter(t => t.bot?.user && t.bot.guilds.cache.has(message.guild.id));
        }

        async function prepareVoiceTargets(message, targets) {
            const guild = message.guild;
            const prepared = await Promise.all((targets || []).map(async (target, originalIndex) => {
                const bot = target?.bot;
                if (!bot?.user?.id || !target?.token) return null;
                if (!bot.guilds.cache.has(guild.id)) return null;
                const member = guild.members.cache.get(bot.user.id)
                    || await guild.members.fetch(bot.user.id).catch(() => null);
                if (!member) return null;
                return {
                    ...target,
                    originalIndex,
                    member,
                    currentVoice: member.voice?.channel || null,
                    currentVoiceId: member.voice?.channelId || null,
                    ready: !!bot.readyAt,
                    poruReady: !!bot.poru?.leastUsedNodes?.length,
                };
            }));

            return prepared
                .filter(Boolean)
                .sort((a, b) => {
                    const aInVoice = a.currentVoiceId ? 1 : 0;
                    const bInVoice = b.currentVoiceId ? 1 : 0;
                    if (aInVoice !== bInVoice) return aInVoice - bInVoice;
                    return (a.originalIndex || 0) - (b.originalIndex || 0);
                });
        }

        function buildAllVoiceEmbed(commandName, actor, targets, state, lines = [], activeIndex = -1) {
            const status = {
                choose: 'اختر هل تريد إدخال كل البوتات في رومك الحالي أو فتح منيو لكل بوت.',
                selecting: 'اختر روم الصوت للبوت المحدد. سيتم الانتقال للبوت التالي تلقائياً.',
                working: 'جاري تطبيق الإعداد على البوتات المحددة...',
                success: 'اكتمل ضبط رومات البوتات.',
                cancelled: 'تم إلغاء العملية وإغلاق القائمة.',
                expired: 'انتهى وقت القائمة وتم إغلاقها.',
            }[state] || 'بانتظار الاختيار.';

            const activeTarget = activeIndex >= 0 ? targets[activeIndex] : null;
            const summary = targets.reduce((acc, target) => {
                if (target.skipped) acc.skipped++;
                else if (target.result?.ok) acc.done++;
                else if (target.currentVoiceId) acc.inVoice++;
                else acc.outVoice++;
                return acc;
            }, { outVoice: 0, inVoice: 0, done: 0, skipped: 0 });
            const compactTargets = targets
                .map((target, index) => ({ target, index }))
                .filter(({ index }) => index === activeIndex || targets.length <= 8)
                .slice(0, 8);
            const targetLines = compactTargets.map(({ target, index }) => {
                const marker = index === activeIndex ? '➜' : `${index + 1}.`;
                const currentVoice = target.currentVoice;
                const currentText = currentVoice ? ` | Now: <#${currentVoice.id}>` : ' | Now: `Not Connected`';
                const selectedText = target.skipped ? ' | `Skipped`' : (target.channel ? ` → <#${target.channel.id}>` : '');
                return `${marker} <@${target.bot.user.id}>${currentText}${selectedText}`;
            });
            if (targets.length > compactTargets.length) {
                targetLines.push(`… +${targets.length - compactTargets.length} bots hidden to keep embed safe`);
            }

            return new EmbedBuilder()
                .setColor(getEmbedColor(TrueMusic))
                .setTitle(`${commandName === 'setup' ? 'Setup All' : 'Join All'} | كل بوتات الاشتراك`)
                .setDescription([
                    `**Status :** ${status}`,
                    `**Request By :** <@${actor.id}>`,
                    `**Bots :** \`${targets.length}\``,
                    `**Summary :** خارج الفويس \`${summary.outVoice}\` • داخل الفويس \`${summary.inVoice}\` • تم \`${summary.done}\` • تخطي \`${summary.skipped}\``,
                    activeTarget ? [
                        '',
                        '**Current Turn :**',
                        `**Bot :** <@${activeTarget.bot.user.id}>`,
                        `**Current Voice :** ${activeTarget.currentVoice ? `<#${activeTarget.currentVoice.id}>` : '`Not Connected`'}`,
                        `**Poru :** \`${activeTarget.poruReady ? 'Ready' : 'Waiting'}\``,
                    ].join('\n') : null,
                    '',
                    targetLines.join('\n') || '`No bots found`',
                    lines.length ? `\n**Log :**\n${lines.slice(-8).join('\n')}` : null,
                ].filter(Boolean).join('\n'));
        }

        function allVoiceChoiceRows(messageId, commandName) {
            return [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`voice_all_same:${messageId}:${commandName}`)
                        .setLabel('كلهم في رومي')
                        .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.stg.rooms, TrueMusic, '🔊'))
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`voice_all_menu:${messageId}:${commandName}`)
                        .setLabel('فتح منيو لكل بوت')
                        .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.smartSearch, TrueMusic, '🔎'))
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`voice_all_cancel:${messageId}:${commandName}`)
                        .setLabel('Cancel')
                        .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.stop, TrueMusic, '✖️'))
                        .setStyle(ButtonStyle.Danger),
                ),
            ];
        }

        function allVoiceSelectRows(messageId, commandName, botId) {
            return [
                new ActionRowBuilder().addComponents(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(`voice_all_select:${messageId}:${commandName}:${botId}`)
                        .setPlaceholder('اختر روم الصوت لهذا البوت')
                        .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
                        .setMinValues(1)
                        .setMaxValues(1),
                ),
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`voice_all_skip:${messageId}:${commandName}:${botId}`)
                        .setLabel('Skip Bot')
                        .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.skip, TrueMusic, '⏭️'))
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`voice_all_cancel:${messageId}:${commandName}`)
                        .setLabel('Cancel')
                        .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.stop, TrueMusic, '✖️'))
                        .setStyle(ButtonStyle.Danger),
                ),
            ];
        }

        async function applyAllVoiceTargets(message, commandName, targets, channelForTarget, panel, logLines = []) {
            await panel.edit({
                embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'working', logLines)],
                components: [],
                allowedMentions: { users: [message.author.id], repliedUser: false },
            }).catch(() => {});

            for (const target of targets) {
                if (target.skipped) {
                    logLines.push(`⏭️ ${target.bot.user.username} skipped`);
                    continue;
                }
                const targetChannel = typeof channelForTarget === 'function' ? channelForTarget(target) : channelForTarget;
                if (!targetChannel) {
                    logLines.push(`⏭️ ${target.bot.user.username} skipped`);
                    continue;
                }
                const result = await setConfiguredVoiceChannelFor(
                    target.bot,
                    target.token,
                    target.tokenObj,
                    message.guild,
                    targetChannel,
                    message.channel.id,
                    commandName,
                    { renameToChannel: commandName === 'setup' },
                );
                target.channel = targetChannel;
                target.result = result;
                if (result.ok) {
                    target.currentVoice = targetChannel;
                    target.currentVoiceId = targetChannel.id;
                }
                logLines.push(`${result.ok ? '✅' : '❌'} ${target.bot.user.username} → ${targetChannel?.name || targetChannel?.id || 'Unknown'}${result.ok ? '' : ` (${result.reason || 'failed'})`}`);
                await panel.edit({
                    embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'working', logLines)],
                    components: [],
                    allowedMentions: { users: [message.author.id], repliedUser: false },
                }).catch(() => {});
            }

            await panel.edit({
                embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'success', logLines)],
                components: [],
                allowedMentions: { users: [message.author.id], repliedUser: false },
            }).catch(() => {});
        }

        async function promptAllVoiceSelection(message, commandName, targets) {
            const panel = await message.reply({
                embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'selecting', [], 0)],
                components: allVoiceSelectRows(message.id, commandName, targets[0].bot.user.id),
                allowedMentions: { users: [message.author.id], repliedUser: false },
            }).catch(() => null);
            if (!panel) return;

            let index = 0;
            const logLines = [];
            const collector = panel.createMessageComponentCollector({
                filter: i => i.user.id === message.author.id && i.customId.includes(`:${message.id}:${commandName}`),
                time: 180_000,
            });

            collector.on('collect', async (interaction) => {
                if (interaction.customId.startsWith('voice_all_cancel:')) {
                    collector.stop('cancelled');
                    return interaction.update({
                        embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'cancelled', logLines, index)],
                        components: [],
                    }).catch(() => {});
                }

                const target = targets[index];
                if (interaction.customId.startsWith('voice_all_skip:')) {
                    if (target) target.skipped = true;
                    logLines.push(`⏭️ ${target?.bot?.user?.username || `Bot ${index + 1}`} skipped`);
                    index++;
                    if (index >= targets.length) {
                        await interaction.update({
                            embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'working', logLines)],
                            components: [],
                        }).catch(() => {});
                        collector.stop('selected');
                        return applyAllVoiceTargets(message, commandName, targets, t => t.channel, panel, logLines);
                    }
                    return interaction.update({
                        embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'selecting', logLines, index)],
                        components: allVoiceSelectRows(message.id, commandName, targets[index].bot.user.id),
                    }).catch(() => {});
                }
                const channelId = interaction.values?.[0];
                const channel = message.guild.channels.cache.get(channelId)
                    || await message.guild.channels.fetch(channelId).catch(() => null);
                if (!target || !isSupportedVoiceTarget(channel)) {
                    return interaction.reply({ content: 'روم الصوت غير صحيح.', ephemeral: true }).catch(() => {});
                }
                const validation = await validateBotVoiceChannel(target.bot, message.guild, channel);
                if (!validation.ok) {
                    return interaction.reply({ content: `تعذر اختيار الروم لهذا البوت: ${validation.reason}`, ephemeral: true }).catch(() => {});
                }

                target.channel = channel;
                index++;
                if (index >= targets.length) {
                    await interaction.update({
                        embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'working', logLines)],
                        components: [],
                    }).catch(() => {});
                    collector.stop('selected');
                    return applyAllVoiceTargets(message, commandName, targets, t => t.channel, panel, logLines);
                }

                await interaction.update({
                    embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'selecting', logLines, index)],
                    components: allVoiceSelectRows(message.id, commandName, targets[index].bot.user.id),
                }).catch(() => {});
            });

            collector.on('end', async (_collected, reason) => {
                if (['selected', 'cancelled'].includes(reason)) return;
                await panel.edit({
                    embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'expired', logLines, index)],
                    components: [],
                    allowedMentions: { users: [message.author.id], repliedUser: false },
                }).catch(() => {});
            });
        }

        async function handleAllVoiceCommand(message, commandName, allTokens, currentTokenObj, targetOverride = null, lockSuffix = 'all') {
            if (!global._voiceAllHandledMsgIds) global._voiceAllHandledMsgIds = new Map();
            const lockKey = `${message.id}:${currentTokenObj?.code || currentTokenObj?.client || token}:${lockSuffix}`;
            if (global._voiceAllHandledMsgIds.has(lockKey)) return true;
            global._voiceAllHandledMsgIds.set(lockKey, Date.now());
            setTimeout(() => global._voiceAllHandledMsgIds?.delete(lockKey), 10 * 60 * 1000).unref?.();

            const rawTargets = Array.isArray(targetOverride) ? targetOverride : subscriptionVoiceTargets(message, allTokens, currentTokenObj);
            const targets = await prepareVoiceTargets(message, rawTargets);
            if (!targets.length) {
                message.reply({ embeds: [buildAllVoiceEmbed(commandName, message.author, [], 'expired', ['❌ لا توجد بوتات اشتراك شغالة.'])] }).catch(() => {});
                return true;
            }

            const memberChannel = message.member?.voice?.channel;
            if (!memberChannel) {
                await promptAllVoiceSelection(message, commandName, targets);
                return true;
            }

            const panel = await message.reply({
                embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'choose')],
                components: allVoiceChoiceRows(message.id, commandName),
                allowedMentions: { users: [message.author.id], repliedUser: false },
            }).catch(() => null);
            if (!panel) return true;

            const collector = panel.createMessageComponentCollector({
                filter: i => i.user.id === message.author.id && i.customId.includes(`:${message.id}:${commandName}`),
                time: 90_000,
                max: 1,
            });

            collector.on('collect', async (interaction) => {
                if (interaction.customId.startsWith('voice_all_cancel:')) {
                    return interaction.update({
                        embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'cancelled')],
                        components: [],
                    }).catch(() => {});
                }

                if (interaction.customId.startsWith('voice_all_same:')) {
                    await interaction.update({
                        embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'working', [`⏳ ${memberChannel.name}`])],
                        components: [],
                    }).catch(() => {});
                    return applyAllVoiceTargets(message, commandName, targets, memberChannel, panel, [`⏳ تطبيق نفس الروم: ${memberChannel.name}`]);
                }

                if (interaction.customId.startsWith('voice_all_menu:')) {
                    await interaction.update({
                        embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'selecting', ['⏳ فتح قائمة اختيار الرومات...'], 0)],
                        components: [],
                    }).catch(() => {});
                    await promptAllVoiceSelection(message, commandName, targets);
                }
            });

            collector.on('end', async (collected) => {
                if (collected.size) return;
                await panel.edit({
                    embeds: [buildAllVoiceEmbed(commandName, message.author, targets, 'expired')],
                    components: [],
                    allowedMentions: { users: [message.author.id], repliedUser: false },
                }).catch(() => {});
            });

            return true;
        }

        async function restartCurrentTrack(player, reason = 'recover') {
            if (!player?.currentTrack?.track || !player?.node?.rest) return false;
            ensurePlayerData(player);
            if (player.data.needsVoiceRefresh || !hasPlayerVoiceSession(player)) {
                await refreshPlayerVoiceSession(player, `restart:${reason}`);
            }
            // Mark recovery so trackEnd(replaced) is suppressed and doesn't break UI
            player.data._recovering = true;
            player.data._recoveryTrackId = trackIdentity(player.currentTrack);
            player.data._recoveryAt = Date.now();
            await updateLavalinkPlayer(player, {
                track: { encoded: player.currentTrack.track },
                position: Math.max(0, Number(player.position || 0)),
                paused: false,
            }, 'recovery restart');
            player.isPlaying = true;
            player.isPaused = false;
            player.data.lastProgressAt = Date.now();
            player.data.lastRecoveryReason = reason;
            return true;
        }

        async function recoverPlayerPlayback(player, reason = 'watchdog') {
            if (!player || player.isPaused) return;
            ensurePlayerData(player);

            const tokenObj = (store.get('tokens') || []).find(t => t.token === token);
            const guild = TrueMusic.guilds.cache.get(player.guildId);
            if (guild && tokenObj?.channel) {
                await ensureConfiguredVoice(guild, tokenObj, reason).catch(() => null);
            }

            if (!player.currentTrack && player.queue?.length) {
                await safePlay(player).catch(() => {});
                return;
            }

            if (!player.currentTrack) return;

            player.data.recoveryAttempts = (player.data.recoveryAttempts || 0) + 1;
            if (player.data.recoveryAttempts <= 2) {
                await restartCurrentTrack(player, reason).catch(() => {});
                return;
            }

            if (player.queue?.length) {
                player.data.recoveryAttempts = 0;
                await finalizePlayerUi(player);
                await player.skip().catch(() => {});
                return;
            }

            await restartCurrentTrack(player, reason).catch(() => {});
        }

        function scheduleNodeRecovery(node, reason = 'node_reconnect') {
            // Wait 8s to allow the node session to fully establish before
            // attempting to restart player tracks.
            setTimeout(() => {
                if (!node.isConnected) return; // node went offline again — skip
                TrueMusic.poru.players.forEach(player => {
                    if (player.node !== node) return;
                    if (player.isPaused) return;

                    if (!player.currentTrack) {
                        // Idle player: its Lavalink session no longer exists after
                        // a reconnect. Keep the Discord voice state in place and
                        // refresh Lavalink voice data on the next play command.
                        if (process.env.DEBUG_RECOVERY)
                            console.log(`[IdleCleanup] marking stale idle player after ${reason} for guild ${player.guildId}`);
                        markPlayerNeedsVoiceRefresh(player, `node_recovery:${reason}`);
                        return;
                    }

                    recoverPlayerPlayback(player, reason).catch(() => {});
                });
            }, 8000);
        }

        // ── Optimization: watchdog merged into main interval below ──────────────
        // Was a separate 20s timer per bot — now runs inside the 15s guard loop,
        // saving one timer object per bot (100 bots = 100 fewer timers).
        const playbackWatchdog = { clear: () => {} }; // stub so clearInterval(playbackWatchdog) stays safe
        let lastPoruInitAt = 0;
        function requestPoruInit(reason, cooldownMs = 30_000) {
            const now = Date.now();
            if (now - lastPoruInitAt < cooldownMs) return false;
            lastPoruInitAt = now;
            lavalinkConsole.updateBot(TrueMusic, {
                token,
                state: 'reinit',
                event: 'poru_reinit',
                note: reason,
            });
            try {
                const poru = TrueMusic.poru;
                if (!poru) return false;

                if (!poru.userId && TrueMusic.user?.id) poru.userId = TrueMusic.user.id;

                const nodes = [...(poru.nodes?.values?.() || [])];
                if (nodes.length === 0 && Array.isArray(poru._nodes) && poru._nodes.length > 0) {
                    restorePoruNodes(poru, TrueMusic, reason);
                    return true;
                }

                nodes.forEach(node => {
                    try {
                        node.attempt = 0;
                        const wsState = node.ws?.readyState;
                        if (!node.isConnected && wsState !== 0 && wsState !== 1) {
                            clearTimeout(node.reconnectAttempt);
                            node.reconnectAttempt = null;
                            node.connect?.().catch(() => {});
                        }
                    } catch {}
                });
            } catch {}
            return true;
        }

        // ── Helper: wait up to timeoutMs for at least one Poru node to be ready ──
        async function waitForPoruReady(timeoutMs = 12_000) {
            if (TrueMusic.poru?.leastUsedNodes?.length) return true;
            // Trigger re-init immediately (bypass cooldown)
            lastPoruInitAt = 0;
            requestPoruInit('waitForPoruReady: no nodes yet', 0);
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (TrueMusic.poru?.leastUsedNodes?.length) return true;
                await new Promise(r => setTimeout(r, 500));
            }
            return !!(TrueMusic.poru?.leastUsedNodes?.length);
        }

        TrueMusic.poru.on('nodeConnect', (node) => {
            // Configure Lavalink v4 resume and WS keep-alive without reusing stale sessions.
            lavalinkKeepAlive.onNodeConnect(node, TrueMusic).catch(() => {});

            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const wasOffline = prev.status === 'offline';
            const data = {
                status: 'online',
                connectedAt: Date.now(),
                reconnects: prev.reconnects ?? 0,
            };
            statusStore.setNode(name, data);
            lavalinkConsole.updateNode(node, 'online', {
                event: 'node_connect',
                reconnects: data.reconnects,
                note: 'Connected to Lavalink',
            });

            // Send "recovered" alert if it was previously offline
            if (wasOffline) {
                sendLavalinkAlert(TrueMusic, 'recovered', node).catch(() => {});
            }
            // Start CPU/RAM load monitor for this node
            startNodeLoadMonitor(node, TrueMusic);

            let newData = tempData.get("bots");
            if (!newData.includes(TrueMusic)) newData.push(TrueMusic);
            tempData.set("bots", newData);
            scheduleNodeRecovery(node, 'node_connect');
        });

        TrueMusic.poru.on('nodeReconnect', (node) => {
            // Reapply resume and ping after every reconnect.
            lavalinkKeepAlive.onNodeConnect(node, TrueMusic).catch(() => {});
            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const data = {
                status: 'reconnecting',
                connectedAt: Date.now(),
                reconnects: (prev.reconnects ?? 0) + 1,
            };
            statusStore.setNode(name, data);
            lavalinkConsole.updateNode(node, 'reconnecting', {
                event: 'node_reconnect',
                reconnects: data.reconnects,
                note: 'Reconnect attempt started',
            });
            scheduleNodeRecovery(node, 'node_reconnect');
        });

        TrueMusic.poru.on('nodeDisconnect', (node) => {
            // أوقف WS ping — سيُستأنف عند nodeConnect/nodeReconnect
            lavalinkKeepAlive.onNodeDisconnect(node);
            // Stop load monitor — node is gone
            stopNodeLoadMonitor(node?.options?.name || node?.options?.host);
            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const data = { status: 'offline', reconnects: prev.reconnects ?? 0 };
            statusStore.setNode(name, data);
            lavalinkConsole.updateNode(node, 'offline', {
                event: 'node_disconnect',
                reconnects: data.reconnects,
                note: 'Waiting for reconnect',
            });

            // Send disconnect alert to log channel
            const affectedPlayers = [...TrueMusic.poru.players.values()].filter(p => p.node === node).length;
            sendLavalinkAlert(TrueMusic, 'disconnect', node,
                affectedPlayers > 0 ? `البوتات المتأثرة: **${affectedPlayers}**` : ''
            ).catch(() => {});

            // ── Ghost-player prevention ───────────────────────────────────────────
            // When a node goes offline, Poru players on it keep isPlaying=true
            // but Lavalink has no session — they become "ghost players": visible
            // in Discord voice but silent and unresponsive to REST calls.
            //
            // Fix: immediately freeze them here. scheduleNodeRecovery() (triggered
            // by nodeConnect/nodeReconnect) will restart them once the node is back.
            let ghostCount = 0;
            TrueMusic.poru.players.forEach(player => {
                if (player.node !== node) return;
                ensurePlayerData(player);
                if (player.isPlaying || player.isPaused) {
                    // Preserve currentTrack so scheduleNodeRecovery can restart it.
                    // Only clear isPlaying — intentionally keep isPaused as-is so
                    // scheduleNodeRecovery skips paused players (its `if (player.isPaused) return`
                    // guard) and the user's pause state survives the node reconnect.
                    player.data._wasPlayingBeforeDisconnect = player.isPlaying;
                    player.isPlaying = false;
                    ghostCount++;
                }
                // Mark for voice-session re-establishment when the node comes back.
                markPlayerNeedsVoiceRefresh(player, 'node_disconnect');
            });
            if (ghostCount > 0) {
                lavalinkConsole.updateNode(node, 'offline', {
                    event: 'ghost_players_frozen',
                    reconnects: data.reconnects,
                    note: `Frozen ghost players: ${ghostCount}`,
                    players: TrueMusic.poru.players.size,
                });
            }
            // ─────────────────────────────────────────────────────────────────────
        });

        TrueMusic.poru.on('nodeError', (node, err) => {
            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const data = { status: 'offline', reconnects: (prev.reconnects ?? 0) + 1 };
            statusStore.setNode(name, data);
            const message = err?.message || String(err || 'unknown');
            const transient = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket/i.test(message);
            lavalinkConsole.updateNode(node, transient ? 'transient_error' : 'error', {
                event: 'node_error',
                reconnects: data.reconnects,
                note: message,
            });
        });


        TrueMusic.on('guildCreate', async (guild) => {
            let dataaa = store.get('tokens') || [];

            let tokenObj = dataaa.find((tokenBot) => tokenBot.token === TrueMusic.token);

            if (!tokenObj) {
                return;
            }

            if (guild.id !== tokenObj.Server) {
                if (guild.ownerId !== TrueMusic.user.id) {
                    try {
                        await guild.leave();
                        console.log(`Left guild: ${guild.name}`);
                    } catch (error) {
                    }
                }
            }
        });

        let lastVCStatus = null;
        let voiceReturnLock = false;

        // ── مؤقت retry للرجوع للروم عند الطرد القسري ────────────────────────────
        let voiceRejoinRetryTimer = null;

        async function _attemptVoiceRejoin(guild, tokenObj, attempt = 1) {
            if (!guild || !tokenObj?.channel || tokenObj.awaitingReplacement) return;
            if (!TrueMusic.readyAt) return;

            try {
                await ensureConfiguredVoice(guild, tokenObj, `voice_state_update_retry_${attempt}`);
            } catch {
                // فشل — أعد المحاولة بـ backoff (2s → 4s → 8s → 12s → 20s)
                const delays = [2000, 4000, 8000, 12000, 20000];
                const delay = delays[Math.min(attempt - 1, delays.length - 1)];
                if (attempt < 6) {
                    clearTimeout(voiceRejoinRetryTimer);
                    voiceRejoinRetryTimer = setTimeout(() => {
                        const freshTokenObj = (store.get('tokens') || []).find(t => t.token === token);
                        if (freshTokenObj?.channel && !freshTokenObj.awaitingReplacement) {
                            _attemptVoiceRejoin(guild, freshTokenObj, attempt + 1);
                        }
                    }, delay);
                    voiceRejoinRetryTimer.unref?.();
                }
            }
        }

        TrueMusic.on('voiceStateUpdate', async (oldState, newState) => {
            if (newState.member?.id !== TrueMusic.user?.id) return;
            if (voiceReturnLock) return;

            const tokenObj = (store.get('tokens') || []).find(t => t.token === token);
            if (!tokenObj?.channel || tokenObj.awaitingReplacement) return;

            const targetChannelId = tokenObj.channel;
            // البوت وصل للروم الصح — ألغِ أي retry معلق
            if (newState.channelId === targetChannelId) {
                clearTimeout(voiceRejoinRetryTimer);
                voiceRejoinRetryTimer = null;
                return;
            }
            // تم نقله لروم ثاني — تحقق من onlyBot و backToVoice
            if (newState.channelId) {
                if (tokenObj.onlyBot === 'on') {
                    // onlyBot: لو بوت سحبه يبقى في الروم الجديد حتى ينطرد
                    // لو إنسان سحبه يرجع لرومه الأصلي فوراً
                    const guild = newState.guild || oldState.guild;
                    const movedByBot = await checkMovedByBot(guild);
                    if (movedByBot) return; // بوت سحبه — لا نرجعه
                    // إنسان سحبه — نكمل للرجوع أدناه
                } else if (tokenObj.backToVoice === 'off') {
                    return;
                }
            }

            // ── البوت طُرد أو خرج من الروم — أرجعه فوراً بغض النظر عن isStopped ──
            // isStopped() تعني "أوقف التشغيل" لا "اخرج من الروم"
            // إذا فيه channel محدد → البوت يبقى في الروم دائماً
            const guild = newState.guild || oldState.guild;
            const targetChannel = guild?.channels.cache.get(targetChannelId)
                || await guild?.channels.fetch(targetChannelId).catch(() => null);
            if (!targetChannel) return;

            voiceReturnLock = true;
            clearTimeout(voiceRejoinRetryTimer);
            voiceRejoinRetryTimer = null;
            try {
                await _attemptVoiceRejoin(guild, tokenObj, 1);
            } finally {
                setTimeout(() => { voiceReturnLock = false; }, 800);
            }
        });

        // ── limitGuard: أبلغ المستخدم عند تجاوز لمت الروم ──────────────────────
        TrueMusic.on('voiceStateUpdate', (oldState, newState) => {
            // فقط عند الدخول لروم جديد (ليس البوت نفسه)
            if (!newState.channelId) return;
            if (newState.channelId === oldState.channelId) return;
            if (newState.member?.user?.bot) return;

            // فقط الروم المخصص لهذا البوت
            const tkObj = (store.get('tokens') || []).find(t => t.token === token);
            if (!tkObj?.channel || tkObj.channel !== newState.channelId) return;

            // نحل الروم من guild cache مباشرة — مُحدَّث دائماً عبر gateway CHANNEL_UPDATE
            const channel = newState.guild?.channels.cache.get(newState.channelId) ?? newState.channel;
            if (!channel?.userLimit) return; // 0 أو غير محدد = لا يوجد لمت

            // عدّ كل الأعضاء (بوتات + بشر) — نفس طريقة حساب ديسكورد
            const humanCount = channel.members.size;
            // humanCount > userLimit (تجاوز فعلي، مو مساواة)
            if (humanCount <= channel.userLimit) return;

            // cooldown لمنع الإزعاج (30 ثانية لكل شخص في نفس الروم)
            const ck = `${newState.channelId}:${newState.member.id}`;
            const now = Date.now();
            if (_limitGuardCooldown.has(ck) && now - _limitGuardCooldown.get(ck) < _LIMIT_GUARD_COOLDOWN_MS) return;
            _limitGuardCooldown.set(ck, now);

            // إرسال فوري — fire and forget بدون await
            const _limitEmbed = new EmbedBuilder()
                .setDescription(`**يرجى مغادرة الروم وعدم تجاوز اللمت الخاص بالروم.**`);
            channel.send({ content: `<@${newState.member.id}>`, embeds: [_limitEmbed] }).catch(() => {});
        });

        // ── Fix: Re-init Lavalink after Discord WebSocket shard resumes ──────────
        TrueMusic.on('shardResume', () => {
            const allOffline = TrueMusic.poru?.nodes?.size > 0 &&
                [...(TrueMusic.poru.nodes?.values() || [])].every(n => !n.isConnected);
            if (allOffline) {
                requestPoruInit('Shard resumed with all nodes offline', 15_000);
            } else {
                // Nodes are connected — recover any stalled players
                TrueMusic.poru?.nodes?.forEach?.((node) => {
                    if (node.isConnected) scheduleNodeRecovery(node, 'shard_resume');
                });
            }
            // إجبار كل player على تجديد voice state (Discord لا يعيد VOICE_SERVER_UPDATE تلقائياً)
            lavalinkKeepAlive.onShardReconnect(TrueMusic, TrueMusic.poru, 5000);
        });

        // ── Fix: أيضاً عند shardReconnecting (قبل اكتمال الاتصال) ───────────────
        TrueMusic.on('shardReconnecting', () => {
            // تأخير أطول لأن الـ shard لم يكتمل بعد
            lavalinkKeepAlive.onShardReconnect(TrueMusic, TrueMusic.poru, 8000);
        });

        TrueMusic.once('clientReady', async () => {
            await refreshEmbedColor(TrueMusic).catch(() => {});
            // Sync custom emojis to this bot's application so react() can use them
            syncMusicEmojis(TrueMusic, MUSIC_EMOJIS)
                .then(map => {
                    MUSIC_EMOJIS.setEmojiMap(map, TrueMusic);
                    // Load + cache emojis for reactions using 3 methods (guild → app → string).
                    // Runs once at startup; react() becomes a pure Map lookup afterwards.
                    return MUSIC_EMOJIS.loadMusicEmojis(TrueMusic);
                })
                .catch(err => console.warn(`[EmojiSync] ${err?.message || err}`));
            warnUnavailableMusicEmojis(TrueMusic);
            warmTintCache(TINTED_ICON_FILES, [getEmbedColor(TrueMusic)]);
            // Patch Lavalink v4 resume/keep-alive before the first node connection.
            // No session IDs are persisted across process restarts.
            lavalinkKeepAlive.prepareNodes(TrueMusic.poru);
            try {
                TrueMusic.poru.init(TrueMusic);
            } catch (e) {
                lavalinkConsole.updateBot(TrueMusic, {
                    token,
                    state: 'init_failed',
                    event: 'poru_init_failed',
                    note: e?.message || e,
                });
            }
            collection.set(TrueMusic.user.id, TrueMusic);

            // ── Startup Guarantee (Layer 1) ────────────────────────────────────────
            // poru.init() fires the WS connection but doesn't wait for it.
            // If Lavalink is briefly down (restart, deploy, cold start) the bot
            // will fail silently and stay broken forever.
            // Fix: retry up to 3 times with 8s between attempts so every new
            // bot always ends up connected even during Lavalink hiccups at startup.
            (async () => {
                for (let startupAttempt = 1; startupAttempt <= 3; startupAttempt++) {
                    const ready = await waitForPoruReady(8_000);
                    if (ready) {
                        if (startupAttempt > 1) {
                            lavalinkConsole.updateBot(TrueMusic, {
                                token,
                                state: 'online',
                                event: 'startup_connected',
                                note: `Connected on startup attempt ${startupAttempt}`,
                            });
                        }
                        break;
                    }
                    if (startupAttempt < 3) {
                        lavalinkConsole.updateBot(TrueMusic, {
                            token,
                            state: 'startup_retry',
                            event: 'lavalink_not_ready',
                            note: `Startup attempt ${startupAttempt}/3`,
                        });
                        // Reset attempt counters so Poru doesn't think it already tried
                        TrueMusic.poru?.nodes?.forEach(node => {
                            try {
                                node.attempt = 0;
                                clearTimeout(node.reconnectAttempt);
                                node.reconnectAttempt = null;
                            } catch {}
                        });
                        lastPoruInitAt = 0; // bypass cooldown for startup retries
                        restorePoruNodes(TrueMusic.poru, TrueMusic, 'startup retry');
                    } else {
                        lavalinkConsole.updateBot(TrueMusic, {
                            token,
                            state: 'startup_failed',
                            event: 'startup_failed',
                            note: 'Watchdog will keep retrying',
                        });
                    }
                }
            })().catch(() => {});
            // ──────────────────────────────────────────────────────────────────────

            TrueMusic.poru.players.forEach(player => {
                player.queue.clear();
                player.skip?.().catch(() => {});
            });

            // ── Optional Lavalink REST health monitor ─────────────────────────────
            // Disabled by default for large bot fleets. A REST probe per bot can
            // overload Lavalink/Railway networking and a transient fetch failure
            // should not disconnect an otherwise connected Poru node.
            if (process.env.PORU_REST_HEALTH_MONITOR === '1') {
                const nodeRestFailures = new Map();
                setInterval(async () => {
                    if (!TrueMusic.readyAt) return;
                    const nodes = [...(TrueMusic.poru?.nodes?.values() || [])];
                    if (!nodes.length) return;

                    const allOffline = nodes.every(n => !n.isConnected);
                    if (allOffline) {
                        lavalinkConsole.updateBot(TrueMusic, {
                            token,
                            state: 'reinit',
                            event: 'rest_monitor_offline',
                            note: 'REST monitor found all nodes offline',
                        });
                        requestPoruInit('REST monitor found all nodes offline', 30_000);
                        return;
                    }

                    for (const node of nodes) {
                        const name = node.options?.name || node.options?.host;
                        if (!node.isConnected) {
                            lavalinkConsole.updateNode(node, 'reconnecting', {
                                event: 'rest_monitor_reconnect',
                                note: 'Node disconnected; reconnect requested',
                            });
                            try { node.connect?.(); } catch {}
                            continue;
                        }

                        try {
                            const proto = node.options?.secure ? 'https' : 'http';
                            const url = `${proto}://${node.options.host}:${node.options.port}/version`;
                            const res = await fetch(url, {
                                headers: { Authorization: node.options.password },
                                signal: AbortSignal.timeout(6000),
                            });
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);
                            nodeRestFailures.delete(name);
                        } catch (e) {
                            const failures = (nodeRestFailures.get(name) || 0) + 1;
                            nodeRestFailures.set(name, failures);
                            lavalinkConsole.updateNode(node, 'rest_unresponsive', {
                                event: 'rest_probe_failed',
                                note: `${e.message} (${failures}/3), keeping WS connected`,
                            });
                            if (failures >= 3 && !TrueMusic.poru.players.size) {
                                nodeRestFailures.set(name, 0);
                                requestPoruInit(`REST monitor repeated failures for ${name}`, 60_000);
                            }
                        }
                    }
                }, 180_000);
            }
            // ─────────────────────────────────────────────────────────────────────

            let int = setInterval(async () => {
                if (!TrueMusic.readyAt) return;

                let dataaa = store.get('tokens') || [];

                let tokenObj = dataaa.find((tokenBot) => tokenBot.token === token);

                if (!tokenObj) {
                    lavalinkConsole.updateBot(TrueMusic, {
                        token,
                        state: 'stopped',
                        event: 'token_removed',
                        note: 'Subscription token removed',
                    });
                    clearInterval(playbackWatchdog);
                    lavalinkKeepAlive.destroyKeepAlive(TrueMusic.poru); // Fix #8: تنظيف intervals قبل destroy
                    await TrueMusic.destroy().catch(() => 0);
                    runningBots.delete(token);
                    return clearInterval(int);
                }

                if (tokenObj.awaitingReplacement || tokenObj.expireDate <= Date.now()) {
                    lavalinkConsole.updateBot(TrueMusic, {
                        token,
                        state: 'stopped',
                        event: tokenObj.awaitingReplacement ? 'awaiting_replacement' : 'expired',
                        note: tokenObj.awaitingReplacement ? 'Awaiting replacement token' : 'Subscription expired',
                    });
                    clearInterval(playbackWatchdog);
                    lavalinkKeepAlive.destroyKeepAlive(TrueMusic.poru); // Fix #8: تنظيف intervals قبل destroy
                    await TrueMusic.destroy().catch(() => 0);
                    runningBots.delete(token);
                    return clearInterval(int);
                }

                // ── Lavalink Node Guardian (Layers 2 + 3) ────────────────────────────
                // Runs every 15s for EVERY bot regardless of channel assignment.
                //
                // Layer 2 — WS readyState ground-truth check
                //   node.isConnected can lie (flag not cleared on silent WS close).
                //   node.ws.readyState === 1 (OPEN) is the real source of truth.
                //   Any node with WS != OPEN is force-reconnected immediately,
                //   no cooldown — this is a lightweight per-node call, not a full init.
                //
                // Layer 3 — Proactive attempt-counter reset
                //   Poru gives up permanently when node.attempt >= reconnectTries (50).
                //   We reset it at 30 so the bot NEVER exhausts its reconnect budget.
                //   For truly connected nodes we reset to 0 as maintenance.
                {
                    const nodes = TrueMusic.poru?.nodes;
                    if (!nodes || nodes.size === 0) {
                        // Poru was never initialized or all nodes vanished
                        if (TrueMusic.readyAt) {
                            requestPoruInit('No Poru nodes registered', 60_000);
                        }
                    } else {
                        let connectedCount = 0;

                        for (const [, node] of nodes) {
                            // WS readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
                            const wsState = node.ws?.readyState;
                            const wsOpen  = wsState === 1;
                            const truly   = wsOpen && node.isConnected === true;

                            if (truly) {
                                // Layer 3: connected — keep attempt at 0 as maintenance
                                if ((node.attempt ?? 0) > 0) node.attempt = 0;
                                connectedCount++;
                                continue;
                            }

                            // ── Not truly connected ────────────────────────────────────
                            const name = node.options?.name || node.options?.host || 'node';

                            // Layer 3: reset attempt counter BEFORE it hits the limit (50)
                            if ((node.attempt ?? 0) >= 30) {
                                node.attempt = 0;
                                clearTimeout(node.reconnectAttempt);
                                node.reconnectAttempt = null;
                                lavalinkConsole.updateNode(node, 'reconnecting', {
                                    event: 'attempt_counter_reset',
                                    note: 'Reset reconnect attempt counter',
                                });
                            }

                            // Layer 2: WS is CLOSED/never opened → force reconnect now
                            if (wsState === 3 || wsState === undefined || wsState === null) {
                                try {
                                    node.attempt = 0;
                                    clearTimeout(node.reconnectAttempt);
                                    node.reconnectAttempt = null;
                                    node.connect?.().catch(() => {});
                                    lavalinkConsole.updateNode(node, 'reconnecting', {
                                        event: 'forced_reconnect',
                                        note: `WS=${wsState ?? 'none'}`,
                                    });
                                } catch {}
                            }
                            // wsState 0 (CONNECTING) or 2 (CLOSING) → in progress, wait
                        }

                        // All nodes dead AND all WS sockets closed → full re-init fallback
                        if (connectedCount === 0) {
                            const allSocketsClosed = [...nodes.values()].every(n => {
                                const ws = n.ws?.readyState;
                                return ws === 3 || ws === undefined || ws === null;
                            });
                            if (allSocketsClosed) {
                                requestPoruInit('All nodes dead — full re-init fallback', 30_000);
                            }
                        }
                    }
                }
                // ─────────────────────────────────────────────────────────────────────

                if (tokenObj.channel) {
                    // ── Heartbeat: keep activity alive so idle-killer never fires ──
                    botLastActivity.set(token, Date.now());

                    let guild = TrueMusic.guilds.cache.get(tokenObj.Server);
                    if (guild) {
                        const musicChannel = guild.channels.cache.get(tokenObj.channel);
                        if (musicChannel) {
                            const currentVC = guild.members.me.voice.channel;

                            const backToVoice = tokenObj.backToVoice !== 'off';
                            const shouldReconnect = !currentVC || (backToVoice && currentVC.id !== musicChannel.id);

                            if (shouldReconnect) {
                                if (!TrueMusic.readyAt) return;
                                // لا نتحقق من isStopped() — البوت يبقى في الروم دائماً
                                // حتى لو أوقف المستخدم التشغيل، الـ 24/7 channel يعني البوت لا يخرج

                                try {
                                    await ensureConfiguredVoice(guild, tokenObj, 'periodic_guard');
                                } catch (err) {
                                }
                            }
                        }
                    }
                } else {
                    let guild = TrueMusic.guilds.cache.get(tokenObj.Server);
                    if (guild) {
                        const player = TrueMusic.poru.players.get(guild.id);
                        if (player) {
                            // Cancel pre-fetch timer before destroy to prevent the
                            // callback from calling player.resolveTrack on a dead player
                            if (player.data?._prefetchTimer) {
                                clearTimeout(player.data._prefetchTimer);
                                player.data._prefetchTimer = null;
                            }
                            await finalizePlayerUi(player);
                            await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                            player.destroy();
                        }
                    }
                }

                if (tokenObj.token === TrueMusic.token) {
                    const currentStatus = TrueMusic.user.presence?.activities[0]?.name;
                    const newStatus = tokenObj.status || statuses;

             if (currentStatus !== newStatus) {
  TrueMusic.user.setPresence({
    activities: [
      {
        name: String(newStatus || "Ens Music"),
        type: ActivityType.Streaming,
        url: Array.isArray(TwitchUrl) ? TwitchUrl[0] : TwitchUrl,
      },
    ],
    status: 'online',
  });
}

                }

                // ── Optimization: merged watchdog (was separate 20s timer) ──────
                // Checks stalled playback — runs every 15s here instead of
                // spawning a dedicated setInterval per bot.
                const wdNow = Date.now();
                // Skip stall recovery if Lavalink is currently offline — reinit already triggered above
                const wdNodesOnline = [...(TrueMusic.poru?.nodes?.values() || [])].some(n => n.isConnected);
                if (wdNodesOnline) {
                    TrueMusic.poru.players.forEach(player => {
                        if (!player.currentTrack || player.isPaused) return;
                        ensurePlayerData(player);
                        const lastProgress = player.data.lastProgressAt || player.data.trackStartedAt || wdNow;
                        const length = Number(player.currentTrack.info?.length || 0);
                        const grace = length && length < 90_000 ? 35_000 : 55_000;
                        if (wdNow - lastProgress > grace) {
                            recoverPlayerPlayback(player, 'stalled_progress').catch(() => {});
                        }
                    });
                }


                // ── Idle player cleanup ──────────────────────────────────────────
                // A Poru player that has no current track for a long time can lose
                // its Lavalink session. Do not destroy it because that sends
                // channel_id:null and makes the bot leave voice. Mark it so the next
                // play command refreshes Lavalink internally before starting audio.
                if (wdNodesOnline) {
                    TrueMusic.poru.players.forEach(player => {
                        ensurePlayerData(player);
                        if (player.currentTrack || player.isPlaying) {
                            player.data.lastIdleAt = null; // reset when active
                            return;
                        }
                        if (!player.data.lastIdleAt) {
                            player.data.lastIdleAt = wdNow;
                            return;
                        }
                        if (wdNow - player.data.lastIdleAt > IDLE_PLAYER_REFRESH_MS && !player.data.needsVoiceRefresh) {
                            if (process.env.DEBUG_RECOVERY)
                                console.log(`[IdleCleanup] marking stale idle player for guild ${player.guildId} (idle ${Math.floor((wdNow - player.data.lastIdleAt) / 60000)}min)`);
                            markPlayerNeedsVoiceRefresh(player, 'idle_ttl');
                        }
                    });
                }
                // ─────────────────────────────────────────────────────────────────

                // ── Zombie-connection detection for music sub-bots ────────────────
                // Root cause of Lavalink drops for idle bots:
                // Bots with no voice channel are in quiet servers that generate
                // almost no raw gateway events. The old 4-minute threshold was
                // firing constantly → shard reconnects → Lavalink session disruption.
                //
                // Fix: use Discord.js's actual WebSocket ping to check if the
                // connection is truly alive. A ping of -1 means disconnected.
                // Raw-event timing is only a fallback for genuine zombie shards
                // (ping stuck but events stopped).
                //
                // For bots with no channel (idle/stock): NEVER force-reconnect
                // based on raw event absence alone — Discord.js handles its own
                // heartbeat and will reconnect automatically if truly dead.
                // Only reconnect if Discord.js itself reports the connection lost.
                {
                    const tokenObjForZombie = (store.get('tokens') || []).find(t => t.token === token);
                    const hasChannel = !!(tokenObjForZombie?.channel);
                    const wsPing = TrueMusic.ws?.ping ?? -1;
                    const isDiscordConnected = TrueMusic.readyAt && wsPing !== -1;

                    if (hasChannel) {
                        // Bot is in active voice use: use the combined check
                        // (Discord.js ping dead OR extended raw event silence)
                        const MUSIC_ZOMBIE_THRESHOLD_MS = 8 * 60 * 1000; // 8 min (raised from 4)
                        const musicElapsed = Date.now() - lastMusicEventAt;
                        const shouldReconnect = !isDiscordConnected ||
                            (musicElapsed > MUSIC_ZOMBIE_THRESHOLD_MS && wsPing > 30_000);
                        if (shouldReconnect) {
                            lavalinkConsole.updateBot(TrueMusic, {
                                token,
                                state: 'discord_reconnect',
                                event: 'zombie_shard_detected',
                                note: `ping=${wsPing}ms silence=${Math.floor(musicElapsed/1000)}s`,
                            });
                            lastMusicEventAt = Date.now();
                            try {
                                if (TrueMusic.ws?.shards?.size > 0) {
                                    TrueMusic.ws.shards.forEach(shard => {
                                        try { shard.destroy({ recover: true }); } catch {}
                                    });
                                }
                            } catch {}
                        }
                    } else {
                        // Idle/stock bot: ONLY reconnect if Discord.js reports dead
                        // Never reconnect just because no raw events arrived —
                        // quiet servers generate no events and that is normal.
                        if (!isDiscordConnected && TrueMusic.readyAt) {
                            lavalinkConsole.updateBot(TrueMusic, {
                                token,
                                state: 'discord_reconnect',
                                event: 'idle_discord_disconnected',
                                note: `ping=${wsPing}`,
                            });
                            lastMusicEventAt = Date.now();
                            try {
                                if (TrueMusic.ws?.shards?.size > 0) {
                                    TrueMusic.ws.shards.forEach(shard => {
                                        try { shard.destroy({ recover: true }); } catch {}
                                    });
                                }
                            } catch {}
                        }
                    }
                }
                // ─────────────────────────────────────────────────────────────────

            }, 15_000); // ── Optimization: was 5s → 15s (3× fewer fires, same responsiveness for music)
        });








        TrueMusic.on('messageCreate', async (message) => {
            if (message.author.bot || !message.guild) return;
            botLastActivity.set(token, Date.now());
            var data = store.get('tokens') || [];
            let tokenObj = data.find((t) => t.token == token);
            if (!data || !tokenObj) return;

            let args = message.content?.trim().split(/ +/).filter(Boolean);
            if (args) {
                const hasMention = args.includes(`<@!${TrueMusic.user.id}>`) || args.includes(`<@${TrueMusic.user.id}>`);
                const ownerCommandNameNoMention = String(args[0] || '').toLowerCase();
                const isAllVoiceCommandNoMention = !hasMention
                    && String(args[1] || '').toLowerCase() === 'all'
                    && (ownerCommandNameNoMention === 'setup'
                        || ['join', 'come', 'setvc', 'ادخل', 'تعال'].includes(ownerCommandNameNoMention));
                if (isAllVoiceCommandNoMention) {
                    if (!canControlSubscription(tokenObj, message.author.id)) return;
                    return handleAllVoiceCommand(message, ownerCommandNameNoMention === 'setup' ? 'setup' : 'join', data, tokenObj);
                }
                if (hasMention) {
                    args = args.filter(arg => {
                        const mentionedId = String(arg || '').match(/^<@!?(\d{15,20})>$/)?.[1];
                        if (!mentionedId) return true;
                        return !runningBots.some(bot => bot.user?.id === mentionedId);
                    });

                    if (!args[0]) return;
                    if (args[0] == 'help') {
                        if (!markVoiceScopedUtilityHandled(message, 'help')) return;
                        return sendFullHelpPanel(message, tokenObj);
                    }


                    if (!canControlSubscription(tokenObj, message.author.id)) {
                        return;
                    }
                    const ownerCommandName = String(args[0] || '').toLowerCase();
                    const isAllVoiceCommand = String(args[1] || '').toLowerCase() === 'all'
                        && (ownerCommandName === 'setup'
                            || ['join', 'come', 'setvc', 'ادخل', 'تعال'].includes(ownerCommandName));
                    if (isAllVoiceCommand) {
                        return handleAllVoiceCommand(message, ownerCommandName === 'setup' ? 'setup' : 'join', data, tokenObj);
                    }
                    const isVoiceCommand = ownerCommandName === 'setup'
                        || ['join', 'come', 'setvc', 'ادخل', 'تعال'].includes(ownerCommandName);
                    const mentionedBotIds = [...message.mentions.users.keys()]
                        .filter(id => id !== message.author.id && runningBots.some(bot => bot.user?.id === id));
                    if (isVoiceCommand && mentionedBotIds.length > 1) {
                        const targets = data
                            .filter(t => t?.token && t.code === tokenObj.code)
                            .map(t => ({ token: t.token, tokenObj: t, bot: runningBots.get(t.token) }))
                            .filter(t => t.bot?.user && mentionedBotIds.includes(t.bot.user.id) && t.bot.guilds.cache.has(message.guild.id));
                        return handleAllVoiceCommand(
                            message,
                            ownerCommandName === 'setup' ? 'setup' : 'join',
                            data,
                            tokenObj,
                            targets,
                            `mentions:${mentionedBotIds.sort().join(',')}`,
                        );
                    }

                    if (args[0] == 'restart' || args[0] == 'اعاده') {
                        await TrueMusic.destroy()
                        setTimeout(async () => {
                            TrueMusic.login(token).then(() => {
                                reactCustom(message, MUSIC_EMOJIS.settings, '💹')
                            }).catch(() => { console.log(`${TrueMusic.user.tag} (${TrueMusic.user.id}) has an error with restarting.`) })
                        }, 5000)

                    } else if (args[0] == 'setname' || args[0] == 'اسم' || args[0] == 'name' || args[0] == 'sn') {
                        let name = args.slice(1).join(' ');
                        if (!name) return;

                        const tryChangeName = (newName, attempts = 0) => {
                            TrueMusic.user.setUsername(newName).then(async () => {
                                reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                            }).catch((error) => {
                                if (error.code === 50035) {
                                    if (attempts < 3) {
                                        const newNameWithDot = `${newName}.`;
                                        tryChangeName(newNameWithDot, attempts + 1);
                                    } else {
                                        message.react('⏳').catch(() => 0);
                                    }
                                } else {
                                    console.error(error);
                                    message.reply("An error occurred while changing the bot's name.");
                                }
                            });
                        };

                        tryChangeName(name);
                    } else if (args[0] == 'setavatar' || args[0] == 'صورة' || args[0] == 'avatar' || args[0] == 'avatar' || args[0] == 'sa') {
                        let url = args[1];
                        if (!url && !message.attachments.first()) return;

                        if (message.attachments.first()) {
                            url = message.attachments.first().url;
                        }

                        TrueMusic.user.setAvatar(url)
                            .then(() => {
                                refreshEmbedColor(TrueMusic).catch(() => {});
                                reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                            })
                            .catch((error) => {
                                reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                            });

                    } else if (args[0] == 'leave' || args[0] == 'اخرج' || args[0] == 'اطلع' || args[0] == 'disablechannel') {
                        let data = store.get('tokens') || [];
                        tokenObj = data.find((tokenBot) => tokenBot.token == token);
                        data = data.map((tokenBot) => {
                            if (tokenBot.token == token) {
                                tokenBot.channel = null;
                            }
                            return tokenBot;
                        });
                        store.set('tokens', data);
                        reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                    }
                    else if (args[0] == 'setup') {
                        let channel = message.member.voice.channel;
                        if (!channel) {
                            return promptVoiceChannelSelection(message, 'setup', tokenObj, { renameToChannel: true });
                        }

                        const result = await setConfiguredVoiceChannel(message.guild, channel, message.channel.id, 'setup', tokenObj, { renameToChannel: true });
                        if (result.ok) {
                            reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                        } else {
                            message.reply({ embeds: [buildVoiceSelectEmbed('setup', message.author, channel, 'failed', result.reason)] }).catch(() => {});
                        }

                    } else if (args[0] == 'join' || args[0] == 'come' || args[0] == 'setvc' || args[0] == 'ادخل' || args[0] == 'تعال') {

                        let channel = message.member.voice.channel;
                        if (!channel) {
                            return promptVoiceChannelSelection(message, 'join', tokenObj);
                        }

                        const result = await setConfiguredVoiceChannel(message.guild, channel, message.channel.id, 'join', tokenObj);
                        if (result.ok) {
                            reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                        } else {
                            message.reply({ embeds: [buildVoiceSelectEmbed('join', message.author, channel, 'failed', result.reason)] }).catch(() => {});
                        }
                    } else if (args[0] == 'setbanner' || args[0] == 'sb' || args[0] == 'بنر') {
                        const imageUrl = message.attachments.first()?.url || args[1];
                        if (!imageUrl) return reactCustom(message, MUSIC_EMOJIS.dislike, '❌');
                        try {
                            await TrueMusic.user.setBanner(imageUrl);
                            reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                        } catch {
                            reactCustom(message, MUSIC_EMOJIS.dislike, '❌');
                        }
                    }

                    else if (args[0] == 'setchat' || args[0] == 'chat' || args[0] == 'settc' || args[0] == 'اوامر') {
                        let parsedData = store.get('tokens') || [];

                        tokenObj = parsedData.find((tokenBot) => tokenBot.token == token);

                        if (!tokenObj) return;

                        let channel = message.guild.channels.cache.get(message.channel.id);

                        if (!channel) return;

                        parsedData = parsedData.map((tokenBot) => {
                            if (tokenBot.token == token) {
                                tokenBot.chat = channel.id;
                            }
                            return tokenBot;
                        });

                        store.set('tokens', parsedData);
                        reactCustom(message, MUSIC_EMOJIS.settings, '✅');

                    } else if (args[0] == 'unchat' || args[0] == 'unt' || args[0] == 'الغاء') {
                        let parsedData = store.get('tokens') || [];

                        tokenObj = parsedData.find((tokenBot) => tokenBot.token == token);

                        if (!tokenObj) return;

                        let channelId = tokenObj.chat;
                        if (!channelId) return message.reply('> **There is no specific command chat.**');

                        parsedData = parsedData.map((tokenBot) => {
                            if (tokenBot.token == token) {
                                delete tokenBot.chat;
                            }
                            return tokenBot;
                        });

                        store.set('tokens', parsedData);
                        reactCustom(message, MUSIC_EMOJIS.settings, '✅');
                        loadPrefix();

                    } else if (args[0] == 'ping' || args[0] == 'بنج' || args[0] == 'بنغ') {
                        const ping = TrueMusic.ws.ping;
                        message.reply(`> **ϟ Pong! My ping is \`${ping}ms.\`**`);

                    } else if (args[0] == 'setstreaming' || args[0] == 'streaming' || args[0] == 'ste' || args[0] == 'ستريمنج') {
                        let status = args.slice(1).join(' ').trim();
                        if (!status) return reactCustom(message, MUSIC_EMOJIS.dislike, '❌');
                        const twitchUrlCfg = Array.isArray(TwitchUrl) ? TwitchUrl[0] : TwitchUrl;
                        TrueMusic.user.setPresence({
                            activities: [
                                {
                                    name: status,
                                    type: ActivityType.Streaming,
                                    url: twitchUrlCfg || 'https://www.twitch.tv/tnbeh',
                                },
                            ],
                            status: 'online',
                        });
                        reactCustom(message, MUSIC_EMOJIS.settings, '✅');

                        let tokens = store.get('tokens') || [];
                        let tokenObj = tokens.find((tokenBot) => tokenBot.token == token);
                        if (tokenObj) {
                            tokenObj.status = status;
                            store.set('tokens', tokens);
                        }
                    } else if (args[0] == 'setprefix') {
                        if (!args[1]) return message.reply("> **Please write the prefix**");

                        let newPrefix = args[1];

                        let parsedData = store.get('tokens') || [];
                        let tokenObj = parsedData.find((tokenBot) => tokenBot.token === token);
                        if (tokenObj) {
                            tokenObj.prefix = newPrefix;
                        } else {
                            parsedData.push({ token, prefix: newPrefix });
                        }
                        store.set('tokens', parsedData);

                        message.reply(`> **The prefix has been determined.** \`${newPrefix}\``);

                    } else if (args[0] === 'unsetprefix') {
                        let parsedData = store.get('tokens') || [];
                        let tokenObj = parsedData.find((tokenBot) => tokenBot.token === token);
                        if (tokenObj) {
                            tokenObj.prefix = null;
                            store.set('tokens', parsedData);
                            message.reply('> **The prefix has been removed.**');
                        }

                    }

                }
            }
        });



    TrueMusic.poru.on('playerDestroy', (player) => {
        clearProgressInterval(player, 'player_destroyed');
    });

    TrueMusic.poru.on('playerUpdate', (player) => {
        ensurePlayerData(player);
        const position = Number(player.position || 0);
        if (position > (player.data.lastPosition || 0) + 750 || !player.data.lastProgressAt) {
            player.data.lastProgressAt = Date.now();
            player.data.recoveryAttempts = 0;
        }
        player.data.lastPosition = position;
    });

    // ── trackStuck: Poru v5 يُطلقه كـ event مستقل (منفصل عن trackError) ─────────
    TrueMusic.poru.on('trackStuck', async (player, track, data) => {
        ensurePlayerData(player);
        const stuckTrack = track || player.currentTrack || player.data.lastTrack;
        const identity   = trackIdentity(stuckTrack);
        const lastRecoveryAt  = Number(player.data.stuckRecoveryAt || 0);
        const sameRecentTrack = player.data.stuckRecoveryIdentity === identity
            && Date.now() - lastRecoveryAt < 30_000;

        if (stuckTrack && identity && !sameRecentTrack && typeof player.queue?.unshift === 'function') {
            // أعد تشغيل الأغنية من حيث توقفت
            player.queue.unshift(stuckTrack);
            player.data.stuckRecoveryIdentity = identity;
            player.data.stuckRecoveryAt       = Date.now();
            player.data.stuckResumePosition   = Math.max(0,
                Number(player.position || player.data.lastPosition || 0) - 2000);
            if (process.env.DEBUG_RECOVERY)
                console.warn(`[TrackStuck] requeued stuck track at ${player.data.stuckResumePosition}ms`);
            // تخطّ الأغنية الحالية المعلّقة → ستبدأ الأغنية المُعادة فوراً
            try { await player.stop(); } catch {}
            return;
        }

        // تعذّرت الاسترداد (نفس الأغنية عالقة مرتين في 30s) → تخطّى وتابع
        console.warn(`[TrackStuck] skip stuck track: ${identity || 'unknown'} (no recovery)`);
        await finalizePlayerUi(player);
        await bumpQueueVersion(player, 'track_stuck');
        setTimeout(() => recoverPlayerPlayback(player, 'track_stuck').catch(() => {}), 1500);
    });

    TrueMusic.poru.on('trackError', async (player, track, data) => {
        if (data?.type === 'TrackStuckEvent') {
            // Poru v5 قد يُرسل TrackStuckEvent هنا أيضاً — عالجه بنفس منطق trackStuck
            ensurePlayerData(player);
            const stuckTrack = track || player.currentTrack || player.data.lastTrack;
            const identity = trackIdentity(stuckTrack);
            const lastRecoveryAt = Number(player.data.stuckRecoveryAt || 0);
            const sameRecentTrack = player.data.stuckRecoveryIdentity === identity && Date.now() - lastRecoveryAt < 30_000;
            if (stuckTrack && identity && !sameRecentTrack && typeof player.queue?.unshift === 'function') {
                player.queue.unshift(stuckTrack);
                player.data.stuckRecoveryIdentity = identity;
                player.data.stuckRecoveryAt = Date.now();
                player.data.stuckResumePosition = Math.max(0, Number(player.position || player.data.lastPosition || 0) - 2000);
                if (process.env.DEBUG_RECOVERY) console.warn(`[TrackStuck/trackError] requeued stuck track at ${player.data.stuckResumePosition}ms`);
                try { await player.stop(); } catch {}
                return;
            }
        }
        const erroredTrack = track || player.currentTrack || player.data.lastTrack;
        const errorIdentity = trackIdentity(erroredTrack);
        const lastRetryAt = Number(player.data.trackErrorRetryAt || 0);
        const sameRecentRetry = player.data.trackErrorRetryIdentity === errorIdentity
            && Date.now() - lastRetryAt < 45_000;

        if (erroredTrack && errorIdentity && isRecoverableTrackError(data) && !sameRecentRetry && typeof player.queue?.unshift === 'function') {
            player.data.trackErrorRetryIdentity = errorIdentity;
            player.data.trackErrorRetryAt = Date.now();
            player.queue.unshift(erroredTrack);
            player.currentTrack = null;
            player.isPlaying = false;
            player.isPaused = false;
            markPlayerNeedsVoiceRefresh(player, `track_error:${recoverableTrackErrorMessage(data).slice(0, 80) || 'recoverable'}`);
            warnPlayerOnce(player, `track-error-retry:${errorIdentity}`, `[TrackError] recoverable voice/session error; retrying ${errorIdentity}`, 45_000);
            setTimeout(() => safePlay(player).catch(() => recoverPlayerPlayback(player, 'track_error_retry').catch(() => {})), 1500).unref?.();
            return;
        }

        // Suppress errors silently for SoundCloud autoplay tracks (no sound is acceptable)
        const isSoundCloudAutoPlay = String(track?.info?.sourceName || '').toLowerCase().includes('soundcloud')
            && track?.info?.autoPlay === true;
        if (!isSoundCloudAutoPlay) {
            console.warn(`[TrackError] ${data?.type || 'unknown'} ${data?.reason || data?.exception?.message || ''}`.trim());
        }
        await finalizePlayerUi(player);
        await bumpQueueVersion(player, 'track_error');
        setTimeout(() => recoverPlayerPlayback(player, 'track_error').catch(() => {}), 2500).unref?.();
    });

    TrueMusic.poru.on('trackEnd', async (player, track, data) => {
      ensurePlayerData(player);
      // ── Cancel any pending pre-fetch timer for the ending track ──────────────
      if (player.data._prefetchTimer) {
          clearTimeout(player.data._prefetchTimer);
          player.data._prefetchTimer = null;
      }
      // ── Cancel any in-progress progress bar pre-warm ──────────────────────────
      if (typeof player.data._cancelProgressPrewarm === 'function') {
          player.data._cancelProgressPrewarm();
          player.data._cancelProgressPrewarm = null;
      }
      // ─────────────────────────────────────────────────────────────────────────
      const reason = data?.reason || 'unknown';
      const naturalEnd = isNaturalTrackEnd(reason);
      player.data.lastTrackEndReason = reason;
      player.data.lastTrackEndNatural = naturalEnd;

      // ── Recovery guard ────────────────────────────────────────────────────────
      // When restartCurrentTrack() is called (e.g. watchdog recovery), Lavalink
      // fires trackEnd(replaced) then trackStart for the SAME track. Without this
      // guard, finalizePlayerUi() would disable buttons and clear the panel, then
      // trackStart suppresses the duplicate → player goes silent with no UI.
      if (reason === 'replaced' && player.data._recovering) {
          const recoveryAge = Date.now() - (player.data._recoveryAt || 0);
          if (recoveryAge < 15_000) {
              player.data._recovering = false;
              if (process.env.DEBUG_NP) console.warn(`[TrackEnd] suppressed finalizePlayerUi during recovery (replaced, age=${recoveryAge}ms)`);
              await bumpQueueVersion(player, `track_end:${reason}`);
              return;
          }
      }
      // ─────────────────────────────────────────────────────────────────────────

              const isSoundCloudAutoPlayTrack = String(track?.info?.sourceName || '').toLowerCase().includes('soundcloud')
                  && track?.info?.autoPlay === true;
              if (!naturalEnd && reason !== 'stopped' && reason !== 'replaced' && !isSoundCloudAutoPlayTrack) {
                  console.warn(`[TrackEnd] non-natural end for ${trackIdentity(track) || 'unknown'}: ${reason}`);
              }

              // Note: disableIdlePlaybackModesIfAlone is intentionally NOT called
              // on trackEnd to avoid a race condition where the voice-state cache
              // hasn't updated yet between tracks — this caused autoplay to randomly
              // stop itself between songs. The queueEnd event handles the solo check.

      // Guard: if the new track already started and its panel is live, skip UI finalization
      // to avoid disabling the new panel by mistake (race condition with trackStart).
      const endingIdentity = trackIdentity(track);
      const panelIdentity = player.data.nowPlayingTrackIdentity;
      if (endingIdentity && panelIdentity && endingIdentity !== panelIdentity) {
          if (process.env.DEBUG_NP) console.warn(`[TrackEnd] skipping finalizePlayerUi — panel already moved to ${panelIdentity}`);
      } else {
          await finalizePlayerUi(player, { complete: naturalEnd, track });
      }
      await bumpQueueVersion(player, `track_end:${reason}`);
            });

                    TrueMusic.poru.on("queueEnd", async (player) => {
                      disableIdlePlaybackModesIfAlone(TrueMusic, player, 'queue_end_alone');
                      await finalizePlayerUi(player, { complete: player?.data?.lastTrackEndNatural === true });
              await bumpQueueVersion(player, 'queue_end');
              const tokenObj2 = (store.get('tokens') || []).find(t => t.token === token);
              await updatePlaybackVoiceStatus(TrueMusic, tokenObj2, player, null);
              if (!player?.data?.autoPlay || player.data.autoPlay === false) {
                player.queue.clear();
                setAutoPlayState(player, false);
                clearStoppedPlaybackCaches(player);
                markStopped();
        return;
      }
      const currentTrack = player.previousTrack || player.currentTrack || player.data?.lastTrack;
      if (!currentTrack) {
        await finalizePlayerUi(player);
        player.queue.clear();
        setAutoPlayState(player, false);
        clearStoppedPlaybackCaches(player);
        markStopped();
        return;
      }

      // Use the seed artist saved when autoplay first started to prevent artist drift
      let artistQuery;
      if (player.data.autoPlaySeedArtist) {
          artistQuery = player.data.autoPlaySeedArtist;
      } else {
          artistQuery = artistQueryForTrack(currentTrack);
          if (artistQuery?.primary) {
              player.data.autoPlaySeedArtist = artistQuery;
          }
      }
      const artistName = artistQuery?.primary;
      if (!artistName) {
        await finalizePlayerUi(player);
        player.queue.clear();
        setAutoPlayState(player, false);
        clearStoppedPlaybackCaches(player);
        markStopped();
        return;
      }

      const source = displaySettings(tokenObj2).platform || 'auto';
      const nextTrack = await resolveQuickAutoPlayTrack(TrueMusic.poru, artistQuery, source, currentTrack, player);

      if (!nextTrack) {
        await finalizePlayerUi(player);
        player.queue.clear();
        setAutoPlayState(player, false);
        clearStoppedPlaybackCaches(player);
        markStopped();
        return;
      }

      nextTrack.info.requester = currentTrack.info.requester;
      nextTrack.info.autoPlay = true;
      nextTrack.info.autoPlayArtist = artistName;
      player.queue.add(nextTrack);

      await bumpQueueVersion(player, 'autoplay_add');
      await safePlay(player);
    });



    // ── Helper: apply audio filter preset ──────────────────────────────
    function filterPayloadFor(name) {
        const selected = FILTER_PRESETS[name] ? name : 'clear';
        return {
            selected,
            filters: { ...BASE_FILTERS, ...FILTER_PRESETS[selected] },
        };
    }

    function syncPlayerFilters(player, filters) {
        if (!player?.filters) return;
        player.filters.volume = filters.volume;
        player.filters.equalizer = filters.equalizer || [];
        player.filters.karaoke = filters.karaoke || undefined;
        player.filters.timescale = filters.timescale || undefined;
        player.filters.tremolo = filters.tremolo || undefined;
        player.filters.vibrato = filters.vibrato || undefined;
        player.filters.rotation = filters.rotation || undefined;
        player.filters.distortion = filters.distortion || undefined;
        player.filters.channelMix = filters.channelMix || undefined;
        player.filters.lowPass = filters.lowPass || undefined;
    }

    async function applyFilter(player, name) {
        if (!player?.node?.rest) throw new Error('player is not connected');
        const { selected, filters } = filterPayloadFor(name);

        await updateLavalinkPlayer(player, { filters }, `filter:${name}`);

        syncPlayerFilters(player, filters);

        player.data.activeFilter = selected;
        return selected;
    }

                    // ── trackStart: always publish the normal now-playing panel ──────────
                    TrueMusic.poru.on('trackStart', async (player, track) => {
                ensurePlayerData(player);
                const identity = trackIdentity(track);
                const startLock = player.data.nowPlayingSendLock;
                if (identity && startLock?.identity === identity && Date.now() - Number(startLock.at || 0) < 15_000) {
                    if (process.env.DEBUG_NP) console.warn(`[NowPlaying] early duplicate trackStart suppressed for ${identity}`);
                    return;
                }
                if (identity) player.data.nowPlayingSendLock = { identity, at: Date.now(), starting: true };
                await bumpQueueVersion(player, 'track_start');
                clearStopped();

        // ── Recovery cleanup ──────────────────────────────────────────────────
        // If trackEnd(replaced) was suppressed by the recovery guard, _recovering
        // may still be true here. Clear it and keep the existing panel alive.
        const wasRecovering = !!player.data._recovering;
        player.data._recovering = false;
        player.data._recoveryTrackId = null;
        player.data._recoveryAt = null;
        // Clear cached progress bar so new track gets a fresh Canvas render
        player.data._lastProgressBarCache = null;
                // ─────────────────────────────────────────────────────────────────────

                const stuckRecoveryIdentity = player.data.stuckRecoveryIdentity;
                const stuckResumePosition = Math.max(0, Number(player.data.stuckResumePosition || 0));
                const shouldResumeStuckTrack = stuckRecoveryIdentity && stuckRecoveryIdentity === identity;
                const applyStuckRecoveryResume = () => {
                    delete player.data.stuckRecoveryIdentity;
                    delete player.data.stuckRecoveryAt;
                    delete player.data.stuckResumePosition;
                    if (stuckResumePosition > 0) {
                        setTimeout(() => {
                            const stillSameTrack = player.currentTrack && trackIdentity(player.currentTrack) === identity;
                            if (!stillSameTrack) return;
                            const seek = typeof player.seekTo === 'function' ? player.seekTo.bind(player) : player.seek?.bind(player);
                            if (seek) Promise.resolve(seek(stuckResumePosition)).catch(() => {});
                        }, 1200);
                    }
                };
                const previousContext = player.data.nowPlayingContext;
                const previousIdentity = player.data.nowPlayingTrackIdentity || trackIdentity(previousContext?.track);
                if (player.data.nowPlayingMessage && previousIdentity) {
                    if (identity && previousIdentity === identity) {
                        if (wasRecovering || shouldResumeStuckTrack) {
                            if (process.env.DEBUG_NP) console.warn(`[NowPlaying] recovered duplicate trackStart for ${identity}`);
                        } else {
                            warnPlayerOnce(
                                player,
                                `duplicate-panel:${identity}`,
                                `[NowPlaying] duplicate trackStart suppressed for ${identity}`,
                                10_000,
                            );
                        }
                        // If this is a recovery restart, reset timing so progress bar stays accurate
                        if (wasRecovering || shouldResumeStuckTrack) {
                            player.data.lastTrack = track;
                            player.data.lastProgressAt = Date.now();
                            player.data.trackStartedAt = Date.now();
                            player.data.lastPosition = shouldResumeStuckTrack ? stuckResumePosition : 0;
                            player.data.recoveryAttempts = 0;
                            if (shouldResumeStuckTrack) applyStuckRecoveryResume();
                        }
                        return;
                    }
            // Normal when skipping — demote to debug to avoid log noise
            if (process.env.DEBUG_NP) console.warn(`[NowPlaying] finalizing stale panel before new track: ${previousIdentity} -> ${identity || 'unknown'}`);
            await finalizePlayerUi(player, { complete: false, track: previousContext?.track });
            ensurePlayerData(player);
        }
                        player.data.lastTrack = track;
                rememberAutoPlayHistory(player, track);
        player.data.trackStartedAt = Date.now();
        player.data.lastProgressAt = Date.now();
        player.data.lastPosition = 0;
        player.data.recoveryAttempts = 0;

        // ── Pre-warm progress bar cache for all positions ─────────────────────
        // Cancel any previous pre-warm (track changed before it finished)
        if (typeof player.data._cancelProgressPrewarm === 'function') {
            player.data._cancelProgressPrewarm();
        }
        const trackDuration = Number(track.info?.length || 0);
        if (trackDuration > 0) {
            const prewarmColor = normalizeColorNumber('#9d9ad1');
            player.data._cancelProgressPrewarm = prewarmProgressBarCache({
                color:         prewarmColor,
                duration:      trackDuration,
                width:         PLAY_PROGRESS_WIDTH,
                height:        52,
                variant:       'discordCompact',
                durationLabel: shortDuration(trackDuration),
            });
        } else {
            player.data._cancelProgressPrewarm = null;
        }
        // ─────────────────────────────────────────────────────────────────────
                if (shouldResumeStuckTrack) {
                    applyStuckRecoveryResume();
                }

        // ── Pre-fetch: resolve next track while current one plays ─────────────
        // Poru's play() calls resolveTrack() when track.track is missing, adding
        // 100–500ms latency at every transition. We resolve the next track ~5s
        // early as a background task so it's ready the moment play() is called.
        {
            if (player.data._prefetchTimer) {
                clearTimeout(player.data._prefetchTimer);
                player.data._prefetchTimer = null;
            }
            const trackLen = Number(track.info?.length || 0);
            if (trackLen > 8_000 && player.queue.length > 0) {
                const prefetchDelay = Math.max(500, trackLen - 5_000);
                const prefetchTimer = setTimeout(() => {
                    player.data._prefetchTimer = null;
                    const nextTrack = player.queue[0];
                    if (!nextTrack || nextTrack.track || nextTrack._prefetched) return;
                    // Still playing the same track?
                    if (!player.currentTrack || trackIdentity(player.currentTrack) !== identity) return;
                    runBackground('prefetch-next-track', async () => {
                        try {
                            const resolved = await resolveTrackCached(player, nextTrack);
                            // Verify the track is still at the front of the queue
                            if (resolved?.track && player.queue[0] === nextTrack) {
                                player.queue[0].track = resolved.track;
                                player.queue[0]._prefetched = true;
                                if (process.env.DEBUG_PREFETCH)
                                    console.log(`[Prefetch] ✅ pre-resolved: ${nextTrack.info?.title}`);
                            }
                        } catch (err) {
                            if (process.env.DEBUG_PREFETCH)
                                console.warn(`[Prefetch] ⚠ failed for ${nextTrack.info?.title}: ${err?.message}`);
                        }
                    });
                }, prefetchDelay);
                prefetchTimer.unref?.();
                player.data._prefetchTimer = prefetchTimer;
            }
        }
        // ─────────────────────────────────────────────────────────────────────────

                const tokenObj2 = (store.get('tokens') || []).find(t => t.token === token);
                const requester = ensureTrackRequester(track, player, TrueMusic.user);
                await updatePlaybackVoiceStatus(TrueMusic, tokenObj2, player, track);
                        if (!requester) {
                            player.data.nowPlayingSendLock = null;
                            warnPlayerOnce(player, `np-no-requester:${identity || 'unknown'}`, `[NowPlaying] missing requester for ${identity || 'unknown'}`);
                            return;
                        }

                const channel = await resolveNowPlayingTextChannel(TrueMusic, player, tokenObj2);
                        if (!channel) {
                            player.data.nowPlayingSendLock = null;
                            warnPlayerOnce(player, `np-no-text:${identity || 'unknown'}`, `[NowPlaying] no usable text channel for ${identity || 'unknown'}`);
                            return;
                        }

                const selectedFilter = player.data.activeFilter || 'clear';
        const alreadyLiked = await likes.isLiked(requester.id, track).catch((err) => {
            console.error('[Likes] isLiked failed:', err?.message || err);
            return false;
        });

        player.data.ui = {
            requesterId: requester.id,
            artistTracks: [],
            selectedFilter,
            selectedArtistIndex: null,
            compactPlayLayout: true,
            liked: alreadyLiked,
        };

        const payload = buildNowPlayingV2Payload(TrueMusic, tokenObj2, player, { author: requester }, {
            track,
            requester,
            includeControls: true,
            liked: alreadyLiked,
            selectedFilter,
            compactPlayLayout: true,
            showProgressLabels: true,
            showInfoRow: false,
            useEmbedAccent: false,
            progressWidth: PLAY_PROGRESS_WIDTH,
        });

        const msg = await channel.send(payload).catch((err) => {
            console.warn(`[NowPlaying] failed to send panel for ${identity || 'unknown'}: ${err?.message || err}`);
            return null;
        });
        if (!msg) {
            player.data.nowPlayingSendLock = null;
            return;
        }

        player.data.nowPlayingMessage = msg;
        player.data.nowPlayingToken = track?.track || track?.info?.identifier || track?.info?.title || null;
        player.data.nowPlayingTrackIdentity = identity || null;
        player.data.nowPlayingSentAt = Date.now();
        player.data.nowPlayingContext = {
            client: TrueMusic,
            token,
            track,
            requester,
        };
        player.data.nowPlayingSendLock = null;

        clearProgressInterval(player);
        player.data.progressInterval = setInterval(async () => {
            if (!player.data.nowPlayingMessage || player.data.nowPlayingMessage.id !== msg.id) {
                clearProgressInterval(player, 'message changed or missing');
                return;
            }
            try {
                const currentIdentity = trackIdentity(player.currentTrack);
                if (!player.currentTrack || (identity && currentIdentity !== identity)) {
                    warnPlayerOnce(
                        player,
                        `stale-progress:${identity || msg.id}`,
                        `[ProgressUpdate] stopped stale updater for ${identity || 'unknown'}; current=${currentIdentity || 'none'}`,
                        10_000,
                    );
                    clearProgressInterval(player);
                    return;
                }
                        // ── A: cached tokenObj + liked — refresh every 30s ────────────
                        const _now3 = Date.now();
                        const _pc = player.data._progressCache || {};
                        let tokenObj3 = _pc.tokenObj;
                        let alreadyLiked3 = typeof _pc.liked === 'boolean' ? _pc.liked : false;
                        if (!tokenObj3 || _now3 - (_pc.refreshedAt || 0) >= 30_000) {
                            tokenObj3 = (store.get('tokens') || []).find(t => t.token === token);
                            alreadyLiked3 = await likes.isLiked(
                                player.currentTrack?.info?.requester?.id || '',
                                player.currentTrack || track,
                            ).catch(() => alreadyLiked3);
                            player.data._progressCache = { tokenObj: tokenObj3, liked: alreadyLiked3, refreshedAt: _now3 };
                        }
                        // ─────────────────────────────────────────────────────────────
                if (!tokenObj3) {
                    warnPlayerOnce(player, `missing-token:${token}`, `[ProgressUpdate] token config missing for ${token}`);
                    clearProgressInterval(player);
                    return;
                }
                        const ui3 = player.data.ui || {};
                        ui3.liked = alreadyLiked3;
                        player.data.ui = ui3;
                        const payload3 = buildNowPlayingV2Payload(TrueMusic, tokenObj3, player, { author: player.currentTrack?.info?.requester }, {
                            track: player.currentTrack || track,
                            requester: player.currentTrack?.info?.requester || requester,
                            includeControls: true,
                            liked: alreadyLiked3,
                            artistTracks: ui3.artistTracks || [],
                            selectedFilter: ui3.selectedFilter || player.data.activeFilter || 'clear',
                            selectedArtistIndex: ui3.selectedArtistIndex ?? null,
                            compactPlayLayout: ui3.compactPlayLayout === true,
                            showProgressLabels: true,
                            showInfoRow: false,
                                    useEmbedAccent: false,
                                    progressWidth: PLAY_PROGRESS_WIDTH,
                                });
                await safeEditMessage(msg, payload3).catch((err) => {
                    const code = err?.code ?? err?.status ?? 0;
                    if (code === 10008 || String(err?.message || '').includes('Unknown Message')) {
                        player.data.nowPlayingMessage = null;
                        clearProgressInterval(player, 'message deleted');
                        return;
                    }
                    warnPlayerOnce(player, `edit-failed:${msg.id}`, `[ProgressUpdate] edit failed for ${msg.id}: ${err?.message || err}`);
                });
            } catch (err) {
                console.error('[ProgressUpdate] failed:', err?.message || err);
            }
        }, 15000);

        const artistQuery = artistQueryForTrack(track);
        if (!artistQuery?.primary) return;

                try {
                    const source = displaySettings(tokenObj2).platform;
                    const artistTracks = await resolveArtistTracks(TrueMusic.poru, artistQuery, source || 'auto', track, 6, {
                        historySet: autoPlayHistorySet(player),
                    });
            player.data.ui.artistTracks = artistTracks;
            if (player.data.nowPlayingMessage?.id === msg.id && player.currentTrack === track) {
                const payload = buildNowPlayingV2Payload(TrueMusic, tokenObj2, player, { author: requester }, {
                    track,
                    requester,
                    includeControls: true,
                            liked: alreadyLiked,
                            artistTracks,
                            selectedFilter: player.data.ui.selectedFilter,
                            selectedArtistIndex: player.data.ui.selectedArtistIndex,
                            compactPlayLayout: true,
                            showProgressLabels: true,
                            showInfoRow: false,
                            useEmbedAccent: false,
                            progressWidth: PLAY_PROGRESS_WIDTH,
                        });
                await safeEditMessage(msg, payload).catch(() => {});
            }
        } catch (err) {
            console.error('[TopSongs] failed:', err?.message || err);
        }
    });



        const reactCustom = (msg, emojiData, fallback) => MUSIC_EMOJIS.react(msg, emojiData, fallback, TrueMusic);

        TrueMusic.on('messageCreate', async (message) => {
            if (message.author.bot || !message.guild) return;

            let tokenObj;
            {
                const parsedData = store.get('tokens') || [];
                if (!Array.isArray(parsedData) || parsedData.length === 0) {
                    return;
                }
                tokenObj = parsedData.find((tokenBot) => tokenBot.token === token);

                if (!tokenObj) {
                    console.warn('Warning: Token not found in tokens.json');
                    return;
                        }
                    }

                    const parseSubBotCommand = () => {
                        const raw = message.content.trim();
                        const botMention = `<@${TrueMusic.user.id}>`;
                        const botMentionBang = `<@!${TrueMusic.user.id}>`;
                        const botPrefix = tokenObj.prefix ?? "";
                        let body = null;

                        if (raw.startsWith(botMentionBang)) body = raw.slice(botMentionBang.length).trim();
                        else if (raw.startsWith(botMention)) body = raw.slice(botMention.length).trim();
                        else if (botPrefix && raw.toLowerCase().startsWith(botPrefix.toLowerCase())) body = raw.slice(botPrefix.length).trim();
                        else if (!botPrefix) body = raw;

                        if (!body) return null;
                        const parts = body.split(/ +/);
                        const name = (parts.shift() || '').toLowerCase();
                        return { name, args: parts };
                    };

                            const subBotCommand = parseSubBotCommand();
                            const rawPartsForUtility = message.content.trim().split(/ +/);
                            const rawUtilityName = (rawPartsForUtility.shift() || '').toLowerCase();
                            const voiceUtilityNames = ['help', 'مساعدة', 'اوامر', 'أوامر', 'info', 'botinfo', 'about', 'معلومات', 'معلومه', 'تفاصيل'];
                            const voiceUtilityCommand = subBotCommand && voiceUtilityNames.includes(subBotCommand.name)
                                ? subBotCommand
                                : voiceUtilityNames.includes(rawUtilityName)
                                    ? { name: rawUtilityName, args: rawPartsForUtility }
                                    : null;
                            if (voiceUtilityCommand) {
                                const utilityType = ['help', 'مساعدة', 'اوامر', 'أوامر'].includes(voiceUtilityCommand.name) ? 'help' : 'info';
                                if (!claimVoiceScopedUtility(message, utilityType)) return;
                                if (utilityType === 'help') return sendFullHelpPanel(message, tokenObj);
                                const embed = buildBotInfoEmbed(TrueMusic, tokenObj, message.guild.id);
                                return message.reply({ embeds: [embed], allowedMentions: { users: [TrueMusic.user.id], repliedUser: false } }).catch(() => {});
                            }
                            if (subBotCommand && ['set', 'settings', 'اعدادات', 'إعدادات'].includes(subBotCommand.name)) {
                                // Only ONE bot per subscription per message should handle settings.
                                // Use the message ID as a lock key stored in a module-level set.
                                if (!global._settingsHandledMsgIds) global._settingsHandledMsgIds = new Map();
                                const lockKey = `${message.id}:${tokenObj.code || token}`;
                                if (global._settingsHandledMsgIds.has(lockKey)) return;
                                global._settingsHandledMsgIds.set(lockKey, Date.now());
                                // Clean up after 10 seconds
                                setTimeout(() => global._settingsHandledMsgIds?.delete(lockKey), 10000);
                                const settingsCommand = require('./commands/Subscriptions/settings');
                                return settingsCommand.execute(TrueMusic, message, subBotCommand.args);
                            }
                                    const likesCommandNames = ['mylikes', 'likes', 'liked', 'لايكاتي'];
                                    const runMyLikesCommand = (args = []) => {
                                        // If this bot IS in a VC, the user must be in the same one.
                                        // If the bot is not in any VC yet, allow the command (view-only; play will check later).
                                        const botVoice    = message.guild.members?.me?.voice?.channel;
                                        const memberVoice = message.member?.voice?.channel;
                                        if (botVoice && (!memberVoice || memberVoice.id !== botVoice.id)) return null;

                                        // Must be in the allowed text channel (if one is configured)
                                        const allowedMyLikesChannels = new Set([tokenObj.chat, tokenObj.channel].filter(Boolean));
                                        if (allowedMyLikesChannels.size && !allowedMyLikesChannels.has(message.channel.id)) return null;

                                        const myLikesCommand = require('./commands/Control/mylikes');
                                        return myLikesCommand.execute(TrueMusic, message, args);
                                    };
                                    if (subBotCommand && likesCommandNames.includes(subBotCommand.name)) {
                                        return runMyLikesCommand(subBotCommand.args);
                                    }
                                    const rawNoPrefix = message.content.trim();
                                    const noPrefixName = rawNoPrefix.split(/ +/)[0]?.toLowerCase();
                                    if (likesCommandNames.includes(noPrefixName)) {
                                        const myLikesArgs = rawNoPrefix.split(/ +/).slice(1);
                                        return runMyLikesCommand(myLikesArgs);
                                    }

                                            let memberVoice = message.member?.voice?.channel;
                                    if (!memberVoice) return;

                    let clientVoice = message.guild.members?.me?.voice?.channel;

            const prefix = tokenObj.prefix || "";

            if (tokenObj.chat) {
                const allowedTextChannels = new Set([tokenObj.chat, tokenObj.channel].filter(Boolean));
                if (!allowedTextChannels.has(message.channel.id)) return;
            }

                    if (!message.content.startsWith(prefix)) return;

            const args = message.content.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();

                    let cmdsArray = {
                play: [`شغل`, `ش`, `p`, `play`, `P`, `Play`],
                stop: [`stop`, `وقف`, `Stop`, `توقيف`],
                skip: [`skip`, `سكب`, `تخطي`, `s`, `س`, `S`, `Skip`],
                volume: [`volume`, `vol`, `صوت`, `v`, `ص`, `V`, `Vol`, `Volume`],
                nowplaying: [`nowplaying`, `np`, `Np`, `Nowplaying`, `الشغال`, `الان`],
                loop: [`loop`, `تكرار`, `l`, `L`, `Loop`],
                pause: [`pause`, `توقيف`, `كمل`, `pa`, `Pa`, `Pause`, `resume`],
                seek: [`seek`, `Seek`, `قدم`, `se`, `Se`],
                forward: [`forward`, `Forward`, `fwd`, `fw`, `تقديم`],
                remove: [`remove`, `Remove`, `rm`, `حذف`],
                autoplay: [`autoplay`, `Autoplay`, `Ap`, `ap`],
                search: [`search`, `ys`, `بحث`],
                        queue: [`queue`, `قائمة`, `اغاني`, `q`, `qu`, `Q`, `Qu`, `Queue`],

                    };

                    const isPlayCommand = cmdsArray.play.includes(command);
                    const canWakeForPlay = isPlayCommand
                        && !clientVoice
                        && (!tokenObj.channel || tokenObj.channel === memberVoice.id);
                    if ((!clientVoice || memberVoice.id !== clientVoice.id) && !canWakeForPlay) return;

                    if (isPlayCommand) {
                const song = args.join(' ');
                        if (!song) {
                            return message.channel.send(musicPayload(tokenObj, {
                                title: 'Play Command',
                        description:
                            '>`play [Song]` : Play the first search result\n' +
                            '>`play [URL]` : Play from YouTube, SoundCloud, Spotify, Apple Music, or Deezer',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                            }));
                        }

                        if (isMemberDeafened(message.member)) {
                            return message.reply(deafenedPlaybackPayload(tokenObj));
                        }

                                clearStopped();
                                message.channel.sendTyping().catch(() => {});

                                let player = await getPlayablePlayer(
                                    message.guild,
                                    message.member.voice.channel.id,
                                    message.channel.id,
                                    tokenObj,
                                    'message_play',
                                );
                                if (!player) {
                                    return message.reply(musicPayload(tokenObj, {
                                        title: 'Voice Not Ready',
                                        description: '*The music node is reconnecting. Try again in a moment.*',
                                        thumbnail: 'attachment://Error.png',
                                        files: ['./assets/image/icons/Error.png'],
                                    }));
                                }

                        try {
                                    const searchSource = displaySettings(tokenObj).platform;
                            let res = await resolveWithNodeRetry(TrueMusic, {
                                query: song,
                                ...(isProbablyUrl(song) ? {} : { source: searchSource }),
                            }, 1);
                            if ((!res || !res.tracks || res.tracks.length === 0) && !isProbablyUrl(song)) {
                                const fallbackTracks = await resolveSmartTracks(TrueMusic.poru, song, 'auto', 10);
                                if (fallbackTracks.length) res = { loadType: 'search', tracks: fallbackTracks };
                            }

                            if (!res || !res.tracks || res.tracks.length === 0) {
                                return message.reply(musicPayload(tokenObj, {
                            title: 'No Results',
                            description: `**No results found for __${song}__**.`,
                            color: '#ff0000',
                            thumbnail: 'attachment://Error.png',
                            files: ['./assets/image/icons/Error.png'],
                        }));
                    }

                    if (res.loadType === 'playlist') {
                        message.reply(musicPayload(tokenObj, {
                            title: 'Playing Playlist',
                            description: `**[${res.playlistInfo.name}](${res.playlistInfo.url || res.tracks[0].info.uri})**`,
                            fields: [{ name: 'Playlist Tracks', value: `**${res.tracks.length}**`, inline: true }],
                            thumbnail: 'attachment://NowPlaying.png',
                            files: ['./assets/image/icons/NowPlaying.png'],
                        }));

                                for (const track of res.tracks) {
                                    track.info.requester = message.author;
                                    player.queue.add(track);
                                }
                                runBackground('playlist queue bump', () => bumpQueueVersion(player, 'playlist_add'));
                            } else {
                                const track = res.tracks[0];
                                track.info.requester = message.author;
                                player.queue.add(track);

                                if (player.isPlaying) {
                                    // bump queue + Discord reply start at the same instant
                                    await Promise.all([
                                        bumpQueueVersion(player, 'track_add'),
                                        message.reply(musicPayload(tokenObj, {
                                            title: 'Add Song',
                                            description: `**[${track.info.title}](${track.info.uri})**`,
                                            fields: [{ name: 'Song Duration', value: `**${shortDuration(track.info.length)}**`, inline: true }],
                                            thumbnail: 'attachment://AddSong.png',
                                            files: ['./assets/image/icons/AddSong.png'],
                                        })),
                                    ]);
                                    return;
                                }
                                await bumpQueueVersion(player, 'track_add');
                            }

                                    await safePlay(player);

                } catch (error) {
                    console.error('Error searching for song:', error.message);
                    message.reply(musicPayload(tokenObj, {
                        title: 'Search Error',
                        description: '*An error occurred while searching for the song*.',
                                thumbnail: 'attachment://Error.png',
                                files: ['./assets/image/icons/Error.png'],
                    }));
                }
            }
            else if (cmdsArray.stop.includes(command)) {
                let player = TrueMusic.poru.players.get(message.guild.id);

                if (!player) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing.*',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                                const stoppedTrack = player.currentTrack;
                                const finalOptions = finalUiOptionsFor(player, stoppedTrack);
                                markStopped();
                                player.setLoop('NONE');
                                player.queue.clear();
                                setAutoPlayState(player, false);
                                clearStoppedPlaybackCaches(player);
                                clearProgressInterval(player, 'message stop');
                                // Fire both without waiting — Lavalink stop + reaction run immediately
                                stopPlayerAudio(player, { wait: false });
                                reactCustom(message, MUSIC_EMOJIS.stop, '🔴');
                                runBackground('stop cleanup', async () => {
                                    await finalizePlayerUi(player, finalOptions);
                                    await bumpQueueVersion(player, 'stop');
                                    await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                                });
            }


            if (cmdsArray.nowplaying.includes(command)) {

                let player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing*.',
                    }));
                }

                let memberVoice = message.member?.voice?.channel;
                let clientVoice = message.guild.members?.me?.voice?.channel;
                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                try {
                    const requester = player.currentTrack.info?.requester || message.author;
                    return await message.channel.send(buildNowPlayingV2Payload(TrueMusic, tokenObj, player, message, {
                        track: player.currentTrack,
                        requester,
                        includeControls: false,
                        compactPlayLayout: true,
                        useEmbedAccent: true,
                        showInfoRow: true,
                        infoVolume: true,
                        infoLoop: true,
                    }));
                } catch (error) {
                    console.warn(`[NowPlayingV2] failed, using fallback: ${error?.message || error}`);
                    return message.channel.send(buildNowPlayingFallbackPayload(
                        tokenObj,
                        player,
                        player.currentTrack.info?.requester || message.author,
                    ));
                }
            }
            else if (cmdsArray.loop.includes(command)) {
                let player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.isPlaying) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing.*',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                const currentLoop = player.loop;
                const newLoopMode = currentLoop === "NONE" ? "TRACK" : "NONE";
                player.setLoop(newLoopMode);

                return message.reply(musicPayload(tokenObj, {
                    title: 'Loop',
                    description: `**Loop mode is now ${newLoopMode === "TRACK" ? 'ON' : 'OFF'}**.`,
                    thumbnail: `attachment://${newLoopMode === "TRACK" ? 'LoopON.png' : 'LoopOFF.png'}`,
                    files: [`./assets/image/icons/${newLoopMode === "TRACK" ? 'LoopON.png' : 'LoopOFF.png'}`],
                }));
            }

            if (cmdsArray.pause.includes(command)) {
                const player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing*.',
                    }));
                }

                const memberVoice = message.member.voice?.channel;
                const clientVoice = message.guild.members.me.voice?.channel;

                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                if (player.isPaused) {
                    await Promise.all([
                        pausePlayerSynced(player, false).catch(err => console.warn('[message resume]', err?.message || err)),
                        reactCustom(message, MUSIC_EMOJIS.skip, '▶️'),
                    ]);
                } else {
                    await Promise.all([
                        pausePlayerSynced(player, true).catch(err => console.warn('[message pause]', err?.message || err)),
                        reactCustom(message, MUSIC_EMOJIS.pause, '⏸️'),
                    ]);
                }
            }


            else if (cmdsArray.queue.includes(command)) {
                const memberVoiceChannel = message.member?.voice?.channel;
                const botVoiceChannel = message.guild.members?.me?.voice?.channel;

                if (!memberVoiceChannel || !botVoiceChannel || memberVoiceChannel.id !== botVoiceChannel.id) return;

                const player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.queue || player.queue.length === 0) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Queue',
                        description: '*No songs are currently in the queue*.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                        const currentTrackForRender = () => player.currentTrack;
                        if (!currentTrackForRender()) {
                            return message.reply(musicPayload(tokenObj, {
                                title: 'Queue',
                                description: '*No song is currently playing.*',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                const itemsPerPage = 8;
                let page = 0;

                        const getThumb = () => trackArtworkUrl(player.currentTrack, TrueMusic);

                        const queueMessage = await message.reply(musicPayload(tokenObj, {
                            title: queueTitle(message.guild.name, TrueMusic),
                            description: buildQueueDescription(player, page, itemsPerPage),
                            components: buildQueueComponents(player, tokenObj, message.id, page, itemsPerPage),
                            thumbnail: 'attachment://Queue.png',
                            files: ['./assets/image/icons/Queue.png'],
                            footer: buildQueueFooter(player, page, itemsPerPage),
                        })).catch(console.error);

                        if (!queueMessage || !displaySettings(tokenObj).buttons) return;
                        let queueVersion = ensurePlayerData(player).queueVersion;
                        registerQueuePanel(player, queueMessage, queueVersion);

                        const filter = interaction => interaction.user.id === message.author.id && interaction.customId.startsWith(`queue_${message.id}_`);
                        const collector = queueMessage.createMessageComponentCollector({ filter, time: 120000 });

                        const renderQueue = (interaction, title = queueTitle(message.guild.name, TrueMusic)) => interaction.update(musicPayload(tokenObj, {
                            title,
                            description: buildQueueDescription(player, page, itemsPerPage),
                            components: buildQueueComponents(player, tokenObj, message.id, page, itemsPerPage),
                            thumbnail: 'attachment://Queue.png',
                            files: ['./assets/image/icons/Queue.png'],
                            footer: buildQueueFooter(player, page, itemsPerPage),
                        }));

                        collector.on('collect', async interaction => {
                            if ((player.data?.queueVersion || 0) !== queueVersion) {
                                collector.stop('stale');
                                return interaction.update({ components: disableComponents(queueMessage.components) }).catch(() => {});
                            }

                            if (interaction.customId === `queue_${message.id}_prev`) {
                                if (page > 0) page--;
                                return renderQueue(interaction);
                            }

                            if (interaction.customId === `queue_${message.id}_next`) {
                                const totalPages = Math.max(1, Math.ceil(player.queue.length / itemsPerPage));
                                if (page < totalPages - 1) page++;
                                return renderQueue(interaction);
                            }

                            if (interaction.customId === `queue_${message.id}_clear`) {
                                player.queue.clear();
                                runBackground('queue clear bump', () => bumpQueueVersion(player, 'queue_clear'));
                                collector.stop('cleared');
                                return interaction.update(musicPayload(tokenObj, {
                                    title: 'Queue Cleared',
                                    description: '**تم حذف قائمة الانتظار بالكامل.**',
                                    thumbnail: 'attachment://Queue.png',
                                    files: ['./assets/image/icons/Queue.png'],
                                }));
                            }

                            if (interaction.customId === `queue_${message.id}_close`) {
                                collector.stop('closed');
                                return interaction.update({ components: disableComponents(queueMessage.components) });
                            }

                            if (interaction.customId === `queue_${message.id}_reorder`) {
                                if (typeof player.queue.splice !== 'function' || typeof player.queue.unshift !== 'function') {
                                    return interaction.reply({ content: 'تعذر ترتيب الطابور في هذا الإصدار.', flags: MessageFlags.Ephemeral });
                                }
                                const indexes = [...new Set(interaction.values.map(Number))]
                                    .filter(index => index >= 0 && index < player.queue.length);
                                const selectedTracks = indexes.map(index => player.queue[index]).filter(Boolean);
                                indexes.sort((a, b) => b - a).forEach(index => player.queue.splice(index, 1));
                                for (let i = selectedTracks.length - 1; i >= 0; i--) player.queue.unshift(selectedTracks[i]);
                                page = 0;
                                queueVersion = await bumpQueueVersion(player, 'queue_reorder', queueMessage.id);
                                registerQueuePanel(player, queueMessage, queueVersion);
                                return renderQueue(interaction, 'Queue Updated');
                            }
                        });

                        collector.on('end', (_, reason) => {
                            player.data?.queuePanels?.delete(queueMessage.id);
                            if (!['closed', 'cleared'].includes(reason)) {
                                queueMessage.edit({ components: disableComponents(queueMessage.components) }).catch(() => {});
                            }
                        });
            } else if (cmdsArray.skip.includes(command)) {
                let player = TrueMusic.poru.players.get(message.guild.id);

                if (!player || (!player.isPlaying && !player.isPaused)) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing*.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                let memberVoice = message.member?.voice?.channel;
                let clientVoice = message.guild.members?.me?.voice?.channel;

                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                const currentTrack = player.currentTrack;

                        if (player.queue.length === 0 && player.data?.autoPlay) {
                            const skippedTrack = currentTrack;
                            // Lavalink + Discord reply start at the same instant
                            await Promise.all([
                                skipPlayerSynced(TrueMusic.poru, player, currentTrack),
                                message.reply(musicPayload(tokenObj, {
                                    title: 'Skipped',
                                    description: `**${skippedTrack.info.title}\nBy : ${message.author.displayName}**`,
                                    thumbnail: 'attachment://Skip.png',
                                    files: ['./assets/image/icons/Skip.png'],
                                })),
                            ]);
                            return;
                        }

                        if (player.queue.length === 0) {
                            const finalOptions = finalUiOptionsFor(player, currentTrack);
                            const skippedTrack = currentTrack;
                            markStopped();
                            setAutoPlayState(player, false);
                            clearStoppedPlaybackCaches(player);
                            clearProgressInterval(player, 'message skip end');
                            // Lavalink + Discord reply start at the same instant
                            await Promise.all([
                                stopPlayerAudio(player, { wait: false }),
                                message.reply(musicPayload(tokenObj, {
                                    title: 'Skipped',
                                    description: `**${skippedTrack.info.title}\nBy : ${message.author.displayName}**`,
                                    thumbnail: 'attachment://Skip.png',
                                    files: ['./assets/image/icons/Skip.png'],
                                })),
                            ]);
                            runBackground('skip end cleanup', async () => {
                                await finalizePlayerUi(player, finalOptions);
                                await bumpQueueVersion(player, 'skip_end');
                                await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                            });
                            return;
                        } else {
                            const skippedTrack = currentTrack;
                            // Lavalink + Discord reply start at the same instant
                            await Promise.all([
                                skipPlayerSynced(TrueMusic.poru, player, currentTrack),
                                message.reply(musicPayload(tokenObj, {
                                    title: 'Skipped',
                                    description: `**${skippedTrack.info.title}\nBy : ${message.author.displayName}**`,
                                    thumbnail: 'attachment://Skip.png',
                                    files: ['./assets/image/icons/Skip.png'],
                                })),
                            ]);
                            runBackground('skip cleanup', () => bumpQueueVersion(player, 'skip'));
                            return;
                        }
            }



            else if (cmdsArray.volume.includes(command)) {
                let player = TrueMusic.poru.players.get(message.guild.id);

                if (!player || !player.isPlaying) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing.*',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                let member_voice = message.member?.voice?.channel;
                let client_voice = message.guild.members?.me?.voice?.channel;

                if (!member_voice || !client_voice || member_voice.id !== client_voice.id) return;

                const args = message.content.split(' ');
                const volume = parseInt(args[1]);
                const currentVolume = player.volume || 100;

                if (isNaN(volume)) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Volume',
                        description: `**Current volume is \`${currentVolume}%\`.**`,
                        thumbnail: 'attachment://VolumeInfo.png',
                        files: ['./assets/image/icons/VolumeInfo.png'],
                    }));
                }

                if (volume < 0 || volume > 1000) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Volume',
                        description: '**Please provide a valid volume level between 0% and 1000%**.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                setPlayerVolumeSynced(player, volume).catch(err => console.warn('[message volume]', err?.message || err));

                return message.reply(musicPayload(tokenObj, {
                    title: 'Volume',
                    description: `**Volume changed from __${currentVolume}%__ to __${volume}%__.**`,
                    thumbnail: `attachment://${volume < currentVolume ? 'Volumedowwn' : 'Volumeup'}.png`,
                    files: [`./assets/image/icons/${volume < currentVolume ? 'Volumedowwn' : 'Volumeup'}.png`],
                }));
            } else if (cmdsArray.seek.includes(command)) {
                const player = TrueMusic.poru.players.get(message.guild.id);

                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing*.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                const memberVoice = message.member?.voice?.channel;
                const clientVoice = message.guild.members?.me?.voice?.channel;

                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                const args = message.content.split(" ");
                const timeArg = args[1];

                if (!timeArg) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Seek',
                        description: '**Please provide a seek duration like** `1:11`, `90s`, or `2m`.',
                        thumbnail: 'attachment://seek.png',
                        files: ['./assets/image/icons/seek.png'],
                    }));
                }

                let seconds = 0;
                if (timeArg.includes(":")) {
                    const [min, sec] = timeArg.split(":").map(Number);
                    seconds = (min * 60) + sec;
                } else if (timeArg.endsWith("s")) {
                    seconds = parseInt(timeArg);
                } else if (timeArg.endsWith("m")) {
                    seconds = parseInt(timeArg) * 60;
                } else {
                    seconds = parseInt(timeArg);
                }

                if (isNaN(seconds)) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Seek',
                        description: '*Invalid time format. Use something like 1:30 or 90s*.',
                        thumbnail: 'attachment://seek.png',
                        files: ['./assets/image/icons/seek.png'],
                    }));
                }

                const seekTime = Math.min(seconds * 1000, player.currentTrack.info.length);
                await Promise.all([
                    player.seekTo(seekTime).catch(err => console.warn('[message seek]', err?.message || err)),
                    reactCustom(message, MUSIC_EMOJIS.skip, '✅'),
                ]);
            }

            else if (cmdsArray.forward.includes(command)) {
                const player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing.*',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }
                const memberVoice = message.member?.voice?.channel;
                const clientVoice = message.guild.members?.me?.voice?.channel;
                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                const timeArg = args[0];
                if (!timeArg) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Forward',
                        description: '**Provide a time to skip forward.\nExamples : forward 30s • forward 1m • forward 1:30**',
                        thumbnail: 'attachment://seek.png',
                        files: ['./assets/image/icons/seek.png'],
                    }));
                }

                let seconds = 0;
                if (timeArg.includes(':')) {
                    const [min, sec] = timeArg.split(':').map(Number);
                    seconds = (min * 60) + sec;
                } else if (timeArg.endsWith('s')) {
                    seconds = parseInt(timeArg);
                } else if (timeArg.endsWith('m')) {
                    seconds = parseInt(timeArg) * 60;
                } else {
                    seconds = parseInt(timeArg);
                }

                if (isNaN(seconds) || seconds <= 0) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Forward',
                        description: '**Invalid time. Use something like 30s, 1m, or 1:30**.',
                        thumbnail: 'attachment://seek.png',
                        files: ['./assets/image/icons/seek.png'],
                    }));
                }

                const currentPosition = Number(player.position || 0);
                const newPosition = Math.min(currentPosition + seconds * 1000, player.currentTrack.info.length - 1000);
                await Promise.all([
                    player.seekTo(newPosition).catch(err => console.warn('[message forward]', err?.message || err)),
                    reactCustom(message, MUSIC_EMOJIS.skip, '⏩'),
                ]);
            }

            else if (cmdsArray.remove.includes(command)) {
                const player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing.*',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }
                const memberVoice = message.member?.voice?.channel;
                const clientVoice = message.guild.members?.me?.voice?.channel;
                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                const pos = parseInt(args[0]);
                if (isNaN(pos) || pos < 1 || pos > player.queue.length) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Remove',
                        description: player.queue.length === 0
                            ? '*The queue is empty.*'
                            : `**Provide a position between 1 and ${player.queue.length}**.`,
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                const removed = player.queue[pos - 1];
                player.queue.splice(pos - 1, 1);
                await Promise.all([
                    bumpQueueVersion(player, 'remove'),
                    message.reply(musicPayload(tokenObj, {
                        title: 'Removed',
                        description: `**Removed ${removed?.info?.title || 'Unknown'} from the queue**.`,
                        thumbnail: 'attachment://Skip.png',
                        files: ['./assets/image/icons/Skip.png'],
                    })),
                ]);
                return;
            }

            else if (cmdsArray.search.includes(command)) {
                const rawSearchQuery = args.join(' ').replace(/\s+/g, ' ').trim();
                const searchQuery = rawSearchQuery.split(' ').slice(0, 2).join(' ');
                const searchQueryNote = rawSearchQuery && rawSearchQuery !== searchQuery
                    ? `\n> تم استخدام أول كلمتين فقط: **${searchQuery}**`
                    : '';
                const smartSearchThumbnail = {
                    thumbnail: 'attachment://AutoPlayON.png',
                    files: ['./assets/image/icons/AutoPlayON.png'],
                };
                const searchExpiredThumbnail = {
                    thumbnail: TrueMusic.user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null,
                };
                if (!rawSearchQuery) {
                    return message.channel.send(musicPayload(tokenObj, {
                        title: 'Search',
                        description: '*Please write the name of the song*.',
                        ...smartSearchThumbnail,
                    }));
                }

                if (!displaySettings(tokenObj).buttons) {
                    return message.channel.send(musicPayload(tokenObj, {
                        title: 'Search',
                        description: '*Search menus are disabled for this subscription. Use `play <song>` or enable buttons from settings.*',
                        ...smartSearchThumbnail,
                    }));
                }

                const searchId = `search_${message.id}`;
                let currentTracks = [];
                let allSearchTracks = [];
                let selectedSource = null;
                let searchOffset = 0;
                let completed = false;

                        const platformOptions = [
                            { label: 'Smart Search', value: 'auto', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.smartSearch), description: 'All Source' },
                            { label: 'YouTube', value: 'ytsearch', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms.ytsearch) },
                            { label: 'YouTube Music', value: 'ytmsearch', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms.ytmsearch) },
                    { label: 'SoundCloud', value: 'scsearch', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms.scsearch) },
                    { label: 'Spotify', value: 'spsearch', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms.spsearch) },
                    { label: 'Apple Music', value: 'amsearch', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms.amsearch) },
                    { label: 'Deezer', value: 'dzsearch', emoji: MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms.dzsearch) },
                ];

                const advancedSearchSources = ['ytmsearch', 'ytsearch', 'scsearch', 'spsearch', 'amsearch', 'dzsearch'];
                const sourceEmoji = (source) => {
                    const key = String(source || '').toLowerCase();
                    const data = MUSIC_EMOJIS.platforms[key];
                    return data ? MUSIC_EMOJIS.messageEmoji(data, TrueMusic, '') : '';
                };
                const sourceKeyFromTrack = (track) => {
                    const source = String(track?.info?.sourceName || '').toLowerCase();
                    if (source.includes('youtube')) return 'ytsearch';
                    if (source.includes('soundcloud')) return 'scsearch';
                    if (source.includes('spotify')) return 'spsearch';
                    if (source.includes('apple')) return 'amsearch';
                    if (source.includes('deezer')) return 'dzsearch';
                    return selectedSource && selectedSource !== 'auto' ? selectedSource : '';
                };
                const buildSearchProgress = (counts, activeSource = null) => {
                    const lines = advancedSearchSources.map(source => {
                        const found = counts[source];
                        const prefix = activeSource === source ? '⏳' : found == null ? '▫️' : '✅';
                        return `${prefix} ${sourceEmoji(source)} **${platformDisplay(source, TrueMusic)}** : \`${found ?? 0}\``;
                    });
                    const total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
                    return [
                        `**يتم البحث عن:** ${searchQuery}${searchQueryNote}`,
                        `**إجمالي النتائج المحصلة:** \`${total}\``,
                        '',
                        ...lines,
                    ].join('\n');
                };

                const resolveSearchTracks = async (source) => {
                    if (source !== 'auto') {
                        return resolveSmartTracks(TrueMusic.poru, searchQuery, source, 60, {
                            strict: false,
                            variants: [searchQuery, `${searchQuery} official audio`],
                            prefetchMultiplier: 4,
                            perResolveLimit: 10,
                        });
                    }

                    const counts = {};
                    const merged = [];
                    for (const searchSource of advancedSearchSources) {
                        await sourceMessage.edit(musicPayload(tokenObj, {
                            title: 'Advanced Search',
                            description: buildSearchProgress(counts, searchSource),
                            ...smartSearchThumbnail,
                        })).catch(() => {});

                        const tracks = await resolveSmartTracks(TrueMusic.poru, searchQuery, searchSource, 14, {
                            strict: false,
                            variants: [searchQuery],
                            prefetchMultiplier: 3,
                            perResolveLimit: 10,
                        }).catch(() => []);
                        counts[searchSource] = tracks.length;
                        merged.push(...tracks);

                        await sourceMessage.edit(musicPayload(tokenObj, {
                            title: 'Advanced Search',
                            description: buildSearchProgress(counts),
                            ...smartSearchThumbnail,
                        })).catch(() => {});
                    }

                    return rankTracksForQuery(dedupeTracks(merged), searchQuery, { strict: false }).slice(0, 60);
                };

                const controlRow = (showBack = false, showContinue = false) => {
                    const row = new ActionRowBuilder();
                    if (showBack) {
                        row.addComponents(
                            new ButtonBuilder()
                                .setCustomId(`${searchId}_back`)
                                .setLabel('Back')
                                .setEmoji(MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.pagePrev))
                                .setStyle(ButtonStyle.Secondary)
                        );
                    }
                    if (showContinue) {
                        row.addComponents(
                            new ButtonBuilder()
                                .setCustomId(`${searchId}_continue`)
                                .setLabel('Continue Search')
                                .setStyle(ButtonStyle.Primary)
                        );
                    }
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`${searchId}_cancel`)
                            .setLabel('Cancel')
                            .setStyle(ButtonStyle.Danger)
                    );
                    return row;
                };

                const buildPlatformRows = () => [
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                                    .setCustomId(`${searchId}_source`)
                                    .setPlaceholder('Choose search method')
                                    .addOptions(platformOptions)
                            ),
                    controlRow(false),
                ];

                const hasMoreSearchResults = () => searchOffset + currentTracks.length < allSearchTracks.length;

                const buildTrackRows = (tracks) => {
                    return [
                        new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId(`${searchId}_song`)
                                .setPlaceholder('Choose a track')
                                .addOptions(tracks.map((track, index) => {
                                    const platformKey = sourceKeyFromTrack(track);
                                    const platformEmoji = platformKey && MUSIC_EMOJIS.platforms[platformKey]
                                        ? MUSIC_EMOJIS.componentEmoji(MUSIC_EMOJIS.platforms[platformKey])
                                        : undefined;
                                    const sourceLabel = platformKey ? platformDisplay(platformKey, TrueMusic).replace(/<a?:\w+:\d+>/g, '').trim() : 'Source';
                                    return {
                                        label: (track.info.title || 'Unknown').slice(0, 99),
                                        value: String(index),
                                        description: `${sourceLabel} • ${shortDuration(track.info.length)} - ${(track.info.author || 'Unknown').slice(0, 42)}`.slice(0, 99),
                                        ...(platformEmoji ? { emoji: platformEmoji } : {}),
                                    };
                                }))
                        ),
                        controlRow(true, hasMoreSearchResults()),
                    ];
                };

                const sourceMessage = await message.channel.send(musicPayload(tokenObj, {
                    title: 'Search',
                    description: `**البحث عن : ${searchQuery}\nاختر المنصة التي تريد البحث فيها.**${searchQueryNote}`,
                    components: buildPlatformRows(),
                    ...smartSearchThumbnail,
                }));

                const collector = sourceMessage.createMessageComponentCollector({
                    filter: i => i.user.id === message.author.id && i.customId.startsWith(searchId),
                    time: 120000,
                });

                collector.on('collect', async interaction => {
                    if (interaction.customId === `${searchId}_cancel`) {
                        completed = true;
                        collector.stop('cancel');
                        return interaction.update(musicPayload(tokenObj, {
                            title: 'Search Cancelled',
                            description: '*تم إلغاء البحث*.',
                            ...smartSearchThumbnail,
                        }));
                    }

                    if (interaction.customId === `${searchId}_back`) {
                        currentTracks = [];
                        allSearchTracks = [];
                        selectedSource = null;
                        searchOffset = 0;
                        return interaction.update(musicPayload(tokenObj, {
                            title: 'Search',
                            description: `*البحث عن : ${searchQuery}\nاختر المنصة التي تريد البحث فيها*.${searchQueryNote}`,
                            components: buildPlatformRows(),
                            ...smartSearchThumbnail,
                        }));
                    }

                            if (interaction.customId === `${searchId}_source`) {
                                selectedSource = interaction.values[0];
                                searchOffset = 0;
                                await interaction.update(musicPayload(tokenObj, {
                                    title: selectedSource === 'auto' ? 'Advanced Search' : 'Searching',
                                    description: selectedSource === 'auto'
                                        ? buildSearchProgress({})
                                        : `**يتم البحث في : ${platformDisplay(selectedSource, TrueMusic)} عن ${searchQuery}**...${searchQueryNote}`,
                                    ...smartSearchThumbnail,
                                }));

                                try {
                                    allSearchTracks = await resolveSearchTracks(selectedSource);
                                    if (completed) return;
                                    currentTracks = allSearchTracks.slice(searchOffset, searchOffset + 10);

                                    if (currentTracks.length === 0) {
                                return sourceMessage.edit(musicPayload(tokenObj, {
                                    title: 'No Results',
                                    description: `*لم يتم العثور على نتائج في ${platformDisplay(selectedSource, TrueMusic)}.*${searchQueryNote}`,
                                    components: [controlRow(true)],
                                    ...smartSearchThumbnail,
                                }));
                            }

                                    return sourceMessage.edit(musicPayload(tokenObj, {
                                        title: 'Search Results',
                                        description: `**النتائج من ${platformDisplay(selectedSource, TrueMusic)}: \`${allSearchTracks.length}\`\nاختر أغنية من القائمة**.${searchQueryNote}`,
                                        components: buildTrackRows(currentTracks),
                                        ...smartSearchThumbnail,
                                    }));
                        } catch (err) {
                            console.error('Error searching for videos:', err);
                            return sourceMessage.edit(musicPayload(tokenObj, {
                                title: 'Search Error',
                                description: '**حدث خطأ أثناء البحث. يمكنك الرجوع واختيار منصة أخرى.**',
                                components: [controlRow(true)],
                                ...smartSearchThumbnail,
                            }));
                        }
                    }

                    if (interaction.customId === `${searchId}_continue`) {
                        if (!selectedSource) {
                            return interaction.update(musicPayload(tokenObj, {
                                title: 'Search',
                                description: '*اختر منصة البحث أولاً*.',
                                components: buildPlatformRows(),
                                ...smartSearchThumbnail,
                            }));
                        }

                        const nextOffset = searchOffset + 10;
                        if (nextOffset >= allSearchTracks.length) {
                            return interaction.update(musicPayload(tokenObj, {
                                title: 'Search Results',
                                description: `**لا توجد نتائج إضافية من ${platformDisplay(selectedSource, TrueMusic)} لهذا البحث.\nإجمالي النتائج: \`${allSearchTracks.length}\`**${searchQueryNote}`,
                                components: buildTrackRows(currentTracks),
                                ...smartSearchThumbnail,
                            }));
                        }

                        searchOffset = nextOffset;
                        currentTracks = allSearchTracks.slice(searchOffset, searchOffset + 10);
                        return interaction.update(musicPayload(tokenObj, {
                            title: 'Search Results',
                            description: `**نتائج إضافية من ${platformDisplay(selectedSource, TrueMusic)} • \`${searchOffset + 1}-${Math.min(searchOffset + currentTracks.length, allSearchTracks.length)}\` من \`${allSearchTracks.length}\`.\nتم استبدال القائمة السابقة.**${searchQueryNote}`,
                            components: buildTrackRows(currentTracks),
                            ...smartSearchThumbnail,
                        }));
                    }

                    if (interaction.customId === `${searchId}_song`) {
                        await interaction.deferUpdate().catch(() => {});
                        if (isMemberDeafened(message.member)) {
                            return sourceMessage.edit(deafenedPlaybackPayload(tokenObj));
                        }
                        const selectedIndex = parseInt(interaction.values[0], 10);
                        const selectedTrack = currentTracks[selectedIndex];
                        if (!selectedTrack) {
                            return sourceMessage.edit(musicPayload(tokenObj, {
                                title: 'Search',
                                description: '*لم يعد هذا الاختيار متاحاً. ارجع واختر نتيجة أخرى.*',
                                components: [controlRow(true)],
                                ...smartSearchThumbnail,
                            }));
                        }

                                clearStopped();
                                let player = await getPlayablePlayer(
                                    message.guild,
                                    message.member.voice.channel.id,
                                    message.channel.id,
                                    tokenObj,
                                    'search_select',
                                );
                                if (!player) {
                                    return sourceMessage.edit(musicPayload(tokenObj, {
                                        title: 'Voice Not Ready',
                                        description: '*The music node is reconnecting. Try again in a moment.*',
                                        ...smartSearchThumbnail,
                                    }));
                                }

                                const queuedTrack = { ...selectedTrack, info: { ...selectedTrack.info, requester: message.author } };
                                player.queue.add(queuedTrack);

                                completed = true;
                        collector.stop('selected');

                                // bump queue version + update search message at the same instant
                                await Promise.all([
                                    bumpQueueVersion(player, 'search_add'),
                                    sourceMessage.edit(musicPayload(tokenObj, {
                                        title: player.isPlaying ? 'Add Song' : 'Playing',
                                        description: `**Song :** ${queuedTrack.info.title}\n**Source :** ${platformDisplay(sourceKeyFromTrack(queuedTrack) || selectedSource, TrueMusic)}\n**Added by :** ${message.author.displayName}`,
                                        ...smartSearchThumbnail,
                                    })),
                                ]);

                                await safePlay(player);
                            }
                });

                collector.on('end', (_, reason) => {
                    if (!completed && reason === 'time') {
                        sourceMessage.edit(musicPayload(tokenObj, {
                            title: 'Search Expired',
                            description: '*انتهى وقت البحث بدون اختيار.*',
                            ...searchExpiredThumbnail,
                        })).catch(() => {});
                    }
                });
            } else if (cmdsArray.autoplay.includes(command)) {
                let player = TrueMusic.poru.players.get(message.guild.id);

                if (!player) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: '*No music is currently playing.*',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }



                setAutoPlayState(player, !player.data.autoPlay);




                const autoPlayImg = player.data.autoPlay ? 'AutoPlayON.png' : 'AutoPlayOFF.png';
                return message.reply(musicPayload(tokenObj, {
                    title: 'Autoplay',
                    description: `**Autoplay is now ${player.data.autoPlay ? 'ON' : 'OFF'}**.\nBy **${message.author.displayName}**`,
                    thumbnail: `attachment://${autoPlayImg}`,
                    files: [`./assets/image/icons/${autoPlayImg}`],
                }));
            }



        });



                TrueMusic.on('interactionCreate', async (interaction) => {
                    // Update activity timestamp on every interaction so idle-killer doesn't fire
                    botLastActivity.set(token, Date.now());

                    const musicButtons = new Set(['loop', 'pause', 'volume_down', 'volume_up', 'skip', 'like', 'prev', 'stop', 'queue_btn']);
                    const isMusicButton = interaction.isButton() && musicButtons.has(interaction.customId);
                    const isMusicMenu = interaction.isStringSelectMenu() && ['np_artist', 'np_filter'].includes(interaction.customId);
                    if (!isMusicButton && !isMusicMenu) return;

                    const replyEphemeral = async (content) => {
                        if (interaction.deferred || interaction.replied) {
                            return interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
                        }
                        return interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
                    };

                    const memberVoice = interaction.member?.voice?.channel;
                    const clientVoice = interaction.guild?.members?.me?.voice?.channel;
                    if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) {
                        return replyEphemeral('**ادخل نفس الروم الصوتي أولاً.**');
                    }

                            const player = TrueMusic.poru.players.get(interaction.guildId);
                            if (!player || !player.currentTrack) {
                                return replyEphemeral('**لا يوجد شيء يعمل الآن.**');
                            }

                                    const activePanelId = player.data?.nowPlayingMessage?.id;
                                    if (activePanelId && interaction.message?.id !== activePanelId) {
                                        return replyEphemeral('انتهت صلاحية لوحة التحكم لأن الأغنية تغيّرت.');
                                    }

                            const tokenObj = (store.get('tokens') || []).find(t => t.token === token);
                            const ui = player.data.ui || {};
                            const requesterId = ui.requesterId || player.currentTrack?.info?.requester?.id || player.currentTrack?.info?.requester;
                            const editPanel = async (liked = false, targetInteraction = null) => {
                                if (!player.currentTrack) return;
                                ui.liked = liked;
                                player.data.ui = ui;
                                const payload = buildNowPlayingV2Payload(TrueMusic, tokenObj, player, { author: interaction.user }, {
                                    track: player.currentTrack,
                                    requester: player.currentTrack?.info?.requester || interaction.user,
                                    includeControls: true,
                                    liked,
                                    artistTracks: ui.artistTracks || [],
                                    selectedFilter: ui.selectedFilter || player.data.activeFilter || 'clear',
                                    selectedArtistIndex: ui.selectedArtistIndex ?? null,
                                    compactPlayLayout: ui.compactPlayLayout === true,
                                    showProgressLabels: true,
                                    showInfoRow: false,
                                    useEmbedAccent: false,
                                    progressWidth: PLAY_PROGRESS_WIDTH,
                                    // Reuse the last rendered Canvas image so button presses
                                    // don't block the event loop regenerating it each click.
                                    reuseProgressBar: true,
                                });
                        if (targetInteraction && !targetInteraction.deferred && !targetInteraction.replied) {
                            await targetInteraction.deferUpdate().catch(() => {});
                        }
                        const targetMessage = player.data?.nowPlayingMessage || interaction.message;
                        await safeEditMessage(targetMessage, payload).catch(() => {});
                    };

                    if (isMusicMenu) {
                        if (interaction.customId === 'np_artist') {
                            await interaction.deferUpdate().catch(() => {});
                            if (ui.requesterId && interaction.user.id !== ui.requesterId) {
                                return replyEphemeral('هذه القائمة لصاحب الطلب فقط.');
                            }

                                    const selectedValue = interaction.values[0];
                                    if (selectedValue === ARTIST_MENU_HEADER_VALUE) {
                                        return replyEphemeral('**اختر أغنية من القائمة.**');
                                    }

                                    const selectedIndex = Number(selectedValue);
                                    const selectedTrack = ui.artistTracks?.[selectedIndex];
                                    if (!selectedTrack) return replyEphemeral('**لم أجد الأغنية المختارة.**');

                                            const queuedTrack = { ...selectedTrack, info: { ...selectedTrack.info, requester: interaction.user } };
                                            player.queue.add(queuedTrack);
                                            runBackground('artist queue panels', () => bumpQueueVersion(player, 'artist_menu_add'));
                                                    ui.selectedArtistIndex = null;
                                                    player.data.ui = ui;

                                    runBackground('artist panel edit', () => editPanel(!!ui.liked));

                                    await safePlay(player);
                                    return replyEphemeral(`**تمت إضافة ${queuedTrack.info.title || 'الأغنية'} للطابور.**`);
                                }

                        if (interaction.customId === 'np_filter') {
                            const filterName = interaction.values[0];
                            // ── C: debounce — only apply filter 300ms after last click ──
                            await interaction.deferUpdate().catch(() => {});
                            if (player.data._filterDebounceTimer) {
                                clearTimeout(player.data._filterDebounceTimer);
                                player.data._filterDebounceTimer = null;
                            }
                            player.data._filterDebounceTimer = setTimeout(async () => {
                                player.data._filterDebounceTimer = null;
                                try {
                                    const applied = await applyFilter(player, filterName);
                                    ui.selectedFilter = applied;
                                    ui.selectedArtistIndex = null;
                                    player.data.ui = ui;
                                    const label = FILTER_NAMES[applied] || applied;
                                    const response = applied === 'clear' ? '**Filter stopped.**' : `**Done applied : ${label}.**`;
                                    runBackground('filter panel edit', () => editPanel(!!ui.liked));
                                    replyEphemeral(response);
                                } catch (err) {
                                    console.error('[Filters] failed:', err?.message || err);
                                    replyEphemeral('Failed to apply.');
                                }
                            }, 300);
                            // ─────────────────────────────────────────────────────────
                            return;
                        }
                    }

                    await interaction.deferUpdate().catch(() => {});
                    let responseMessage = '';

                    if (interaction.customId === 'loop') {
                        const newLoopMode = player.loop === 'NONE' ? 'TRACK' : 'NONE';
                        player.setLoop(newLoopMode);
                        responseMessage = `**Loop is ${newLoopMode === 'TRACK' ? 'ON' : 'OFF'}.**`;
                        // Fire panel update in background — no need to await for instant response
                        editPanel(!!ui.liked).catch(() => {});
                    }

                    if (interaction.customId === 'pause') {
                        if (player.isPaused) {
                            responseMessage = '**Done resume the music.**';
                            // Update local state immediately, fire both tasks in background
                            player.isPaused = false;
                            player.isPlaying = true;
                            pausePlayerSynced(player, false).catch(err => console.warn('[button resume]', err?.message || err));
                            editPanel(!!ui.liked).catch(() => {});
                        } else {
                            responseMessage = '**Done pause the music.**';
                            player.isPaused = true;
                            player.isPlaying = false;
                            pausePlayerSynced(player, true).catch(err => console.warn('[button pause]', err?.message || err));
                            editPanel(!!ui.liked).catch(() => {});
                        }
                    }

                    if (interaction.customId === 'volume_down') {
                        const newVolume = clampPlayerVolume(playerVolumeValue(player) - 10);
                        responseMessage = `**Volume is now __${newVolume}%__.**`;
                        // setPlayerVolumeSynced already updates local state + fires lavalink fire-and-forget
                        setPlayerVolumeSynced(player, newVolume).catch(err => console.warn('[button volume down]', err?.message || err));
                        editPanel(!!ui.liked).catch(() => {});
                    }

                    if (interaction.customId === 'volume_up') {
                        const newVolume = clampPlayerVolume(playerVolumeValue(player) + 10);
                        responseMessage = `**Volume is now __${newVolume}%__.**`;
                        setPlayerVolumeSynced(player, newVolume).catch(err => console.warn('[button volume up]', err?.message || err));
                        editPanel(!!ui.liked).catch(() => {});
                    }

                            if (interaction.customId === 'skip') {
                                const currentTrack = player.currentTrack;
                                if (!currentTrack) {
                                    responseMessage = '*لا توجد أغنية للتخطي*.';
                                } else if (player.queue.length === 0 && player.data?.autoPlay) {
                                    responseMessage = `**Done skipped : ${currentTrack.info.title || 'الأغنية'}**`;
                                    // Fire both in background — instant response
                                    skipPlayerSynced(TrueMusic.poru, player, currentTrack).catch(() => {});
                                    editPanel(!!ui.liked).catch(() => {});
                                } else if (player.queue.length === 0) {
                                    const finalOptions = finalUiOptionsFor(player, currentTrack);
                                    markStopped();
                                    setAutoPlayState(player, false);
                                    clearStoppedPlaybackCaches(player);
                                    clearProgressInterval(player, 'button skip end');
                                    responseMessage = `**Done skipped : ${currentTrack.info.title || 'الأغنية'}**`;
                                    // Fire both in background — instant response
                                    stopPlayerAudio(player, { wait: false }).catch(() => {});
                                    editPanel(!!ui.liked).catch(() => {});
                                    runBackground('button skip end cleanup', async () => {
                                        await finalizePlayerUi(player, finalOptions);
                                        await bumpQueueVersion(player, 'button_skip_end');
                                        await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                                    });
                                } else {
                                    responseMessage = `**Done skipped : ${currentTrack.info.title || 'الأغنية'}**`;
                                    // Fire both in background — instant response
                                    skipPlayerSynced(TrueMusic.poru, player, currentTrack).catch(() => {});
                                    editPanel(!!ui.liked).catch(() => {});
                                    runBackground('button skip cleanup', () => bumpQueueVersion(player, 'button_skip'));
                                }
                    }

                    if (interaction.customId === 'prev') {
                        const now = Date.now();
                        const lastPress = player.data.lastPrevPressTime || 0;
                        player.data.lastPrevPressTime = now;
                        if (now - lastPress < 3000 && player.queue.previous) {
                            const currentBeforePrev = player.currentTrack;
                            const prevTrack = player.queue.previous;
                            player.queue.unshift(currentBeforePrev);
                            player.queue.unshift(prevTrack);
                            responseMessage = `⏮ رجعنا للأغنية السابقة.`;
                            // Lavalink + panel in parallel — same instant
                            await Promise.all([
                                skipPlayerSynced(TrueMusic.poru, player, currentBeforePrev).catch(() => {}),
                                editPanel(!!ui.liked),
                            ]);
                            runBackground('button prev cleanup', () => bumpQueueVersion(player, 'button_prev'));
                        } else {
                            responseMessage = `⏮ تم إعادة الأغنية من البداية.`;
                            // Seek + panel in parallel — same instant
                            await Promise.all([
                                player.seekTo(0).catch(err => console.warn('[button prev seek]', err?.message || err)),
                                editPanel(!!ui.liked),
                            ]);
                        }
                    }

                    if (interaction.customId === 'stop') {
                        const stoppedTrack = player.currentTrack;
                        const finalOptions = finalUiOptionsFor(player, stoppedTrack);
                        markStopped();
                        player.setLoop('NONE');
                        player.queue.clear();
                        setAutoPlayState(player, false);
                        clearStoppedPlaybackCaches(player);
                        clearProgressInterval(player, 'button stop');
                        responseMessage = '**Done stopped the song.**';
                        // Fire both in background — instant response
                        stopPlayerAudio(player, { wait: false }).catch(() => {});
                        editPanel(!!ui.liked).catch(() => {});
                        runBackground('button stop cleanup', async () => {
                            await finalizePlayerUi(player, finalOptions);
                            await bumpQueueVersion(player, 'button_stop');
                            await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                        });
                    }

                    if (interaction.customId === 'queue_btn') {
                        if (!player.currentTrack) {
                            responseMessage = '*لا يوجد شيء يعمل الآن.*';
                        } else {
                            const qItemsPerPage = 8;
                            let qPage = 0;
                            const refId = interaction.id;
                            const queueMsg = await interaction.followUp({
                                ...musicPayload(tokenObj, {
                                    title: queueTitle(interaction.guild.name, TrueMusic),
                                    description: buildQueueDescription(player, qPage, qItemsPerPage),
                                    components: buildQueueComponents(player, tokenObj, refId, qPage, qItemsPerPage),
                                    thumbnail: 'attachment://Queue.png',
                                    files: ['./assets/image/icons/Queue.png'],
                                    footer: buildQueueFooter(player, qPage, qItemsPerPage),
                                }),
                                flags: MessageFlags.Ephemeral,
                            }).catch(() => null);
                            if (queueMsg) {
                                let qVersion = ensurePlayerData(player).queueVersion;
                                registerQueuePanel(player, queueMsg, qVersion);
                                const qFilter = i => i.customId.startsWith(`queue_${refId}_`);
                                const qCollector = queueMsg.createMessageComponentCollector({ filter: qFilter, time: 120000 });
                                const renderQ = (i, title = queueTitle(interaction.guild.name, TrueMusic)) => i.update(musicPayload(tokenObj, {
                                    title,
                                    description: buildQueueDescription(player, qPage, qItemsPerPage),
                                    components: buildQueueComponents(player, tokenObj, refId, qPage, qItemsPerPage),
                                    thumbnail: 'attachment://Queue.png',
                                    files: ['./assets/image/icons/Queue.png'],
                                    footer: buildQueueFooter(player, qPage, qItemsPerPage),
                                }));
                                qCollector.on('collect', async i => {
                                    if ((player.data?.queueVersion || 0) !== qVersion) {
                                        qCollector.stop('stale');
                                        return i.update({ components: disableComponents(queueMsg.components) }).catch(() => {});
                                    }
                                    if (i.customId === `queue_${refId}_prev`) { if (qPage > 0) qPage--; return renderQ(i); }
                                    if (i.customId === `queue_${refId}_next`) { const tot = Math.max(1, Math.ceil(player.queue.length / qItemsPerPage)); if (qPage < tot - 1) qPage++; return renderQ(i); }
                                    if (i.customId === `queue_${refId}_clear`) {
                                        player.queue.clear();
                                        runBackground('queue clear bump', () => bumpQueueVersion(player, 'queue_clear'));
                                        qCollector.stop('cleared');
                                        return i.update(musicPayload(tokenObj, {
                                            title: 'Queue Cleared',
                                            description: '**تم حذف قائمة الانتظار بالكامل**.',
                                            thumbnail: 'attachment://Queue.png',
                                            files: ['./assets/image/icons/Queue.png'],
                                        }));
                                    }
                                    if (i.customId === `queue_${refId}_close`) { qCollector.stop('closed'); return i.update({ components: disableComponents(queueMsg.components) }); }
                                    if (i.customId === `queue_${refId}_reorder`) {
                                        if (typeof player.queue.splice !== 'function' || typeof player.queue.unshift !== 'function') return i.reply({ content: 'تعذر ترتيب الطابور.', flags: MessageFlags.Ephemeral });
                                        const idxs = [...new Set(i.values.map(Number))].filter(x => x >= 0 && x < player.queue.length);
                                        const sel = idxs.map(x => player.queue[x]).filter(Boolean);
                                        idxs.sort((a, b) => b - a).forEach(x => player.queue.splice(x, 1));
                                        for (let j = sel.length - 1; j >= 0; j--) player.queue.unshift(sel[j]);
                                        qPage = 0;
                                        qVersion = await bumpQueueVersion(player, 'queue_reorder', queueMsg.id);
                                        registerQueuePanel(player, queueMsg, qVersion);
                                        return renderQ(i, 'Queue Updated');
                                    }
                                });
                                qCollector.on('end', (_, reason) => {
                                    player.data?.queuePanels?.delete(queueMsg.id);
                                    if (!['closed', 'cleared'].includes(reason)) queueMsg.edit({ components: disableComponents(queueMsg.components) }).catch(() => {});
                                });
                            }
                            return;
                        }
                    }

                            if (interaction.customId === 'like') {
                                const currentTrack = player.currentTrack;
                                if (!currentTrack) {
                                    responseMessage = '*لا يوجد شيء يعمل الآن.*';
                                } else {
                                    try {
                                        const { liked } = await likes.toggle(interaction.user.id, currentTrack);
                                        responseMessage = liked
                                            ? `✅ Added **${currentTrack.info.title || 'الأغنية'}** to liked songs.`
                                            : `💔 Removed **${currentTrack.info.title || 'الأغنية'}** from liked songs.`;
                                        if (!requesterId || interaction.user.id === requesterId) {
                                            await editPanel(liked);
                                        }
                                    } catch (err) {
                                        console.error('[Likes] toggle failed:', err?.message || err);
                                        responseMessage = '*تعذر حفظ اللايك الآن*.';
                            }
                        }
                    }

                    await replyEphemeral(responseMessage || '*Done*.');
                });



                try {
                    await TrueMusic.login(token);
                } catch (e) {
                    console.log(`[Music] Failed to login a subscription bot for server ${idbot || 'unknown'}: ${e?.message || e}`);
                    return;
                }

    }
};
module.exports.runningBots = runningBots;
module.exports.botLastActivity = botLastActivity;
module.exports.restorePoruNodes = restorePoruNodes;
