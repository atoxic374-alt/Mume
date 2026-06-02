require('events').EventEmitter.defaultMaxListeners = 0;


const {
    Client,
    EmbedBuilder,
    Collection,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
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
} = require('discord.js');

const fs = require('fs');
const { Poru } = require('poru');

const { owners, TwitchUrl, statuses } = require(`${process.cwd()}/config`);
const { getVoiceConnection } = require('@discordjs/voice');

const store = require('./utils/store');
const likes = require('./utils/likes');
const { getDisplay } = require('./utils/display');
const MUSIC_EMOJIS = require('./utils/musicEmojis');
const { getEmbedColor, refreshEmbedColor } = require('./utils/embedColor');
const statusStore = require('./statusStore');
const { tintAttachmentPayload } = require('./utils/tintedThumbnail');
const { buildProgressBarAttachment, normalizeColorNumber } = require('./utils/progressBar');

const runningBots = new Collection();
const botLastActivity = new Map();
const tempData = new Collection();
tempData.set("bots", []);
const collection = new Collection();

const FILTER_NAMES = {
    clear: 'بدون فلتر',
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
    { label: 'إيقاف الفلاتر', value: 'clear', description: 'إزالة جميع الفلاتر', emoji: '⬛' },
    { label: 'Bass Boost', value: 'bassboost', description: 'جهير أوضح بدون تشويه', emoji: '🔊' },
    { label: 'Bass Boost+', value: 'bassboost2', description: 'جهير أقوى وواضح', emoji: '📢' },
    { label: 'Nightcore', value: 'nightcore', description: 'سرعة ونبرة أعلى', emoji: '🌙' },
    { label: 'Sped Up', value: 'spedup', description: 'تسريع خفيف بدون رفع مبالغ', emoji: '⏩' },
    { label: 'Slow Mode', value: 'slowmode', description: 'إبطاء ناعم للأغنية', emoji: '⏬' },
    { label: 'Deep Voice', value: 'deep', description: 'نبرة أعمق وأثقل', emoji: '⬇️' },
    { label: 'High Pitch', value: 'highpitch', description: 'نبرة عالية وسريعة', emoji: '⬆️' },
    { label: '8D Audio', value: '8d', description: 'حركة صوتية خفيفة', emoji: '🌀' },
    { label: 'Vaporwave', value: 'vaporwave', description: 'أبطأ وأنعم', emoji: '🌊' },
    { label: 'Karaoke', value: 'karaoke', description: 'تقليل الصوت البشري', emoji: '🎤' },
    { label: 'Tremolo', value: 'tremolo', description: 'اهتزاز مستوى الصوت', emoji: '〰️' },
    { label: 'Vibrato', value: 'vibrato', description: 'اهتزاز النبرة', emoji: '📳' },
    { label: 'Low Pass', value: 'lowpass', description: 'صوت أنعم', emoji: '🔉' },
    { label: 'Muffled', value: 'muffled', description: 'صوت مكتوم وواضح الفرق', emoji: '🔇' },
    { label: 'Channel Mix', value: 'channelmix', description: 'مزج خفيف للقنوات', emoji: '🔀' },
    { label: 'Treble Boost', value: 'treble', description: 'إبراز الأصوات العالية', emoji: '✨' },
    { label: 'Pop EQ', value: 'pop', description: 'موازنة مناسبة للأغاني العامة', emoji: '🎶' },
    { label: 'Electronic EQ', value: 'electronic', description: 'إيقاع وحدّة أكثر', emoji: '⚡' },
    { label: 'Soft EQ', value: 'soft', description: 'صوت أهدأ وأنظف', emoji: '☁️' },
];

const BASE_FILTERS = {
    volume: 1.0,
    equalizer: [],
    karaoke: null,
    timescale: null,
    tremolo: null,
    vibrato: null,
    rotation: null,
    distortion: null,
    channelMix: null,
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

function shortDuration(ms) {
    const value = Number(ms || 0);
    if (!value || value < 0) return 'Live';
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
                    .setEmoji(liked ? '💔' : '❤️')
                    .setStyle(liked ? ButtonStyle.Danger : ButtonStyle.Secondary)
                : new ButtonBuilder()
                    .setCustomId('prev')
                    .setEmoji('⏮')
                    .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('stop')
                .setEmoji('⏹')
                .setStyle(dangerStop ? ButtonStyle.Danger : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('pause')
                .setEmoji(paused ? '▶️' : MUSIC_EMOJIS.pause)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('skip')
                .setEmoji(MUSIC_EMOJIS.skip)
                .setStyle(ButtonStyle.Secondary),
        );
    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('volume_down')
                .setEmoji(MUSIC_EMOJIS.volumeDown)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('loop')
                .setEmoji(MUSIC_EMOJIS.loop)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('queue_btn')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('volume_up')
                .setEmoji(MUSIC_EMOJIS.volumeUp)
                .setStyle(ButtonStyle.Secondary),
        );

    if (includeLike && !likeInPrevSlot) {
        row2.addComponents(
            new ButtonBuilder()
                .setCustomId('like')
                .setEmoji(liked ? '💔' : '❤️')
                .setStyle(liked ? ButtonStyle.Danger : ButtonStyle.Secondary),
        );
    }

    return [row1, row2];
}

