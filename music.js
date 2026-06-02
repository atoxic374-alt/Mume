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
    ComponentType
} = require('discord.js');

const fs = require('fs');
const { Poru } = require('poru');

const { owners, TwitchUrl, statuses } = require(`${process.cwd()}/config`);
const { getVoiceConnection } = require('@discordjs/voice');
const duratiform = require('duratiform');

const store = require('./utils/store');
const likes = require('./utils/likes');
const { getDisplay } = require('./utils/display');
const MUSIC_EMOJIS = require('./utils/musicEmojis');
const { getEmbedColor, refreshEmbedColor } = require('./utils/embedColor');

const runningBots = new Collection();
const botLastActivity = new Map();
const tempData = new Collection();
tempData.set("bots", []);
const collection = new Collection();

const FILTER_NAMES = {
    clear: 'بدون فلتر',
    bassboost: 'Bass Boost',
    nightcore: 'Nightcore',
    '8d': '8D Audio',
    vaporwave: 'Vaporwave',
    karaoke: 'Karaoke',
    tremolo: 'Tremolo',
    vibrato: 'Vibrato',
    lowpass: 'Low Pass',
    channelmix: 'Channel Mix',
};

const FILTER_OPTIONS = [
    { label: 'إيقاف الفلاتر', value: 'clear', description: 'إزالة جميع الفلاتر', emoji: '⬛' },
    { label: 'Bass Boost', value: 'bassboost', description: 'جهير أوضح بدون تشويه', emoji: '🔊' },
    { label: 'Nightcore', value: 'nightcore', description: 'سرعة ونبرة أعلى', emoji: '🌙' },
    { label: '8D Audio', value: '8d', description: 'حركة صوتية خفيفة', emoji: '🌀' },
    { label: 'Vaporwave', value: 'vaporwave', description: 'أبطأ وأنعم', emoji: '🌊' },
    { label: 'Karaoke', value: 'karaoke', description: 'تقليل الصوت البشري', emoji: '🎤' },
    { label: 'Tremolo', value: 'tremolo', description: 'اهتزاز مستوى الصوت', emoji: '〰️' },
    { label: 'Vibrato', value: 'vibrato', description: 'اهتزاز النبرة', emoji: '📳' },
    { label: 'Low Pass', value: 'lowpass', description: 'صوت أنعم', emoji: '🔉' },
    { label: 'Channel Mix', value: 'channelmix', description: 'مزج خفيف للقنوات', emoji: '🔀' },
];

const BASE_FILTERS = {
    volume: 1.0,
    equalizer: [],
    karaoke: undefined,
    timescale: undefined,
    tremolo: undefined,
    vibrato: undefined,
    rotation: undefined,
    distortion: undefined,
    channelMix: undefined,
    lowPass: undefined,
};

const FILTER_PRESETS = {
    clear: {},
    bassboost: {
        equalizer: [
            { band: 0, gain: 0.16 }, { band: 1, gain: 0.14 }, { band: 2, gain: 0.10 },
            { band: 3, gain: 0.06 }, { band: 4, gain: 0.03 }, { band: 5, gain: 0.00 },
            { band: 6, gain: -0.02 },
        ],
    },
    nightcore: { timescale: { speed: 1.12, pitch: 1.10, rate: 1.0 } },
    '8d': { rotation: { rotationHz: 0.14 } },
    vaporwave: { timescale: { speed: 0.92, pitch: 0.90, rate: 1.0 } },
    karaoke: { karaoke: { level: 0.35, monoLevel: 0.35, filterBand: 220.0, filterWidth: 90.0 } },
    tremolo: { tremolo: { frequency: 3.5, depth: 0.25 } },
    vibrato: { vibrato: { frequency: 4.5, depth: 0.25 } },
    lowpass: { lowPass: { smoothing: 5.0 } },
    channelmix: { channelMix: { leftToLeft: 0.85, leftToRight: 0.15, rightToLeft: 0.15, rightToRight: 0.85 } },
};