function buildMusicComponents({ liked = false, paused = false, artistTracks = [], selectedFilter = 'clear', selectedArtistIndex = null, showControls = true, compactControls = false }) {
    const rows = [];

    if (showControls && artistTracks.length > 0) {
        const artistMenu = new StringSelectMenuBuilder()
            .setCustomId('np_artist')
            .setPlaceholder('أفضل 5 أغاني لنفس الفنان')
            .addOptions(artistTracks.slice(0, 5).map((t, i) => ({
                label: (t.info.title || 'Unknown').slice(0, 99),
                value: String(i),
                description: `${shortDuration(t.info.length)} · ${(t.info.author || '').slice(0, 50)}`.slice(0, 99),
                emoji: ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i],
            })));
        rows.push(new ActionRowBuilder().addComponents(artistMenu));
    }

    if (showControls) {
        const activeFilterName = FILTER_NAMES[selectedFilter] || FILTER_NAMES.clear;
        const filterMenu = new StringSelectMenuBuilder()
            .setCustomId('np_filter')
            .setPlaceholder(`الفلاتر الصوتية • الحالي: ${activeFilterName}`)
            .addOptions(FILTER_OPTIONS.map(option => ({
                ...option,
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
            .setDescription(`**${titleText}**`)
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
            author !== 'Unknown artist'
                ? `**${author}** | By : **${requesterName}**`
                : `By : **${requesterName}**`,
        ].join('\n'),
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

function compactMusicText({ title, description, fields = [] }) {
    const parts = [];
    const cleanTitle = plainMusicText(title);
    const cleanDescription = plainMusicText(description);
    if (cleanTitle) parts.push(`**${cleanTitle}**`);
    if (cleanDescription) parts.push(cleanDescription);
    fields.forEach(field => {
        const name = plainMusicText(field?.name);
        const value = plainMusicText(field?.value);
        if (name && value) parts.push(`**${name}:** ${value}`);
    });
    return parts.join('\n') || 'Done.';
}

function musicPayload(tokenObj, { title, description, fields = [], components = [], color = undefined, thumbnail = null, files = [] }) {
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
        payload.embeds = [embed];
        if (files.length) payload.files = files;
        return tintAttachmentPayload(payload, embedColor);
    } else {
        payload.content = compactMusicText({ title, description, fields });
        payload.embeds = [];
    }

    return payload;
}

function cleanInlineText(value, fallback = 'Unknown', maxLength = 120) {
    const text = String(value || fallback).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
    return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 3))}...` : text;
}

function escapeMarkdownLinkText(value, maxLength = 100) {
    return cleanInlineText(value, 'Unknown', maxLength)
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function trackArtworkUrl(track, client) {
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
    return client.user?.displayAvatarURL?.({ extension: 'png', size: 256 }) || null;
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

    return musicPayload(tokenObj, {
        title: 'Now Playing',
        description:
            `**${titleText}**\n` +
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
        buttons.push(new ButtonBuilder()
            .setCustomId(`${refId}_platform`)
            .setLabel(`Platform: ${compactPlatformName(platform)}`.slice(0, 80))
            .setEmoji(MUSIC_EMOJIS.platforms[emojiKey] || '🎵')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true));
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
            .setLabel(`VOLUME: ${Math.max(0, Number(player?.volume || 100))}%`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true));
    }
    if (options.loop) {
        const loopValue = player?.loop === 'TRACK' ? 'ON' : 'OFF';
        buttons.push(new ButtonBuilder()
            .setCustomId(`${refId}_loop`)
            .setLabel(`LOOP: ${loopValue}`)
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
        return buildNowPlayingFallbackPayload(tokenObj, player, options.requester || current.requester || message?.author);
    }

    const totalTime = Math.max(0, Number(options.durationOverride ?? current.length ?? 0));
    const rawCurrentTime = Math.max(0, Number(options.positionOverride ?? player.position ?? 0));
    const currentTime = totalTime > 0 ? Math.min(rawCurrentTime, totalTime) : rawCurrentTime;
    const title = cleanInlineText(current.title, 'Unknown track', 96);
    const author = cleanInlineText(current.author, 'Unknown artist', 72);
    const uri = isHttpUrl(current.uri) ? current.uri : null;
    const titleLine = uri ? `[${escapeMarkdownLinkText(title, 96)}](${uri})` : title;
    const requester = options.requester || current.requester || message?.author;
    const requesterName = cleanInlineText(
        requester?.displayName || requester?.globalName || requester?.username || requester?.tag,
        'Unknown',
        64,
    );
    const loopMode = player.loop === 'TRACK' ? 'ON' : 'OFF';
    const volume = player.volume || 100;
    const artworkUrl = trackArtworkUrl(track, TrueMusic);
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
            new TextDisplayBuilder().setContent(`### ${titleLine}`),
        );

    if (artworkUrl) {
        section.setThumbnailAccessory(new ThumbnailBuilder().setURL(artworkUrl));
    }

    if (compactPlayLayout) {
        const progress = buildProgressBarAttachment({
            position: currentTime,
            duration: totalTime,
            color: progressColor,
            currentLabel: shortDuration(currentTime),
            durationLabel: shortDuration(totalTime),
            width: options.progressWidth || 500,
            height: 36,
            variant: 'discordCompact',
        });

        const container = new ContainerBuilder()
            .addSectionComponents(section)
            .addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder()
                        .setURL(`attachment://${progress.name}`)
                        .setDescription('Playback progress'),
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

    const meta = `🔁 ${loopMode}  🔊 ${volume}%  👤 ${requesterName}`;
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

function platformDisplay(source) {
    const names = {
        auto: 'Smart Search',
        ytsearch: 'YouTube',
        ytmsearch: 'YouTube Music',
        scsearch: 'SoundCloud',
        spsearch: 'Spotify',
        amsearch: 'Apple Music',
        dzsearch: 'Deezer',
    };
    return `${MUSIC_EMOJIS.platforms[source] || '🎵'} ${names[source] || source || 'YouTube'}`;
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
                    `**Platform :** ${platformDisplay(settings.platform)}`,
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

function rememberTextChannel(player, channelId) {
    if (!player || !channelId) return;
    ensurePlayerData(player);
    player.textChannel = channelId;
    player.data.lastTextChannel = channelId;
}

function registerQueuePanel(player, message, version) {
    if (!player || !message) return;
    const data = ensurePlayerData(player);
    data.queuePanels.set(message.id, { message, version });
}

function buildQueueDescription(player, page = 0, itemsPerPage = 8) {
    const totalPages = Math.max(1, Math.ceil(player.queue.length / itemsPerPage));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageTracks = player.queue.slice(safePage * itemsPerPage, (safePage + 1) * itemsPerPage);

    const queueTrackLink = (track, max = 62) => {
        const title = escapeMarkdownLinkText(track?.info?.title || 'Unknown', max);
        const url = isHttpUrl(track?.info?.uri) ? track.info.uri : null;
        return url ? `[${title}](${url})` : title;
    };

    const dur = (track) => shortDuration(track?.info?.length);
    const nowPlaying = player.currentTrack;

    // Total queue duration
    const totalMs = player.queue.reduce((sum, t) => sum + (t?.info?.length || 0), 0);
    const totalDurStr = shortDuration(totalMs);

    // Now Playing section
    const npAuthor = cleanInlineText(nowPlaying?.info?.author, '', 40);
    const npLine = [
        `**${queueTrackLink(nowPlaying, 72)}**`,
        npAuthor ? `\`${dur(nowPlaying)}\`  ·  ${npAuthor}` : `\`${dur(nowPlaying)}\``,
    ].join('\n> ');

    // Queue entries
    const queuedLines = pageTracks.map((track, i) => {
        const absolute = safePage * itemsPerPage + i + 1;
        const author = cleanInlineText(track.info?.author, '', 36);
        const numStr = String(absolute).padStart(2, '0');
        const titleLine = `\`${numStr}\`  **${queueTrackLink(track)}**`;
        const metaLine  = author
            ? `\`${dur(track)}\`  ·  ${author}`
            : `\`${dur(track)}\``;
        return `${titleLine}\n└ ${metaLine}`;
    });

    const upcomingHeader = player.queue.length > 0
        ? `**Upcoming**  ·  ${player.queue.length} track${player.queue.length === 1 ? '' : 's'}  ·  ${totalDurStr} total  ·  page ${safePage + 1}/${totalPages}`
        : '**Upcoming**';

    return [
        '**Now Playing**',
        `> ${npLine}`,
        '',
        upcomingHeader,
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
            .setEmoji(MUSIC_EMOJIS.pagePrev)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage === 0),
        new ButtonBuilder()
            .setCustomId(`queue_${refId}_next`)
            .setEmoji(MUSIC_EMOJIS.pageNext)
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

async function safePlay(player) {
    if (!player?.queue?.length) return false;
    if (player.isPlaying || player.isPaused) return false;
    await player.play();
    return true;
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
    'اغنيه', 'اغنية', 'رسمي', 'الرسمية', 'كلمات', 'فيديو', 'صوتي', 'موسيقي',
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
    if (isProbablyUrl(query)) {
        const result = await poru.resolve({ query });
        return dedupeTracks(result?.tracks || []).slice(0, limit);
    }

    const variants = buildSearchVariants(query);
    const sources = source === 'auto'
        ? ['ytmsearch', 'ytsearch', 'scsearch', 'spsearch', 'amsearch', 'dzsearch']
        : [source || 'ytsearch'];
    const tracks = [];

    for (const searchSource of sources) {
        for (const variant of variants) {
            if (tracks.length >= limit * 2) break;
            const result = await poru.resolve({ query: variant, source: searchSource }).catch(() => null);
            if (result?.tracks?.length) tracks.push(...result.tracks.slice(0, 8));
        }
    }

    return rankTracksForQuery(tracks, query, { strict: options.strict }).slice(0, limit);
}

const PLAY_PROGRESS_WIDTH = 400;
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
const artistTrackCache = new Map();

function trimArtistCandidate(value) {
    return String(value || '')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/\b(official|video|audio|lyrics?|lyric|clip|remix|hd|4k|music)\b/ig, ' ')
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

    const parts = raw.split(/\s+(?:-|–|—|\|)\s+/).map(trimArtistCandidate).filter(Boolean);
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
    const authorLooksLabel = isLikelyLabelAuthor(rawAuthor) || isLikelyLabelAuthor(author);

    if (titleArtist && (!author || authorLooksLabel)) {
        return {
            primary: titleArtist,
            fallback: authorLooksLabel ? (rawAuthor || author) : '',
        };
    }

    return {
        primary: authorLooksLabel ? (rawAuthor || author) : (author || titleArtist),
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

function isNearSameTrackTitle(track, currentTrack) {
    const currentTitle = currentTrack?.info?.title;
    const nextTitle = track?.info?.title;
    if (!currentTitle || !nextTitle) return false;

    const currentTokens = new Set(searchTokens(currentTitle));
    const nextTokens = new Set(searchTokens(nextTitle));
    if (currentTokens.size < 2 || nextTokens.size < 2) return false;

    let shared = 0;
    for (const token of currentTokens) {
        if (nextTokens.has(token)) shared++;
    }

    const smaller = Math.min(currentTokens.size, nextTokens.size);
    const larger = Math.max(currentTokens.size, nextTokens.size);
    return shared / smaller >= 0.8 && shared / larger >= 0.55;
}

function filterArtistTracks(tracks, currentTrack, limit) {
    const currentId = currentTrack?.info?.uri || currentTrack?.info?.identifier;
    const withoutCurrent = dedupeTracks(tracks)
        .filter(t => (t.info.uri || t.info.identifier) !== currentId);
    const withoutSameSong = withoutCurrent.filter(t => !isNearSameTrackTitle(t, currentTrack));

    return (withoutSameSong.length ? withoutSameSong : withoutCurrent).slice(0, limit);
}

async function resolveCachedArtistQuery(poru, query, source, limit) {
    const key = artistCacheKey(source, query);
    let tracks = getCachedArtistTracks(key);

    if (!tracks) {
        tracks = await resolveSmartTracks(poru, query, source || 'auto', Math.max(12, limit * 2));
        setCachedArtistTracks(key, tracks);
    }

    return tracks;
}

async function resolveArtistTracks(poru, artistQuery, source, currentTrack, limit = 5) {
    const artistName = typeof artistQuery === 'string' ? artistQuery : artistQuery?.primary;
    const fallbackName = typeof artistQuery === 'object' ? artistQuery.fallback : '';
    if (!artistName) return [];

    const key = artistCacheKey(source, artistName);
    let tracks = getCachedArtistTracks(key);

    if (!tracks) {
        tracks = await resolveSmartTracks(poru, artistName, source || 'auto', Math.max(12, limit * 2));
        setCachedArtistTracks(key, tracks);
    }

    const primaryTracks = filterArtistTracks(tracks, currentTrack, limit);
    const needsFallback = fallbackName
        && normalizeSearchText(fallbackName) !== normalizeSearchText(artistName)
        && primaryTracks.length < Math.min(3, limit);

    if (!needsFallback) return primaryTracks;

    const fallbackTracks = filterArtistTracks(
        await resolveCachedArtistQuery(poru, fallbackName, source, limit),
        currentTrack,
        limit,
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
    if (player?.data?.progressInterval) {
        clearInterval(player.data.progressInterval);
        player.data.progressInterval = null;
    }
    const msg = player?.data?.nowPlayingMessage;
    if (msg?.components?.length) {
        const context = player?.data?.nowPlayingContext;
        const track = options.track || player?.currentTrack || player?.previousTrack || player?.data?.lastTrack || context?.track;
        const client = context?.client;
        if (client && track?.info) {
            const tokenObj = (store.get('tokens') || []).find(t => t.token === context.token);
            const totalTime = Math.max(0, Number(options.durationOverride ?? track.info.length ?? 0));
            const currentPosition = Math.max(0, Number(player?.position || player?.data?.lastPosition || 0));
            const finalPosition = options.complete && totalTime > 0
                ? totalTime
                : (totalTime > 0 ? Math.min(currentPosition, totalTime) : currentPosition);
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
            await msg.edit(payload).catch(() => {});
        } else {
            await msg.edit({ components: disableComponents(msg.components) }).catch(() => {});
        }
    }
    if (player?.data) {
        player.data.nowPlayingMessage = null;
        player.data.nowPlayingToken = null;
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
            hostConfig = [{
                name: 'main',
                host: process.env.LAVALINK_HOST,
                port: parseInt(process.env.LAVALINK_PORT || '2333'),
                secure: process.env.LAVALINK_SECURE === 'true',
                password: process.env.LAVALINK_PASS || 'youshallnotpass',
            }];
        }

        const TrueMusic = new Client({
            shards: "auto",
            allowedMentions: {
                parse: ["roles", "users", "everyone"],
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


        runningBots.set(token, TrueMusic);

        TrueMusic.poru = new Poru(TrueMusic, hostConfig, {
            defaultPlatform: 'ytsearch',
            reconnectTries: 8,
            reconnectTimeout: 3000,
            resumeKey: `ens-${token.slice(-10)}`,
            resumeTimeout: 90,
            autoResume: true,
            bypassChecks: false,
        });

        // ✅ Required for Lavalink/Poru voice handshake (VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE)
        // Without this, bots may join VC but audio will be silent.
        TrueMusic.on('raw', (packet) => {
            try {
                TrueMusic.poru.packetUpdate(packet);
            } catch {
                // ignore
            }
        });

        const voiceEnsureLocks = new Map();

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
                        }
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
                if (tokenObj.chat) rememberTextChannel(created, tokenObj.chat);
                created.data.voiceEnsureReason = reason;
                return created;
            })().finally(() => {
                setTimeout(() => voiceEnsureLocks.delete(lockKey), 1500);
            });

            voiceEnsureLocks.set(lockKey, task);
            return task;
        }

        async function restartCurrentTrack(player, reason = 'recover') {
            if (!player?.currentTrack?.track || !player?.node?.rest) return false;
            await player.node.rest.updatePlayer({
                guildId: player.guildId,
                data: {
                    track: { encoded: player.currentTrack.track },
                    position: Math.max(0, Number(player.position || 0)),
                    paused: false,
                },
            });
            player.isPlaying = true;
            player.isPaused = false;
            ensurePlayerData(player);
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
            setTimeout(() => {
                TrueMusic.poru.players.forEach(player => {
                    if (player.node === node) recoverPlayerPlayback(player, reason).catch(() => {});
                });
            }, 6000);
        }

        const playbackWatchdog = setInterval(() => {
            const now = Date.now();
            TrueMusic.poru.players.forEach(player => {
                if (!player.currentTrack || player.isPaused) return;
                ensurePlayerData(player);
                const lastProgress = player.data.lastProgressAt || player.data.trackStartedAt || now;
                const length = Number(player.currentTrack.info?.length || 0);
                const grace = length && length < 90_000 ? 35_000 : 55_000;
                if (now - lastProgress > grace) {
                    recoverPlayerPlayback(player, 'stalled_progress').catch(() => {});
                }
            });
        }, 20_000);
        playbackWatchdog.unref?.();

        TrueMusic.poru.on('nodeConnect', (node) => {
            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const data = {
                status: 'online',
                connectedAt: Date.now(),
                reconnects: prev.reconnects ?? 0,
            };
            statusStore.setNode(name, data);

            let newData = tempData.get("bots");
            if (!newData.includes(TrueMusic)) newData.push(TrueMusic);
            tempData.set("bots", newData);

            let botNumber = newData.indexOf(TrueMusic) + 1;
            console.log(`\x1b[33m${botNumber}\x1b[0m | ${TrueMusic.user?.username || 'Unknown'} | Connected \x1b[32m${node.options.host}\x1b[0m`);
            scheduleNodeRecovery(node, 'node_connect');
        });

        TrueMusic.poru.on('nodeReconnect', (node) => {
            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const data = {
                status: 'online',
                connectedAt: Date.now(),
                reconnects: (prev.reconnects ?? 0) + 1,
            };
            statusStore.setNode(name, data);
            scheduleNodeRecovery(node, 'node_reconnect');
        });

        TrueMusic.poru.on('nodeDisconnect', (node) => {
            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const data = { status: 'offline', reconnects: prev.reconnects ?? 0 };
            statusStore.setNode(name, data);
            console.log(`\x1b[33m[Poru] Node reconnecting: ${name}\x1b[0m`);
        });

        TrueMusic.poru.on('nodeError', (node, err) => {
            const name = node.options.name || node.options.host;
            const prev = statusStore.getNodes().get(name) || {};
            const data = { status: 'offline', reconnects: (prev.reconnects ?? 0) + 1 };
            statusStore.setNode(name, data);
            const message = err?.message || String(err || 'unknown');
            const transient = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket/i.test(message);
            console.log(`${transient ? '\x1b[33m' : '\x1b[31m'}[Poru] Node ${transient ? 'transient' : 'error'} (${name}): ${message}\x1b[0m`);
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

        TrueMusic.on('voiceStateUpdate', async (oldState, newState) => {
            if (newState.member?.id !== TrueMusic.user?.id) return;
            if (voiceReturnLock) return;

            const tokenObj = (store.get('tokens') || []).find(t => t.token === token);
            if (!tokenObj?.channel || tokenObj.awaitingReplacement) return;

            const targetChannelId = tokenObj.channel;
            if (newState.channelId === targetChannelId) return;
            if (newState.channelId && tokenObj.backToVoice === 'off') return;

            const guild = newState.guild || oldState.guild;
            const targetChannel = guild?.channels.cache.get(targetChannelId)
                || await guild?.channels.fetch(targetChannelId).catch(() => null);
            if (!targetChannel) return;

            voiceReturnLock = true;
            try {
                await ensureConfiguredVoice(guild, tokenObj, 'voice_state_update');
            } catch {
                // periodic voice guard will retry
            } finally {
                setTimeout(() => { voiceReturnLock = false; }, 1200);
            }
        });

        TrueMusic.once('clientReady', async () => {
            refreshEmbedColor(TrueMusic).catch(() => {});
            try { TrueMusic.poru.init(TrueMusic); } catch (e) { console.error(`[Poru] فشل الاتصال بـ Lavalink: ${e.message}`); }
            collection.set(TrueMusic.user.id, TrueMusic);

            TrueMusic.poru.players.forEach(player => {
                player.queue.clear();
                player.skip?.().catch(() => {});
            });

            let int = setInterval(async () => {
                if (!TrueMusic.readyAt) return;

                let dataaa = store.get('tokens') || [];

                let tokenObj = dataaa.find((tokenBot) => tokenBot.token === token);

                if (!tokenObj) {
                    clearInterval(playbackWatchdog);
                    await TrueMusic.destroy().catch(() => 0);
                    runningBots.delete(token);
                    return clearInterval(int);
                }

                if (tokenObj.awaitingReplacement || tokenObj.expireDate <= Date.now()) {
                    clearInterval(playbackWatchdog);
                    await TrueMusic.destroy().catch(() => 0);
                    runningBots.delete(token);
                    return clearInterval(int);
                }

                if (tokenObj.channel) {
                    let guild = TrueMusic.guilds.cache.get(tokenObj.Server);
                    if (guild) {
                        const musicChannel = guild.channels.cache.get(tokenObj.channel);
                        if (musicChannel) {
                            const currentVC = guild.members.me.voice.channel;

                            const backToVoice = tokenObj.backToVoice !== 'off';
                            const shouldReconnect = !currentVC || (backToVoice && currentVC.id !== musicChannel.id);

                            if (shouldReconnect) {
                                if (!TrueMusic.readyAt) return;

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

            }, 5000);
        });








        TrueMusic.on('messageCreate', async (message) => {
            if (message.author.bot || !message.guild) return;
            botLastActivity.set(token, Date.now());
            var data = store.get('tokens') || [];
            let tokenObj = data.find((t) => t.token == token);
            if (!data || !tokenObj) return;

            let args = message.content?.trim().split(' ');
            if (args) {
                const hasMention = args.includes(`<@!${TrueMusic.user.id}>`) || args.includes(`<@${TrueMusic.user.id}>`);
                if (hasMention) {
                    args = args.filter(arg => arg !== `<@!${TrueMusic.user.id}>` && arg !== `<@${TrueMusic.user.id}>`);

                    if (!args[0]) return;
                    if (args[0] == 'help') {
                        const botOwnerId = tokenObj.client;
                        const button1 = new ButtonBuilder()
                            .setLabel('Support Server')
                            .setStyle('Link')
                            .setURL('https://discord.gg/ens');

                        const row1 = new ActionRowBuilder().addComponents(button1);
                        const helpEmbed = new EmbedBuilder()
                            .setColor(getEmbedColor(TrueMusic))

                            .setThumbnail("https://cdn.discordapp.com/attachments/1091536665912299530/1264225405465002025/O.png?ex=669d1928&is=669bc7a8&hm=ee36f6e8facc4eb99721570bc7f32dff9551bc5bea89d7a027c09408cafba604&")
                            .setDescription(`
              \`\`\`Music Commands\`\`\`
                play [track] - \`Adds the track to the queue.\`
                search [track] - \`Searching from YouTube\`

                join - \`Joins the voice channel\`
                leave - \`Leaves the voice channel\`
                pause - \`Pauses the playback\`
                resume - \`Resumes the playback\`

                skip - \`Skips the currently playing track\`
                queue - \`Displays the current queue\`
                stop - \`Stop playing songs\`
                autoplay - \`Play songs on the first song\`
                nowplaying - \`Displays the currently playing track\`
                seek [timestamp] - \`Sets the track's position to the timestamp\`
                remove [position] - \`Removes the track from the queue\`
                loop [ON/OFF] - \`Repeat play song\`
                forward [Time] - \`Present a specific time of the song\`
                volume [volume] - \`Sets the bot's volume\`

              \`\`\`Owner Commands\`\`\`

                setname [name] - \`Sets the name of the bot\`
                setavatar [attach a picture] - \`Sets the avatar of the bot\`
                streaming - \`Sets the status the bot displays\`

                setprefix [setprefix/unsetprefix] - \`Add and delete prefix\`
                setvc [setvc/leave] - \`set the voice bot and name it as voice.\`
                settc [settc/unchat] - \`Sets the text channel for playing music\`

                mu - \`Control all bots in a server in a True\`
                restart - \`Restart the bot\`
              
              `)



                        const additionalEmbed = new EmbedBuilder()
                            .setColor(getEmbedColor(TrueMusic))
                            .setDescription(`
                **Owner :** <@${botOwnerId}>
                **Ownerid :** \`${botOwnerId}\``);


                        message.author.send({
                            embeds: [helpEmbed, additionalEmbed],
                            components: [row1],
                        }).then(async () => {

                            const helpdma = new EmbedBuilder()
                                .setColor(getEmbedColor(TrueMusic))
                                .setDescription(`> **تم إرسال الاوامر في الخاص.**`)
                                .setFooter({
                                    text: 'Ens 𝐒𝐭𝐨𝐫𝐞',
                                    iconURL: 'https://cdn.discordapp.com/attachments/1091536665912299530/1264377247117082624/emo2.png?ex=669da692&is=669c5512&hm=6d7ce09b35345cdfa38f5aefa67c4031c4158b9b8ef95c83ea1336e979fbc9a1&' // رابط أيقونة البوت
                                });
                            message.reply({ embeds: [helpdma] }).catch(() => 0);



                        }).catch(() => {
                            message.react("🔒").catch(() => 0);
                        });
                    }


                    if (!owners.includes(message.author.id) && !message.member.permissions.has('ADMINISTRATOR')) {
                        return;
                    }
                    if (args[0] == 'restart' || args[0] == 'اعاده') {
                        await TrueMusic.destroy()
                        setTimeout(async () => {
                            TrueMusic.login(token).then(() => {
                                message.react(`💹`).catch(() => 0)
                            }).catch(() => { console.log(`${TrueMusic.user.tag} (${TrueMusic.user.id}) has an error with restarting.`) })
                        }, 5000)

                    } else if (args[0] == 'setname' || args[0] == 'اسم' || args[0] == 'name' || args[0] == 'sn') {
                        let name = args.slice(1).join(' ');
                        if (!name) return;

                        const tryChangeName = (newName, attempts = 0) => {
                            TrueMusic.user.setUsername(newName).then(async () => {
                                message.react('✅').catch(() => 0);
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
                                message.react('✅').catch(() => { });
                            })
                            .catch((error) => {
                                message.react('✅').catch(() => { });
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
                        message.react('✅');
                    }
                    else if (args[0] == 'setup') {
                        let channel = message.member.voice.channel;
                        if (!channel) return;

                        data = data.map((tokenBot) => {
                            if (tokenBot.token == token) {
                                tokenBot.channel = channel.id;
                            }
                            return tokenBot;
                        });

                        const cooldownTime = 5000;
                        const lastChangeTime = TrueMusic.user.lastChangeTime || 0;
                        const currentTime = Date.now();
                        if (currentTime - lastChangeTime < cooldownTime) {
                            return message.react('⏳');
                        }

                        try {
                            await TrueMusic.user.setUsername(channel.name);
                            TrueMusic.user.lastChangeTime = Date.now();
                            store.set('tokens', data);
                            message.react('✅');
                        } catch (error) {
                            if (error.code === 50035) {
                                return message.reply('> **Please try to change the name later.**');
                            } else {
                                console.error(error);
                            }
                        }

                    } else if (args[0] == 'join' || args[0] == 'come' || args[0] == 'setvc' || args[0] == 'ادخل' || args[0] == 'تعال') {

                        let channel = message.member.voice.channel;
                        if (!channel) return;

                        data = data.map((tokenBot) => {
                            if (tokenBot.token == token) {
                                tokenBot.channel = channel.id;
                            }
                            return tokenBot;
                        });

                        store.set('tokens', data);

                        message.react('✅');
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
                        message.react('✅');

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
                        message.react('✅');
                        loadPrefix();

                    } else if (args[0] == 'ping' || args[0] == 'بنج' || args[0] == 'بنغ') {
                        const ping = TrueMusic.ws.ping;
                        message.reply(`> **ϟ Pong! My ping is \`${ping}ms.\`**`);

                    } else if (args[0] == 'setstreaming' || args[0] == 'streaming' || args[0] == 'ste' || args[0] == 'ستريمنج') {
                        let status = message.content.split(" ")[2];
                        if (!status) return message.react("❌");
                        TrueMusic.user.setPresence({
                            activities: [
                                {
                                    name: status,
                                    type: 'STREAMING',
                                    url: "https://twitch.tv/" + status,
                                },
                            ],
                            status: 'online',
                        });
                        message.react("✅");

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



    TrueMusic.poru.on('playerUpdate', (player) => {
        ensurePlayerData(player);
        const position = Number(player.position || 0);
        if (position > (player.data.lastPosition || 0) + 750 || !player.data.lastProgressAt) {
            player.data.lastProgressAt = Date.now();
            player.data.recoveryAttempts = 0;
        }
        player.data.lastPosition = position;
    });

    TrueMusic.poru.on('trackError', async (player, track, data) => {
        console.warn(`[TrackError] ${data?.type || 'unknown'} ${data?.reason || data?.exception?.message || ''}`.trim());
        if (data?.type === 'TrackStuckEvent') {
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
                console.warn(`[TrackStuck] Requeued stuck track for recovery at ${player.data.stuckResumePosition}ms`);
                return;
            }
        }
        await finalizePlayerUi(player);
        await bumpQueueVersion(player, 'track_error');
        setTimeout(() => recoverPlayerPlayback(player, 'track_error').catch(() => {}), 2500);
    });

    TrueMusic.poru.on('trackEnd', async (player, track, data) => {
      await finalizePlayerUi(player, { complete: true, track });
      await bumpQueueVersion(player, `track_end:${data?.reason || 'unknown'}`);
            });

            TrueMusic.poru.on("queueEnd", async (player) => {
              await finalizePlayerUi(player, { complete: true });
              await bumpQueueVersion(player, 'queue_end');
              const tokenObj2 = (store.get('tokens') || []).find(t => t.token === token);
              await updatePlaybackVoiceStatus(TrueMusic, tokenObj2, player, null);
              if (!player?.data?.autoPlay || player.data.autoPlay === false) {
                player.queue.clear();
                player.data.autoPlay = false;
        return;
      }
      const currentTrack = player.previousTrack || player.currentTrack || player.data?.lastTrack;
      if (!currentTrack) {
        await finalizePlayerUi(player);
        player.queue.clear();
        player.data.autoPlay = false;
        return;
      }

      const search = `${currentTrack.info.title} next autoplay`;
      const res = await TrueMusic.poru.resolve({
        query: search,
      });

      if (!res || res.tracks.length === 0) {
        await finalizePlayerUi(player);
        player.queue.clear();
        player.data.autoPlay = false;
        return;
      }

      const nextTrack = res.tracks.find(track => track.info.uri !== currentTrack.info.uri);

      if (!nextTrack) {
        await finalizePlayerUi(player);
        player.queue.clear();
        player.data.autoPlay = false;
        return;
      }

      nextTrack.info.requester = currentTrack.info.requester;
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

    function assertLavalinkFilterResponse(response) {
        if (!response) throw new Error('Lavalink did not return a player response');
        if (response.error || Number(response.status) >= 400) {
            throw new Error(response.message || response.error || `Lavalink filter error ${response.status}`);
        }
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

        const response = await player.node.rest.updatePlayer({
            guildId: player.guildId,
            data: { filters },
        });
        assertLavalinkFilterResponse(response);

        syncPlayerFilters(player, filters);

        player.data.activeFilter = selected;
        return selected;
    }

            // ── trackStart: always publish the normal now-playing panel ──────────
            TrueMusic.poru.on('trackStart', async (player, track) => {
        await bumpQueueVersion(player, 'track_start');
        ensurePlayerData(player);
        const stuckRecoveryIdentity = player.data.stuckRecoveryIdentity;
        const stuckResumePosition = Math.max(0, Number(player.data.stuckResumePosition || 0));
        const shouldResumeStuckTrack = stuckRecoveryIdentity && stuckRecoveryIdentity === trackIdentity(track);
                player.data.lastTrack = track;
        player.data.trackStartedAt = Date.now();
        player.data.lastProgressAt = Date.now();
        player.data.lastPosition = 0;
        player.data.recoveryAttempts = 0;
        if (shouldResumeStuckTrack) {
            delete player.data.stuckRecoveryIdentity;
            delete player.data.stuckRecoveryAt;
            delete player.data.stuckResumePosition;
            if (stuckResumePosition > 0) {
                setTimeout(() => {
                    const stillSameTrack = player.currentTrack && trackIdentity(player.currentTrack) === trackIdentity(track);
                    if (!stillSameTrack) return;
                    const seek = typeof player.seekTo === 'function' ? player.seekTo.bind(player) : player.seek?.bind(player);
                    if (seek) Promise.resolve(seek(stuckResumePosition)).catch(() => {});
                }, 1200);
            }
        }

                const requester = track.info?.requester;
        const tokenObj2 = (store.get('tokens') || []).find(t => t.token === token);
        await updatePlaybackVoiceStatus(TrueMusic, tokenObj2, player, track);
                if (!requester) return;

                const tc = player.data.lastTextChannel || player.textChannel;
                let channel;
                if (typeof tc === 'string') {
                    channel = TrueMusic.channels.cache.get(tc);
                } else if (tc && typeof tc === 'object') {
                    channel = TrueMusic.channels.cache.get(tc.id) || tc;
                }
                if (!channel) return;

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

        const msg = await channel.send(payload).catch(() => null);
        if (!msg) return;

        player.data.nowPlayingMessage = msg;
        player.data.nowPlayingToken = track?.track || track?.info?.identifier || track?.info?.title || null;
        player.data.nowPlayingContext = {
            client: TrueMusic,
            token,
            track,
            requester,
        };

        if (player.data.progressInterval) clearInterval(player.data.progressInterval);
        player.data.progressInterval = setInterval(async () => {
            if (!player.data.nowPlayingMessage || player.data.nowPlayingMessage.id !== msg.id) {
                clearInterval(player.data.progressInterval);
                player.data.progressInterval = null;
                return;
            }
            try {
                const tokenObj3 = (store.get('tokens') || []).find(t => t.token === token);
                        const ui3 = player.data.ui || {};
                        const alreadyLiked3 = await likes.isLiked(
                            player.currentTrack?.info?.requester?.id || '',
                            player.currentTrack || track,
                        ).catch(() => false);
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
                await msg.edit(payload3).catch(() => {});
            } catch (err) {
                console.error('[ProgressUpdate] failed:', err?.message || err);
            }
        }, 15000);

        const artistQuery = artistQueryForTrack(track);
        if (!artistQuery?.primary) return;

                try {
                    const source = displaySettings(tokenObj2).platform;
                    const artistTracks = await resolveArtistTracks(TrueMusic.poru, artistQuery, source || 'auto', track, 5);
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
                await msg.edit(payload).catch(() => {});
            }
        } catch (err) {
            console.error('[TopSongs] failed:', err?.message || err);
        }
    });



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
                            if (subBotCommand && ['set', 'settings', 'اعدادات', 'إعدادات'].includes(subBotCommand.name)) {
                                const settingsCommand = require('./commands/Subscriptions/settings');
                                return settingsCommand.execute(TrueMusic, message, subBotCommand.args);
                            }
                                    if (subBotCommand && ['info', 'botinfo', 'about', 'معلومات', 'معلومه', 'تفاصيل'].includes(subBotCommand.name)) {
                                        const embed = buildBotInfoEmbed(TrueMusic, tokenObj, message.guild.id);
                                        return message.reply({ embeds: [embed] }).catch(() => {});
                                    }
                                    const likesCommandNames = ['mylikes', 'likes', 'liked', 'لايكاتي'];
                                    const runMyLikesCommand = (args = []) => {
                                        // Must be in same VC as this sub-bot — identical to music command behaviour
                                        const botVoice   = message.guild.members?.me?.voice?.channel;
                                        const memberVoice = message.member?.voice?.channel;
                                        if (!memberVoice || !botVoice || memberVoice.id !== botVoice.id) return null;

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
            if (!clientVoice || memberVoice.id !== clientVoice.id) return;

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
                autoplay: [`autoplay`, `Autoplay`, `Ap`, `ap`],
                search: [`search`, `ys`, `بحث`],
                queue: [`queue`, `قائمة`, `اغاني`, `q`, `qu`, `Q`, `Qu`, `Queue`],

            };

            if (cmdsArray.play.includes(command)) {
                const song = args.join(' ');
                        if (!song) {
                            return message.channel.send(musicPayload(tokenObj, {
                                title: 'Play Command',
                        description:
                            '`play [Song]` : Play the first search result\n' +
                            '`play [URL]` : Play from YouTube, SoundCloud, Spotify, Apple Music, or Deezer',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                            }));
                        }

                        if (isMemberDeafened(message.member)) {
                            return message.reply(deafenedPlaybackPayload(tokenObj));
                        }

                                let player = TrueMusic.poru.players.get(message.guild.id);
                        if (player) rememberTextChannel(player, message.channel.id);

                        if (!player) {
                            try {
                                const voiceConnection = getVoiceConnection(message.guild.id);
                        if (voiceConnection) {
                            voiceConnection.destroy();
                            await new Promise(res => setTimeout(res, 500));
                        }
                    } catch { }

                            player = await TrueMusic.poru.createConnection({
                                guildId: message.guild.id,
                                voiceChannel: message.member.voice.channel.id,
                                textChannel: message.channel.id,
                                deaf: true,
                                autoPlay: false,
                                group: tokenObj.token,
                            });
                            ensurePlayerData(player);
                                    rememberTextChannel(player, message.channel.id);
                                    player.data.autoPlay = false;

                                }

                        try {
                                    const searchSource = displaySettings(tokenObj).platform;
                            let res = await TrueMusic.poru.resolve({
                                query: song,
                                ...(isProbablyUrl(song) ? {} : { source: searchSource }),
                            });
                            if ((!res || !res.tracks || res.tracks.length === 0) && !isProbablyUrl(song)) {
                                const fallbackTracks = await resolveSmartTracks(TrueMusic.poru, song, 'auto', 10);
                                if (fallbackTracks.length) res = { loadType: 'search', tracks: fallbackTracks };
                            }

                            if (!res || !res.tracks || res.tracks.length === 0) {
                                return message.reply(musicPayload(tokenObj, {
                            title: 'No Results',
                            description: `No results found for **${song}**.`,
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
                                await bumpQueueVersion(player, 'playlist_add');
                            } else {
                                const track = res.tracks[0];
                                track.info.requester = message.author;
                                player.queue.add(track);
                                await bumpQueueVersion(player, 'track_add');

                                if (player.isPlaying) {
                                    return message.reply(musicPayload(tokenObj, {
                                title: 'Add Song',
                                description: `**[${track.info.title}](${track.info.uri})**`,
                                fields: [{ name: 'Song Duration', value: `**${shortDuration(track.info.length)}**`, inline: true }],
                                thumbnail: 'attachment://AddSong.png',
                                files: ['./assets/image/icons/AddSong.png'],
                            }));
                        }
                            }

                                    await safePlay(player);

                } catch (error) {
                    console.error('Error searching for song:', error.message);
                    message.reply(musicPayload(tokenObj, {
                        title: 'Search Error',
                        description: 'An error occurred while searching for the song.',
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
                        description: 'No music is currently playing.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                                player.setLoop('NONE');
                                player.queue.clear();
                                player.data.autoPlay = false;
                                await finalizePlayerUi(player);
                                await bumpQueueVersion(player, 'stop');
                                await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                                await player.destroy();
                                message.react(`🔴`);
            }


            if (cmdsArray.nowplaying.includes(command)) {

                let player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: 'No music is currently playing.',
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
                        description: 'No music is currently playing.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                const currentLoop = player.loop;
                const newLoopMode = currentLoop === "NONE" ? "TRACK" : "NONE";
                player.setLoop(newLoopMode);

                return message.reply(musicPayload(tokenObj, {
                    title: 'Loop',
                    description: `Loop mode is now **${newLoopMode === "TRACK" ? 'ON' : 'OFF'}**.`,
                    thumbnail: `attachment://${newLoopMode === "TRACK" ? 'LoopON.png' : 'LoopOFF.png'}`,
                    files: [`./assets/image/icons/${newLoopMode === "TRACK" ? 'LoopON.png' : 'LoopOFF.png'}`],
                }));
            }

            if (cmdsArray.pause.includes(command)) {
                const player = TrueMusic.poru.players.get(message.guild.id);
                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: 'No music is currently playing.',
                    }));
                }

                const memberVoice = message.member.voice?.channel;
                const clientVoice = message.guild.members.me.voice?.channel;

                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                if (player.isPaused) {
                    await player.pause(false);
                    message.react('▶️');
                } else {
                    await player.pause(true);
                    message.react('⏸️');
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
                        description: 'No songs are currently in the queue.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                        const currentTrackForRender = () => player.currentTrack;
                        if (!currentTrackForRender()) {
                            return message.reply(musicPayload(tokenObj, {
                                title: 'Queue',
                                description: 'No song is currently playing.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                const itemsPerPage = 8;
                let page = 0;

                        const getThumb = () => trackArtworkUrl(player.currentTrack, TrueMusic);

                        const queueMessage = await message.reply(musicPayload(tokenObj, {
                            title: `🎶  ${message.guild.name}`,
                            description: buildQueueDescription(player, page, itemsPerPage),
                            components: buildQueueComponents(player, tokenObj, message.id, page, itemsPerPage),
                            thumbnail: getThumb(),
                        })).catch(console.error);

                        if (!queueMessage || !displaySettings(tokenObj).buttons) return;
                        let queueVersion = ensurePlayerData(player).queueVersion;
                        registerQueuePanel(player, queueMessage, queueVersion);

                        const filter = interaction => interaction.user.id === message.author.id && interaction.customId.startsWith(`queue_${message.id}_`);
                        const collector = queueMessage.createMessageComponentCollector({ filter, time: 120000 });

                        const renderQueue = (interaction, title = `🎶  ${message.guild.name}`) => interaction.update(musicPayload(tokenObj, {
                            title,
                            description: buildQueueDescription(player, page, itemsPerPage),
                            components: buildQueueComponents(player, tokenObj, message.id, page, itemsPerPage),
                            thumbnail: getThumb(),
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
                                await bumpQueueVersion(player, 'queue_clear');
                                collector.stop('cleared');
                                return interaction.update(musicPayload(tokenObj, {
                                    title: 'Queue Cleared',
                                    description: 'تم حذف قائمة الانتظار بالكامل.',
                                }));
                            }

                            if (interaction.customId === `queue_${message.id}_close`) {
                                collector.stop('closed');
                                return interaction.update({ components: disableComponents(queueMessage.components) });
                            }

                            if (interaction.customId === `queue_${message.id}_reorder`) {
                                if (typeof player.queue.splice !== 'function' || typeof player.queue.unshift !== 'function') {
                                    return interaction.reply({ content: 'تعذر ترتيب الطابور في هذا الإصدار.', ephemeral: true });
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

                if (!player || !player.isPlaying) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: 'No music is currently playing.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                let memberVoice = message.member?.voice?.channel;
                let clientVoice = message.guild.members?.me?.voice?.channel;

                if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) return;

                const currentTrack = player.currentTrack;

                        if (player.queue.length === 0) {
                            await finalizePlayerUi(player);
                            await bumpQueueVersion(player, 'skip_end');
                            await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                            await player.destroy();
                            return message.reply(musicPayload(tokenObj, {
                        title: 'Skipped',
                        description: `**${currentTrack.info.title}**\nBy **${message.author.displayName}**`,
                        thumbnail: 'attachment://Skip.png',
                        files: ['./assets/image/icons/Skip.png'],
                    }));
                        } else {
                            const skippedTrack = currentTrack;
                            await finalizePlayerUi(player);
                            await bumpQueueVersion(player, 'skip');
                            await player.skip();

                    return message.reply(musicPayload(tokenObj, {
                        title: 'Skipped',
                        description: `**${skippedTrack.info.title}**\nBy **${message.author.displayName}**`,
                        thumbnail: 'attachment://Skip.png',
                        files: ['./assets/image/icons/Skip.png'],
                    }));
                }
            }



            else if (cmdsArray.volume.includes(command)) {
                let player = TrueMusic.poru.players.get(message.guild.id);

                if (!player || !player.isPlaying) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: 'No music is currently playing.',
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
                        description: `Current volume is **${currentVolume}%**.`,
                        thumbnail: 'attachment://Volumeup.png',
                        files: ['./assets/image/icons/Volumeup.png'],
                    }));
                }

                if (volume < 0 || volume > 130) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Volume',
                        description: 'Please provide a valid volume level between **0%** and **130%**.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                player.setVolume(volume);

                return message.reply(musicPayload(tokenObj, {
                    title: 'Volume',
                    description: `Volume changed from **${currentVolume}%** to **${volume}%**.`,
                    thumbnail: `attachment://${volume < currentVolume ? 'Volumedowwn' : 'Volumeup'}.png`,
                    files: [`./assets/image/icons/${volume < currentVolume ? 'Volumedowwn' : 'Volumeup'}.png`],
                }));
            } else if (cmdsArray.seek.includes(command)) {
                const player = TrueMusic.poru.players.get(message.guild.id);

                if (!player || !player.currentTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: 'No music is currently playing.',
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
                        description: 'Please provide a seek duration like `1:11`, `90s`, or `2m`.',
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
                        description: 'Invalid time format. Use something like `1:30` or `90s`.',
                        thumbnail: 'attachment://seek.png',
                        files: ['./assets/image/icons/seek.png'],
                    }));
                }

                const seekTime = Math.min(seconds * 1000, player.currentTrack.info.length);
                await player.seekTo(seekTime);

                message.react("✅").catch(() => { });
            }


            else if (cmdsArray.search.includes(command)) {
                const searchQuery = args.join(' ');
                if (!searchQuery) {
                    return message.channel.send(musicPayload(tokenObj, {
                        title: 'Search',
                        description: 'Please write the name of the song.',
                    }));
                }

                if (!displaySettings(tokenObj).buttons) {
                    return message.channel.send(musicPayload(tokenObj, {
                        title: 'Search',
                        description: 'Search menus are disabled for this subscription. Use `play <song>` or enable buttons from settings.',
                    }));
                }

                const searchId = `search_${message.id}`;
                let currentTracks = [];
                let allSearchTracks = [];
                let selectedSource = null;
                let searchOffset = 0;
                let completed = false;

                        const platformOptions = [
                            { label: 'Smart Search', value: 'auto', emoji: '🔎', description: 'بحث متعدد المنصات وبأكثر من صيغة' },
                            { label: 'YouTube', value: 'ytsearch', emoji: MUSIC_EMOJIS.platforms.ytsearch },
                            { label: 'YouTube Music', value: 'ytmsearch', emoji: MUSIC_EMOJIS.platforms.ytmsearch },
                    { label: 'SoundCloud', value: 'scsearch', emoji: MUSIC_EMOJIS.platforms.scsearch },
                    { label: 'Spotify', value: 'spsearch', emoji: MUSIC_EMOJIS.platforms.spsearch },
                    { label: 'Apple Music', value: 'amsearch', emoji: MUSIC_EMOJIS.platforms.amsearch },
                    { label: 'Deezer', value: 'dzsearch', emoji: MUSIC_EMOJIS.platforms.dzsearch },
                ];

                const controlRow = (showBack = false, showContinue = false) => {
                    const row = new ActionRowBuilder();
                    if (showBack) {
                        row.addComponents(
                            new ButtonBuilder()
                                .setCustomId(`${searchId}_back`)
                                .setLabel('Back')
                                .setEmoji(MUSIC_EMOJIS.pagePrev)
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

                const buildTrackRows = (tracks) => [
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`${searchId}_song`)
                            .setPlaceholder('Choose a track')
                            .addOptions(tracks.map((track, index) => ({
                                label: (track.info.title || 'Unknown').slice(0, 99),
                                value: String(index),
                                description: `${shortDuration(track.info.length)} - ${(track.info.author || 'Unknown').slice(0, 50)}`.slice(0, 99),
                            })))
                    ),
                    controlRow(true, hasMoreSearchResults()),
                ];

                const sourceMessage = await message.channel.send(musicPayload(tokenObj, {
                    title: 'Search',
                    description: `البحث عن: **${searchQuery}**\nاختر المنصة التي تريد البحث فيها.`,
                    components: buildPlatformRows(),
                }));

                const collector = sourceMessage.createMessageComponentCollector({
                    filter: i => i.user.id === message.author.id && i.customId.startsWith(searchId),
                    time: 60000,
                });

                collector.on('collect', async interaction => {
                    if (interaction.customId === `${searchId}_cancel`) {
                        completed = true;
                        collector.stop('cancel');
                        return interaction.update(musicPayload(tokenObj, {
                            title: 'Search Cancelled',
                            description: 'تم إلغاء البحث.',
                        }));
                    }

                    if (interaction.customId === `${searchId}_back`) {
                        currentTracks = [];
                        allSearchTracks = [];
                        selectedSource = null;
                        searchOffset = 0;
                        return interaction.update(musicPayload(tokenObj, {
                            title: 'Search',
                            description: `البحث عن: **${searchQuery}**\nاختر المنصة التي تريد البحث فيها.`,
                            components: buildPlatformRows(),
                        }));
                    }

                            if (interaction.customId === `${searchId}_source`) {
                                selectedSource = interaction.values[0];
                                searchOffset = 0;
                                await interaction.update(musicPayload(tokenObj, {
                                    title: 'Searching',
                                    description: `يتم البحث بطريقة ${platformDisplay(selectedSource)} عن **${searchQuery}**...`,
                                }));

                                try {
                                    allSearchTracks = await resolveSmartTracks(TrueMusic.poru, searchQuery, selectedSource, 60, { strict: true });
                                    currentTracks = allSearchTracks.slice(searchOffset, searchOffset + 10);

                                    if (currentTracks.length === 0) {
                                return sourceMessage.edit(musicPayload(tokenObj, {
                                    title: 'No Results',
                                    description: `لم يتم العثور على نتائج في ${platformDisplay(selectedSource)}.`,
                                    components: [controlRow(true)],
                                }));
                            }

                                    return sourceMessage.edit(musicPayload(tokenObj, {
                                        title: 'Search Results',
                                        description: `النتائج من ${platformDisplay(selectedSource)} · مرتبة حسب صلة البحث وبدون تكرار.\nاختر أغنية من القائمة.`,
                                        components: buildTrackRows(currentTracks),
                                    }));
                        } catch (err) {
                            console.error('Error searching for videos:', err);
                            return sourceMessage.edit(musicPayload(tokenObj, {
                                title: 'Search Error',
                                description: 'حدث خطأ أثناء البحث. يمكنك الرجوع واختيار منصة أخرى.',
                                components: [controlRow(true)],
                            }));
                        }
                    }

                    if (interaction.customId === `${searchId}_continue`) {
                        if (!selectedSource) {
                            return interaction.update(musicPayload(tokenObj, {
                                title: 'Search',
                                description: 'اختر منصة البحث أولاً.',
                                components: buildPlatformRows(),
                            }));
                        }

                        const nextOffset = searchOffset + 10;
                        if (nextOffset >= allSearchTracks.length) {
                            return interaction.update(musicPayload(tokenObj, {
                                title: 'Search Results',
                                description: `لا توجد نتائج إضافية من ${platformDisplay(selectedSource)} لهذا البحث.`,
                                components: buildTrackRows(currentTracks),
                            }));
                        }

                        searchOffset = nextOffset;
                        currentTracks = allSearchTracks.slice(searchOffset, searchOffset + 10);
                        return interaction.update(musicPayload(tokenObj, {
                            title: 'Search Results',
                            description: `نتائج إضافية من ${platformDisplay(selectedSource)} · مطابقة للبحث.\nتم استبدال القائمة السابقة.`,
                            components: buildTrackRows(currentTracks),
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
                                description: 'لم يعد هذا الاختيار متاحاً. ارجع واختر نتيجة أخرى.',
                                components: [controlRow(true)],
                            }));
                        }

                                let player = TrueMusic.poru.players.get(message.guild.id);
                                if (player) rememberTextChannel(player, message.channel.id);
                                if (!player) {
                                    player = await TrueMusic.poru.createConnection({
                                        guildId: message.guild.id,
                                        voiceChannel: message.member.voice.channel.id,
                                        textChannel: message.channel.id,
                                        deaf: true,
                                        group: tokenObj.token,
                                    });
                                    ensurePlayerData(player);
                                    rememberTextChannel(player, message.channel.id);
                                }

                                const queuedTrack = { ...selectedTrack, info: { ...selectedTrack.info, requester: message.author } };
                                player.queue.add(queuedTrack);
                                await bumpQueueVersion(player, 'search_add');

                                completed = true;
                        collector.stop('selected');

                                await sourceMessage.edit(musicPayload(tokenObj, {
                                    title: player.isPlaying ? 'Add Song' : 'Playing',
                                    description: `**${queuedTrack.info.title}**\nBy **${message.author.displayName}**`,
                                }));

                                await safePlay(player);
                            }
                });

                collector.on('end', (_, reason) => {
                    if (!completed && reason === 'time') {
                        sourceMessage.edit(musicPayload(tokenObj, {
                            title: 'Search Expired',
                            description: 'انتهى وقت البحث بدون اختيار.',
                        })).catch(() => {});
                    }
                });
            } else if (cmdsArray.autoplay.includes(command)) {
                let player = TrueMusic.poru.players.get(message.guild.id);

                if (!player) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'No Music',
                        description: 'No music is currently playing.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }



                player.data.autoPlay = !player.data.autoPlay;




                return message.reply(musicPayload(tokenObj, {
                    title: 'Autoplay',
                    description: `Autoplay is now **${player.data.autoPlay ? 'ON' : 'OFF'}**.\nBy **${message.author.displayName}**`,
                    thumbnail: 'attachment://AutoPlay.png',
                    files: ['./assets/image/icons/AutoPlay.png'],
                }));
            }



        });



                TrueMusic.on('interactionCreate', async (interaction) => {
                    const musicButtons = new Set(['loop', 'pause', 'volume_down', 'volume_up', 'skip', 'like', 'prev', 'stop', 'queue_btn']);
                    const isMusicButton = interaction.isButton() && musicButtons.has(interaction.customId);
                    const isMusicMenu = interaction.isStringSelectMenu() && ['np_artist', 'np_filter'].includes(interaction.customId);
                    if (!isMusicButton && !isMusicMenu) return;

                    const replyEphemeral = async (content) => {
                        if (interaction.deferred || interaction.replied) {
                            return interaction.followUp({ content, ephemeral: true }).catch(() => {});
                        }
                        return interaction.reply({ content, ephemeral: true }).catch(() => {});
                    };

                    const memberVoice = interaction.member?.voice?.channel;
                    const clientVoice = interaction.guild?.members?.me?.voice?.channel;
                    if (!memberVoice || !clientVoice || memberVoice.id !== clientVoice.id) {
                        return replyEphemeral('ادخل نفس الروم الصوتي أولاً.');
                    }

                            const player = TrueMusic.poru.players.get(interaction.guildId);
                            if (!player || !player.currentTrack) {
                                return replyEphemeral('لا يوجد شيء يعمل الآن.');
                            }

                                    const activePanelId = player.data?.nowPlayingMessage?.id;
                                    if (activePanelId && interaction.message?.id !== activePanelId) {
                                        return replyEphemeral('انتهت صلاحية لوحة التحكم لأن الأغنية تغيّرت.');
                                    }

                            const tokenObj = (store.get('tokens') || []).find(t => t.token === token);
                            const ui = player.data.ui || {};
                            const requesterId = ui.requesterId || player.currentTrack?.info?.requester?.id || player.currentTrack?.info?.requester;
                            const editPanel = async (liked = false, targetInteraction = null) => {
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
                                });
                        if (targetInteraction && !targetInteraction.deferred && !targetInteraction.replied) {
                            await targetInteraction.deferUpdate().catch(() => {});
                        }
                        await interaction.message?.edit(payload).catch(() => {});
                    };

                    if (isMusicMenu) {
                        if (interaction.customId === 'np_artist') {
                            if (ui.requesterId && interaction.user.id !== ui.requesterId) {
                                return replyEphemeral('هذه القائمة لصاحب الطلب فقط.');
                            }

                                    const selectedIndex = Number(interaction.values[0]);
                                    const selectedTrack = ui.artistTracks?.[selectedIndex];
                                    if (!selectedTrack) return replyEphemeral('لم أجد الأغنية المختارة.');

                                            const queuedTrack = { ...selectedTrack, info: { ...selectedTrack.info, requester: interaction.user } };
                                            player.queue.add(queuedTrack);
                                            await bumpQueueVersion(player, 'artist_menu_add');
                                                    ui.selectedArtistIndex = null;
                                                    player.data.ui = ui;

                                            const liked = await likes.isLiked(requesterId || interaction.user.id, player.currentTrack).catch(() => false);
                                    await editPanel(liked, interaction);

                                    await safePlay(player);
                                    return replyEphemeral(`تمت إضافة **${queuedTrack.info.title || 'الأغنية'}** للطابور.`);
                                }

                        if (interaction.customId === 'np_filter') {
                            await interaction.deferUpdate().catch(() => {});
                            const filterName = interaction.values[0];
                            try {
                                        const applied = await applyFilter(player, filterName);
                                                ui.selectedFilter = applied;
                                                ui.selectedArtistIndex = null;
                                                ui.liked = await likes.isLiked(requesterId || interaction.user.id, player.currentTrack).catch(() => false);
                                                player.data.ui = ui;
                                        await editPanel(ui.liked);
                                const label = FILTER_NAMES[applied] || applied;
                                return replyEphemeral(applied === 'clear' ? 'تم إيقاف الفلاتر.' : `تم تطبيق **${label}**.`);
                            } catch (err) {
                                console.error('[Filters] failed:', err?.message || err);
                                return replyEphemeral('تعذر تطبيق الفلتر الآن.');
                            }
                        }
                    }

                    await interaction.deferReply({ ephemeral: true }).catch(() => {});
                    let responseMessage = '';

                    if (interaction.customId === 'loop') {
                        const newLoopMode = player.loop === 'NONE' ? 'TRACK' : 'NONE';
                        player.setLoop(newLoopMode);
                        responseMessage = `التكرار: **${newLoopMode === 'TRACK' ? 'ON' : 'OFF'}**`;
                    }

                    if (interaction.customId === 'pause') {
                        if (player.isPaused) {
                            await player.pause(false);
                            responseMessage = 'تم الاستئناف.';
                        } else {
                            await player.pause(true);
                            responseMessage = 'تم الإيقاف المؤقت.';
                        }
                        const liked = await likes.isLiked(requesterId || interaction.user.id, player.currentTrack).catch(() => false);
                        await editPanel(liked);
                    }

                    if (interaction.customId === 'volume_down') {
                        const newVolume = Math.max(player.volume - 10, 0);
                        await player.setVolume(newVolume);
                        responseMessage = `الصوت: **${newVolume}%**`;
                    }

                    if (interaction.customId === 'volume_up') {
                        const newVolume = Math.min(player.volume + 10, 130);
                        await player.setVolume(newVolume);
                        responseMessage = `الصوت: **${newVolume}%**`;
                    }

                            if (interaction.customId === 'skip') {
                                const currentTrack = player.currentTrack;
                                if (!currentTrack) {
                                    responseMessage = 'لا توجد أغنية للتخطي.';
                                } else if (player.queue.length === 0) {
                                    await finalizePlayerUi(player);
                                    await bumpQueueVersion(player, 'button_skip_end');
                                    await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                                    await player.destroy();
                                    responseMessage = `تم التخطي: **${currentTrack.info.title || 'الأغنية'}**`;
                                } else {
                                    await finalizePlayerUi(player);
                                    await bumpQueueVersion(player, 'button_skip');
                                    await player.skip();
                                    responseMessage = `تم التخطي: **${currentTrack.info.title || 'الأغنية'}**`;
                                }
                    }

                    if (interaction.customId === 'prev') {
                        const now = Date.now();
                        const lastPress = player.data.lastPrevPressTime || 0;
                        player.data.lastPrevPressTime = now;
                        if (now - lastPress < 3000 && player.queue.previous) {
                            const prevTrack = player.queue.previous;
                            await finalizePlayerUi(player);
                            await bumpQueueVersion(player, 'button_prev');
                            player.queue.unshift(player.currentTrack);
                            player.queue.unshift(prevTrack);
                            await player.skip();
                            responseMessage = `⏮ رجعنا للأغنية السابقة.`;
                        } else {
                            await player.seek(0);
                            const liked = await likes.isLiked(requesterId || interaction.user.id, player.currentTrack).catch(() => false);
                            await editPanel(liked);
                            responseMessage = `⏮ تم إعادة الأغنية من البداية.`;
                        }
                    }

                    if (interaction.customId === 'stop') {
                        await finalizePlayerUi(player);
                        await bumpQueueVersion(player, 'button_stop');
                        await updatePlaybackVoiceStatus(TrueMusic, tokenObj, player, null);
                        await player.destroy();
                        responseMessage = '⏹ تم إيقاف التشغيل.';
                    }

                    if (interaction.customId === 'queue_btn') {
                        if (!player.currentTrack) {
                            responseMessage = 'لا يوجد شيء يعمل الآن.';
                        } else {
                            const qItemsPerPage = 8;
                            let qPage = 0;
                            const refId = interaction.id;
                            const queueMsg = await interaction.followUp({
                                ...musicPayload(tokenObj, {
                                    title: `${interaction.guild.name} Queue`,
                                    description: buildQueueDescription(player, qPage, qItemsPerPage),
                                    components: buildQueueComponents(player, tokenObj, refId, qPage, qItemsPerPage),
                                }),
                            }).catch(() => null);
                            if (queueMsg) {
                                let qVersion = ensurePlayerData(player).queueVersion;
                                registerQueuePanel(player, queueMsg, qVersion);
                                const qFilter = i => i.customId.startsWith(`queue_${refId}_`);
                                const qCollector = queueMsg.createMessageComponentCollector({ filter: qFilter, time: 120000 });
                                const renderQ = (i, title = `${interaction.guild.name} Queue`) => i.update(musicPayload(tokenObj, {
                                    title,
                                    description: buildQueueDescription(player, qPage, qItemsPerPage),
                                    components: buildQueueComponents(player, tokenObj, refId, qPage, qItemsPerPage),
                                }));
                                qCollector.on('collect', async i => {
                                    if ((player.data?.queueVersion || 0) !== qVersion) {
                                        qCollector.stop('stale');
                                        return i.update({ components: disableComponents(queueMsg.components) }).catch(() => {});
                                    }
                                    if (i.customId === `queue_${refId}_prev`) { if (qPage > 0) qPage--; return renderQ(i); }
                                    if (i.customId === `queue_${refId}_next`) { const tot = Math.max(1, Math.ceil(player.queue.length / qItemsPerPage)); if (qPage < tot - 1) qPage++; return renderQ(i); }
                                    if (i.customId === `queue_${refId}_clear`) { player.queue.clear(); await bumpQueueVersion(player, 'queue_clear'); qCollector.stop('cleared'); return i.update(musicPayload(tokenObj, { title: 'Queue Cleared', description: 'تم حذف قائمة الانتظار بالكامل.' })); }
                                    if (i.customId === `queue_${refId}_close`) { qCollector.stop('closed'); return i.update({ components: disableComponents(queueMsg.components) }); }
                                    if (i.customId === `queue_${refId}_reorder`) {
                                        if (typeof player.queue.splice !== 'function' || typeof player.queue.unshift !== 'function') return i.reply({ content: 'تعذر ترتيب الطابور.', ephemeral: true });
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
                            setTimeout(() => interaction.deleteReply().catch(() => {}), 8000);
                            return;
                        }
                    }

                            if (interaction.customId === 'like') {
                                const currentTrack = player.currentTrack;
                                if (!currentTrack) {
                                    responseMessage = 'لا يوجد شيء يعمل الآن.';
                                } else {
                                    try {
                                        const { liked } = await likes.toggle(interaction.user.id, currentTrack);
                                        responseMessage = liked
                                            ? `تم حفظ **${currentTrack.info.title || 'الأغنية'}** في لايكاتك.`
                                            : `تم حذف **${currentTrack.info.title || 'الأغنية'}** من لايكاتك.`;
                                        if (!requesterId || interaction.user.id === requesterId) {
                                            await editPanel(liked);
                                        }
                                    } catch (err) {
                                        console.error('[Likes] toggle failed:', err?.message || err);
                                        responseMessage = 'تعذر حفظ اللايك الآن.';
                            }
                        }
                    }

                    await interaction.editReply(responseMessage || 'تم.');
                    setTimeout(() => interaction.deleteReply().catch(() => {}), 8000);
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