function displaySettings(tokenObj) {
    const saved = tokenObj?.code ? getDisplay(tokenObj.code) : {};
    return {
        buttons: tokenObj?.buttons ? tokenObj.buttons === 'on' : saved.buttons !== false,
        embeds: tokenObj?.embeds ? tokenObj.embeds === 'on' : saved.embeds !== false,
        platform: tokenObj?.source || saved.platform || 'ytsearch',
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

function createMusicControlButtons(liked = false) {
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('loop')
                .setEmoji(MUSIC_EMOJIS.loop)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('volume_up')
                .setEmoji(MUSIC_EMOJIS.volumeUp)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('pause')
                .setEmoji(MUSIC_EMOJIS.pause)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('volume_down')
                .setEmoji(MUSIC_EMOJIS.volumeDown)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('skip')
                .setEmoji(MUSIC_EMOJIS.skip)
                .setStyle(ButtonStyle.Secondary),
        );
    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('like')
                .setLabel(liked ? '💔 إلغاء اللايك' : '❤️ لايك')
                .setStyle(liked ? ButtonStyle.Danger : ButtonStyle.Secondary),
        );
    return [row1, row2];
}

function buildMusicComponents({ liked = false, artistTracks = [], selectedFilter = 'clear', selectedArtistIndex = null, showControls = true }) {
    const rows = [];
    if (showControls) rows.push(...createMusicControlButtons(liked));

    if (showControls && artistTracks.length > 0) {
        const artistMenu = new StringSelectMenuBuilder()
            .setCustomId('np_artist')
            .setPlaceholder('أفضل 5 أغاني لنفس الفنان')
            .addOptions(artistTracks.slice(0, 5).map((t, i) => ({
                label: (t.info.title || 'Unknown').slice(0, 99),
                value: String(i),
                description: `${shortDuration(t.info.length)} · ${(t.info.author || '').slice(0, 50)}`.slice(0, 99),
                emoji: ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i],
                default: selectedArtistIndex === i,
            })));
        rows.push(new ActionRowBuilder().addComponents(artistMenu));
    }

    if (showControls) {
        const filterMenu = new StringSelectMenuBuilder()
            .setCustomId('np_filter')
            .setPlaceholder('الفلاتر الصوتية')
            .addOptions(FILTER_OPTIONS.map(option => ({
                ...option,
                default: option.value === selectedFilter,
            })));
        rows.push(new ActionRowBuilder().addComponents(filterMenu));
    }

    return rows.slice(0, 5);
}

function buildNowPlayingPayload(TrueMusic, tokenObj, track, requester, options = {}) {
    const settings = displaySettings(tokenObj);
    const title = track?.info?.title || 'Unknown track';
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
            .setColor(getEmbedColor(TrueMusic))
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

        return {
            content: `🎶 **${TrueMusic.user?.displayName || TrueMusic.user?.username || 'Music'}**`,
            embeds: [embed],
            files: ['./assets/image/icons/NowPlaying.png'],
            components,
        };
    }

    return {
        content: `🎶 Now playing: **${title}** • \`${duration}\` • ${requesterName}`,
        embeds: [],
        components,
    };
}

function compactMusicText({ title, description, fields = [] }) {
    const parts = [];
    if (title) parts.push(`**${title}**`);
    if (description) parts.push(description);
    fields.forEach(field => {
        if (field?.name && field?.value) parts.push(`**${field.name}:** ${field.value}`);
    });
    return parts.join('\n') || 'Done.';
}

function musicPayload(tokenObj, { title, description, fields = [], components = [], color = undefined, thumbnail = null, files = [] }) {
    const settings = displaySettings(tokenObj);
    const colorSource = tokenObj?.token ? runningBots.get(tokenObj.token) : null;
    const payload = {
        components: settings.buttons && components.length ? components : [],
    };

    if (settings.embeds) {
        const embed = new EmbedBuilder().setColor(getEmbedColor(colorSource, color));
        if (title) embed.setTitle(title);
        if (description) embed.setDescription(description);
        if (thumbnail) embed.setThumbnail(thumbnail);
        if (fields.length) embed.addFields(fields);
        payload.embeds = [embed];
        if (files.length) payload.files = files;
    } else {
        payload.content = compactMusicText({ title, description, fields });
        payload.embeds = [];
    }

    return payload;
}

function platformDisplay(source) {
    const names = {
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
    return components.map(row => {
        const next = new ActionRowBuilder();
        next.addComponents(row.components.map(component => {
            const type = component.data?.type || component.type;
            if (type === ComponentType.Button) return ButtonBuilder.from(component).setDisabled(true);
            if (type === ComponentType.StringSelect) return StringSelectMenuBuilder.from(component).setDisabled(true);
            return component;
        }));
        return next;
    });
}

async function finalizePlayerUi(player) {
    const msg = player?.data?.nowPlayingMessage;
    if (msg?.components?.length) {
        await msg.edit({ components: disableComponents(msg.components) }).catch(() => {});
    }
    if (player?.data) {
        player.data.nowPlayingMessage = null;
        player.data.nowPlayingToken = null;
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

        TrueMusic.poru.on('nodeConnect', (node) => {
            const name = node.options.name || node.options.host;
            const prev = store.getNodes().get(name) || {};
            store.setNode(name, {
                status: 'live',
                connectedAt: Date.now(),
                reconnects: prev.reconnects ?? 0,
            });

            let newData = tempData.get("bots");
            newData.push(TrueMusic);
            tempData.set("bots", newData);

            let botNumber = newData.indexOf(TrueMusic) + 1;
            console.log(`\x1b[33m${botNumber}\x1b[0m | ${TrueMusic.user?.username || 'Unknown'} | Connected \x1b[32m${node.options.host}\x1b[0m`);
        });

        TrueMusic.poru.on('nodeDisconnect', (node) => {
            const name = node.options.name || node.options.host;
            const prev = store.getNodes().get(name) || {};
            store.setNode(name, { status: 'offline', reconnects: prev.reconnects ?? 0 });
            console.log(`\x1b[33m[Poru] Node reconnecting: ${name}\x1b[0m`);
        });

        TrueMusic.poru.on('nodeError', (node, err) => {
            const name = node.options.name || node.options.host;
            const prev = store.getNodes().get(name) || {};
            store.setNode(name, { status: 'offline', reconnects: (prev.reconnects ?? 0) + 1 });
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
                const player = TrueMusic.poru.players.get(guild.id);
                if (player) player.destroy();

                await TrueMusic.poru.createConnection({
                    guildId: guild.id,
                    voiceChannel: targetChannelId,
                    textChannel: tokenObj.chat || targetChannelId,
                    deaf: true,
                    group: tokenObj.token,
                });
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
                if (player.isPlaying) {
                    player.stop();
                }
            });

            let int = setInterval(async () => {
                if (!TrueMusic.readyAt) return;

                let dataaa = store.get('tokens') || [];

                let tokenObj = dataaa.find((tokenBot) => tokenBot.token === token);

                if (!tokenObj) {
                    await TrueMusic.destroy().catch(() => 0);
                    runningBots.delete(token);
                    return clearInterval(int);
                }

                if (tokenObj.awaitingReplacement || tokenObj.expireDate <= Date.now()) {
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
                                const player = TrueMusic.poru.players.get(guild.id);
                                if (player) player.destroy();

                                if (!TrueMusic.readyAt) return;

                                try {
                                    await TrueMusic.poru.createConnection({
                                        guildId: guild.id,
                                        voiceChannel: musicChannel.id,
                                        textChannel: tokenObj.chat || musicChannel.id,
                                        deaf: true,
                                        group: tokenObj.token,
                                    });
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
    status: 'live',
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



    TrueMusic.poru.on('trackEnd', async (player) => {
      await finalizePlayerUi(player);
	    });

	    TrueMusic.poru.on("queueEnd", async (player) => {
	      await finalizePlayerUi(player);
	      if (!player?.data?.autoPlay || player.data.autoPlay === false) {
	        if (player.isPlaying) player.stop();
	        player.queue.clear();
	        player.data.autoPlay = false;
        return;
      }
      const currentTrack = player.currentTrack;
      if (!currentTrack) {
        await finalizePlayerUi(player);
        if (player.isPlaying) player.stop();
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
        if (player.isPlaying) player.stop();
        player.queue.clear();
        player.data.autoPlay = false;
        return;
      }

      const nextTrack = res.tracks.find(track => track.info.uri !== currentTrack.info.uri);

      if (!nextTrack) {
        await finalizePlayerUi(player);
        if (player.isPlaying) player.stop();
        player.queue.clear();
        player.data.autoPlay = false;
        return;
      }

      nextTrack.info.requester = currentTrack.info.requester;
      player.queue.add(nextTrack);

      if (!player.isPlaying && !player.paused) {
        player.play();
      }
    });



    // ── Helper: apply audio filter preset ──────────────────────────────
    async function applyFilter(player, name) {
        if (!player?.node?.rest) throw new Error('player is not connected');
        const selected = FILTER_PRESETS[name] ? name : 'clear';
        const filters = { ...BASE_FILTERS, ...FILTER_PRESETS[selected] };

        await player.node.rest.updatePlayer({
            guildId: player.guildId,
            data: { filters },
        });

        if (player.filters) {
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

        player.data.activeFilter = selected;
        return selected;
    }

    // ── trackStart: always publish the normal now-playing panel ──────────
    TrueMusic.poru.on('trackStart', async (player, track) => {
        player.data.lastTrack = track;

        const requester = track.info?.requester;
        if (!requester) return;

        const tc = player.textChannel;
        let channel;
        if (typeof tc === 'string') {
            channel = TrueMusic.channels.cache.get(tc);
        } else if (tc && typeof tc === 'object') {
            channel = TrueMusic.channels.cache.get(tc.id) || tc;
        }
        if (!channel) return;

        const tokenObj2 = (store.get('tokens') || []).find(t => t.token === token);
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
        };

        const payload = buildNowPlayingPayload(TrueMusic, tokenObj2, track, requester, {
            liked: alreadyLiked,
            selectedFilter,
        });

        const msg = await channel.send(payload).catch(() => null);
        if (!msg) return;

        player.data.nowPlayingMessage = msg;
        player.data.nowPlayingToken = track?.track || track?.info?.identifier || track?.info?.title || null;

        const artistName = track.info?.author;
        if (!artistName) return;

        try {
            const source = displaySettings(tokenObj2).platform;
            const res = await TrueMusic.poru.resolve({ query: artistName, source });
            const artistTracks = (res?.tracks || [])
                .filter(t => (t.info.uri || t.info.identifier) !== (track.info.uri || track.info.identifier))
                .slice(0, 5);
            player.data.ui.artistTracks = artistTracks;
            if (player.data.nowPlayingMessage?.id === msg.id && player.currentTrack === track) {
                const components = buildMusicComponents({
                    liked: alreadyLiked,
                    artistTracks,
                    selectedFilter: player.data.ui.selectedFilter,
                    selectedArtistIndex: player.data.ui.selectedArtistIndex,
                    showControls: displaySettings(tokenObj2).buttons,
                });
                await msg.edit({ components }).catch(() => {});
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

		            let memberVoice = message.member?.voice?.channel;
	            if (!memberVoice) return;

            let clientVoice = message.guild.members?.me?.voice?.channel;
            if (!clientVoice || memberVoice.id !== clientVoice.id) return;

            const prefix = tokenObj.prefix || "";

            if (tokenObj.chat) {
                const allowedTextChannels = new Set([tokenObj.chat, tokenObj.channel].filter(Boolean));
                if (!allowedTextChannels.has(message.channel.id)) return;
            }

            const rawNoPrefix = message.content.trim();
            const noPrefixName = rawNoPrefix.split(/ +/)[0]?.toLowerCase();
            if (['mylikes', 'likes', 'liked', 'لايكاتي'].includes(noPrefixName)) {
                const allowedMyLikesChannels = new Set([tokenObj.chat, tokenObj.channel].filter(Boolean));
                if (allowedMyLikesChannels.size && !allowedMyLikesChannels.has(message.channel.id)) return;
                const myLikesCommand = require('./commands/Control/mylikes');
                const myLikesArgs = rawNoPrefix.split(/ +/).slice(1);
                return myLikesCommand.execute(TrueMusic, message, myLikesArgs);
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

                let player = TrueMusic.poru.players.get(message.guild.id);
                if (player) player.textChannel = message.channel.id;

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
                    });
                  player.autoplay = false;
                
                }

                try {
	                    const searchSource = displaySettings(tokenObj).platform;
                    const res = await TrueMusic.poru.resolve({ query: song, source: searchSource });

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
                    } else {
                        const track = res.tracks[0];
                        track.info.requester = message.author;
                        player.queue.add(track);

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

	                    if (!player.isPlaying && !player.isPaused) {
	                        await player.play();
	                    }

                } catch (error) {
                    console.error('Error searching for song:', error.message);
                    message.reply(musicPayload(tokenObj, {
                        title: 'Search Error',
                        description: 'An error occurred while searching for the song.',
                        thumbnail: 'attachment://error.png',
                        files: ['./assets/image/icons/error.png'],
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

                const current = player.currentTrack.info;
                const loopMode = player.loop === 'TRACK' ? 'ON' : 'OFF';
                const volume = player.volume || 100;
                const currentTime = player.position;
                const totalTime = current.length;

                if (totalTime <= 0) {
                    console.error('Invalid total time');
                    return;
                }

                const progressBarLength = 20;
                const progress = Math.floor((currentTime / totalTime) * progressBarLength);
                const validProgress = Math.max(0, Math.min(progress, progressBarLength));

                const progressBar = '─'.repeat(validProgress) + '🔴' + '─'.repeat(progressBarLength - validProgress);

                return message.channel.send(musicPayload(tokenObj, {
                    title: 'Now Playing',
                    description:
                        `**Title:** ${current.title}\n` +
                        `**Loop:** \`${loopMode}\` | **Volume:** \`${volume}\`\n` +
                        `**Requester:** \`${message.author.tag}\`\n\n` +
                        `\`\`\`► ${progressBar}\`\`\`\n` +
                        `\`[${duratiform.format(currentTime, 'mm:ss')} / ${duratiform.format(totalTime, 'mm:ss')}]\``,
                }));
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

                const nowPlayingTrack = player.currentTrack;
                if (!nowPlayingTrack) {
                    return message.reply(musicPayload(tokenObj, {
                        title: 'Queue',
                        description: 'No song is currently playing.',
                        thumbnail: 'attachment://Error.png',
                        files: ['./assets/image/icons/Error.png'],
                    }));
                }

                const itemsPerPage = 8;
                let page = 0;

                const trimTitle = (value, max = 66) => {
                    const text = value || 'Unknown';
                    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
                };
                const duration = (track) => shortDuration(track?.info?.length);
                const totalPages = () => Math.max(1, Math.ceil(player.queue.length / itemsPerPage));
                const pageTracks = () => player.queue.slice(page * itemsPerPage, (page + 1) * itemsPerPage);

                const buildQueueDescription = () => {
                    const currentTitle = trimTitle(nowPlayingTrack.info.title, 80);
                    const currentUrl = nowPlayingTrack.info.uri;
                    const currentLine = currentUrl
                        ? `> **[${currentTitle}](${currentUrl})**  ·  \`${duration(nowPlayingTrack)}\``
                        : `> **${currentTitle}**  ·  \`${duration(nowPlayingTrack)}\``;
                    const queuedLines = pageTracks().map((track, i) => {
                        const absolute = page * itemsPerPage + i + 1;
                        const title = trimTitle(track.info.title);
                        const url = track.info.uri;
                        const label = url ? `**[${title}](${url})**` : `**${title}**`;
                        return `\`${String(absolute).padStart(2, '0')}\`  ${label}\n     \`${duration(track)}\`  ·  ${track.info.author || 'Unknown'}`;
                    });

                    return [
                        '**Now Playing**',
                        currentLine,
                        '',
                        `**Upcoming Songs**  ·  \`${player.queue.length}\` tracks  ·  page **${page + 1}/${totalPages()}**`,
                        queuedLines.length ? queuedLines.join('\n\n') : '> No queued songs.',
                    ].join('\n');
                };

                const buildQueueComponents = () => {
                    if (!displaySettings(tokenObj).buttons || player.queue.length === 0) return [];

                    const tracks = pageTracks();
                    const rows = [];
                    if (tracks.length) {
                        rows.push(new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId(`queue_${message.id}_reorder`)
                                .setPlaceholder('Select tracks to move to top')
                                .setMinValues(1)
                                .setMaxValues(Math.min(tracks.length, 25))
                                .addOptions(tracks.map((track, i) => {
                                    const absolute = page * itemsPerPage + i;
                                    return {
                                        label: trimTitle(`${absolute + 1}. ${track.info.title}`, 99),
                                        value: String(absolute),
                                        description: `${duration(track)} · ${(track.info.author || 'Unknown').slice(0, 70)}`.slice(0, 99),
                                    };
                                }))
                        ));
                    }

                    rows.push(new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`queue_${message.id}_prev`)
                            .setEmoji(MUSIC_EMOJIS.pagePrev)
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(page === 0),
                        new ButtonBuilder()
                            .setCustomId(`queue_${message.id}_next`)
                            .setEmoji(MUSIC_EMOJIS.pageNext)
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(page >= totalPages() - 1),
                        new ButtonBuilder()
                            .setCustomId(`queue_${message.id}_clear`)
                            .setLabel('Clear Queue')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`queue_${message.id}_close`)
                            .setLabel('Close')
                            .setStyle(ButtonStyle.Secondary)
                    ));

                    return rows;
                };

                const queueMessage = await message.reply(musicPayload(tokenObj, {
                    title: `${message.guild.name} Queue`,
                    description: buildQueueDescription(),
                    components: buildQueueComponents(),
                })).catch(console.error);

                if (!queueMessage || !displaySettings(tokenObj).buttons) return;

                const filter = interaction => interaction.user.id === message.author.id && interaction.customId.startsWith(`queue_${message.id}_`);
                const collector = queueMessage.createMessageComponentCollector({ filter, time: 120000 });

                const renderQueue = (interaction, title = `${message.guild.name} Queue`) => interaction.update(musicPayload(tokenObj, {
                    title,
                    description: buildQueueDescription(),
                    components: buildQueueComponents(),
                }));

                collector.on('collect', async interaction => {
                    if (interaction.customId === `queue_${message.id}_prev`) {
                        if (page > 0) page--;
                        return renderQueue(interaction);
                    }

                    if (interaction.customId === `queue_${message.id}_next`) {
                        if (page < totalPages() - 1) page++;
                        return renderQueue(interaction);
                    }

                    if (interaction.customId === `queue_${message.id}_clear`) {
                        player.queue.clear();
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
                        return renderQueue(interaction, 'Queue Updated');
                    }
                });

                collector.on('end', (_, reason) => {
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
                            .setPlaceholder('Choose search platform')
                            .addOptions(platformOptions)
                    ),
                    controlRow(false),
                ];

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
                    controlRow(true, true),
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
                            description: `يتم البحث في ${platformDisplay(selectedSource)} عن **${searchQuery}**...`,
                        }));

                        try {
                            const result = await TrueMusic.poru.resolve({ query: searchQuery, source: selectedSource });
                            allSearchTracks = result?.tracks || [];
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
                                description: `النتائج من ${platformDisplay(selectedSource)}.\nاختر أغنية، أو اضغط **Continue Search** لنتائج أخرى.`,
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
                            description: `نتائج جديدة من ${platformDisplay(selectedSource)}.\nتم استبدال القائمة السابقة.`,
                            components: buildTrackRows(currentTracks),
                        }));
                    }

                    if (interaction.customId === `${searchId}_song`) {
                        await interaction.deferUpdate().catch(() => {});
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
                        if (player) player.textChannel = message.channel.id;
                        if (!player) {
                            player = await TrueMusic.poru.createConnection({
                                guildId: message.guild.id,
                                voiceChannel: message.member.voice.channel.id,
                                textChannel: message.channel.id,
                                deaf: true,
                            });
                        }

                        selectedTrack.info.requester = message.author;
                        player.queue.add(selectedTrack);

                        completed = true;
                        collector.stop('selected');

                        await sourceMessage.edit(musicPayload(tokenObj, {
                            title: player.isPlaying ? 'Add Song' : 'Playing',
                            description: `**${selectedTrack.info.title}**\nBy **${message.author.displayName}**`,
                        }));

                        if (!player.isPlaying && !player.isPaused) await player.play();
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
	            const musicButtons = new Set(['loop', 'pause', 'volume_down', 'volume_up', 'skip', 'like']);
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

	            const tokenObj = (store.get('tokens') || []).find(t => t.token === token);
	            const ui = player.data.ui || {};
	            const requesterId = ui.requesterId || player.currentTrack?.info?.requester?.id || player.currentTrack?.info?.requester;
	            const editPanel = async (liked = false, targetInteraction = null) => {
	                const components = buildMusicComponents({
	                    liked,
	                    artistTracks: ui.artistTracks || [],
	                    selectedFilter: ui.selectedFilter || player.data.activeFilter || 'clear',
	                    selectedArtistIndex: ui.selectedArtistIndex ?? null,
	                    showControls: displaySettings(tokenObj).buttons,
	                });
	                if (targetInteraction && !targetInteraction.deferred && !targetInteraction.replied) {
	                    return targetInteraction.update({ components }).catch(() => {});
	                }
	                await interaction.message?.edit({ components }).catch(() => {});
	            };

	            if (isMusicMenu) {
	                if (interaction.customId === 'np_artist') {
	                    if (ui.requesterId && interaction.user.id !== ui.requesterId) {
	                        return replyEphemeral('هذه القائمة لصاحب الطلب فقط.');
	                    }

	                    const selectedIndex = Number(interaction.values[0]);
	                    const selectedTrack = ui.artistTracks?.[selectedIndex];
	                    if (!selectedTrack) return replyEphemeral('لم أجد الأغنية المختارة.');

	                    selectedTrack.info.requester = interaction.user;
	                    player.queue.add(selectedTrack);
	                    ui.selectedArtistIndex = selectedIndex;
	                    player.data.ui = ui;

	                    const liked = await likes.isLiked(requesterId || interaction.user.id, player.currentTrack).catch(() => false);
	                    await editPanel(liked, interaction);

	                    if (!player.isPlaying && !player.isPaused) {
	                        await player.play();
	                    }
	                    return replyEphemeral(`تمت إضافة **${selectedTrack.info.title || 'الأغنية'}** للطابور.`);
	                }

	                if (interaction.customId === 'np_filter') {
	                    await interaction.deferUpdate().catch(() => {});
	                    const filterName = interaction.values[0];
	                    try {
	                        const applied = await applyFilter(player, filterName);
	                        ui.selectedFilter = applied;
	                        player.data.ui = ui;
	                        await editPanel(await likes.isLiked(requesterId || interaction.user.id, player.currentTrack).catch(() => false));
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
	                    await player.destroy();
	                    responseMessage = `تم التخطي: **${currentTrack.info.title || 'الأغنية'}**`;
	                } else {
	                    await finalizePlayerUi(player);
	                    await player.skip();
	                    responseMessage = `تم التخطي: **${currentTrack.info.title || 'الأغنية'}**`;
	                }
	            }

	            if (interaction.customId === 'like') {
	                const currentTrack = player.currentTrack;
	                if (!currentTrack) {
	                    responseMessage = 'لا يوجد شيء يعمل الآن.';
	                } else if (requesterId && interaction.user.id !== requesterId) {
	                    responseMessage = 'اللايك متاح فقط لصاحب تشغيل الأغنية.';
	                } else {
	                    try {
	                        const { liked } = await likes.toggle(requesterId || interaction.user.id, currentTrack);
	                        responseMessage = liked
	                            ? `تم حفظ **${currentTrack.info.title || 'الأغنية'}** في لايكاتك.`
	                            : `تم حذف **${currentTrack.info.title || 'الأغنية'}** من لايكاتك.`;
	                        await editPanel(liked);
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
