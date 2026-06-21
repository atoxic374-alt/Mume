const axios = require('axios');
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    ComponentType,
    ActivityType,
    MessageFlags
} = require('discord.js');
const { owners, TwitchUrl } = require('../../config');
const { runningBots, botLastActivity, restorePoruNodes } = require('../../music');
const { getDisplay, setDisplay } = require('../../utils/display');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const MUSIC_EMOJIS = require('../../utils/musicEmojis');
const { getEmbedColor, refreshEmbedColor } = require('../../utils/embedColor');

const SETTINGS_PROCESS_CONCURRENCY = Math.max(1, Number(process.env.SETTINGS_PROCESS_CONCURRENCY || 16));
const SETTINGS_PROFILE_CONCURRENCY = Math.max(1, Number(process.env.SETTINGS_PROFILE_CONCURRENCY || 4));
const SETTINGS_IMAGE_CONCURRENCY  = Math.max(1, Number(process.env.SETTINGS_IMAGE_CONCURRENCY  || 10));
const SETTINGS_NAME_CONCURRENCY   = 1; // sequential — Discord username rate-limit is per-bot but global bucket is strict
const SETTINGS_MAX_RETRIES        = 4;
const SETTINGS_MAX_WAIT_MS        = 90_000;
const SETTINGS_DISTRIBUTION_BATCH_SIZE = Math.max(1, Number(process.env.SETTINGS_DISTRIBUTION_BATCH_SIZE || 12));

/** Extract retry-after ms from a discord.js or axios 429 error. Returns null if not a rate-limit. */
function stgExtractRetryAfterMs(err) {
    const djsRa = err?.rawError?.retry_after ?? err?.retryAfter;
    if (djsRa != null) return Math.min(Math.ceil(Number(djsRa) * 1000) + 1500, SETTINGS_MAX_WAIT_MS);
    if (err?.response?.status === 429) {
        const ra = err?.response?.data?.retry_after
            ?? err?.response?.headers?.['retry-after']
            ?? err?.response?.headers?.['x-ratelimit-reset-after'];
        return Math.min(Math.ceil(Number(ra ?? 5) * 1000) + 1500, SETTINGS_MAX_WAIT_MS);
    }
    if (err?.status === 429 || err?.httpStatus === 429) {
        const ra = String(err?.message || '').match(/(\d+(?:\.\d+)?)\s*second/i)?.[1];
        return ra ? Math.min(Math.ceil(parseFloat(ra) * 1000) + 1500, SETTINGS_MAX_WAIT_MS) : 5_000;
    }
    return null;
}

/** Retry an async fn up to maxRetries. On 429 waits retry_after; otherwise exponential backoff. */
async function stgWithRetry(fn, maxRetries = SETTINGS_MAX_RETRIES) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try { return await fn(); } catch (err) {
            lastErr = err;
            if (attempt >= maxRetries) break;
            const waitMs = stgExtractRetryAfterMs(err) ?? Math.min(1500 * attempt, 10_000);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
    throw lastErr;
}
const SETTINGS_IMAGE_TIMEOUT_MS = Math.max(3000, Number(process.env.SETTINGS_IMAGE_TIMEOUT_MS || 10000));
const SETTINGS_IMAGE_MAX_BYTES = Math.max(256 * 1024, Number(process.env.SETTINGS_IMAGE_MAX_BYTES || 8 * 1024 * 1024));
const SETTINGS_SELECT_PAGE_SIZE = 25;
const SETTINGS_EMOJI = {
    appearance: MUSIC_EMOJIS.stg.appearance,
    rooms:      MUSIC_EMOJIS.stg.rooms,
    display:    MUSIC_EMOJIS.stg.display,
    platform:   MUSIC_EMOJIS.stg.platform,
    owners:     MUSIC_EMOJIS.stg.owners,
    name:       MUSIC_EMOJIS.stg.appearance,
    avatar:     MUSIC_EMOJIS.stg.appearance,
    banner:     MUSIC_EMOJIS.stg.appearance,
    status:     MUSIC_EMOJIS.stg.appearance,
    voiceStatus:   MUSIC_EMOJIS.stg.rooms,
    distribute:    MUSIC_EMOJIS.stg.rooms,
    moveIdle:      MUSIC_EMOJIS.stg.rooms,
    backToVoice:   MUSIC_EMOJIS.stg.rooms,
    toggleSetting: MUSIC_EMOJIS.stg.rooms,
    commandChat:   MUSIC_EMOJIS.stg.rooms,
    statusEmoji:   MUSIC_EMOJIS.stg.rooms,
    pinRoom:       MUSIC_EMOJIS.stg.rooms,
    allLinks:      MUSIC_EMOJIS.stg.rooms,
    outsideServer: MUSIC_EMOJIS.stg.rooms,
    addOwner:      MUSIC_EMOJIS.stg.owners,
    removeOwner:   MUSIC_EMOJIS.stg.owners,
    toggleButtons: MUSIC_EMOJIS.stg.display,
    toggleEmbeds:  MUSIC_EMOJIS.stg.display,
};
const activeSmartDistributions = new Set();
const activeSettingsProcesses = new Set();

function resolveSettingsEmoji(client, emojiId) {
    const id = String(emojiId || '');
    if (!id) return null;
    const emoji = client?.application?.emojis?.cache?.get?.(id) || client?.emojis?.cache?.get?.(id);
    if (!emoji || emoji.available === false) return null;
    return {
        id: emoji.id,
        name: emoji.name || undefined,
        animated: emoji.animated === true,
    };
}

function resolveRawEmoji(client, raw) {
    if (!raw) return null;
    let id = null;
    let name = null;
    let animated = false;
    if (typeof raw === 'string') {
        const match = raw.match(/^<(a?):([A-Za-z0-9_~.\-]+):(\d{17,20})>$/);
        if (match) {
            animated = match[1] === 'a';
            name = match[2];
            id = match[3];
        } else if (/^\d{17,20}$/.test(raw.trim())) {
            id = raw.trim();
        }
    } else if (raw && typeof raw === 'object') {
        id = raw.id ? String(raw.id) : null;
        name = raw.name ? String(raw.name) : null;
        animated = raw.animated === true;
    }
    if (!id || !/^\d{17,20}$/.test(id)) return null;
    const cached = client?.application?.emojis?.cache?.get?.(id) || client?.emojis?.cache?.get?.(id);
    if (cached) {
        if (cached.available === false) return null;
        return { id: String(cached.id), name: String(cached.name || name || 'emoji'), animated: cached.animated === true };
    }
    return null;
}

function settingsOption(client, option, emojiData) {
    const emoji = MUSIC_EMOJIS.componentEmoji(emojiData, client);
    return emoji ? { ...option, emoji } : option;
}

function setSettingsEmoji(client, component, emojiData) {
    const emoji = MUSIC_EMOJIS.componentEmoji(emojiData, client);
    if (emoji) component.setEmoji(emoji);
    return component;
}

function assertHttpUrl(value, label = 'URL') {
    let parsed;
    try {
        parsed = new URL(String(value || '').trim());
    } catch {
        throw new Error(`${label} غير صحيح.`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${label} يجب أن يبدأ بـ http أو https.`);
    }
    return parsed.toString();
}

async function fetchImageDataUri(rawUrl, label = 'Image') {
    const url = assertHttpUrl(rawUrl, label);
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: SETTINGS_IMAGE_TIMEOUT_MS,
        maxContentLength: SETTINGS_IMAGE_MAX_BYTES,
        validateStatus: status => status >= 200 && status < 300,
    });
    const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
        throw new Error(`${label} ليس ملف صورة.`);
    }
    const buffer = Buffer.from(response.data);
    if (buffer.length > SETTINGS_IMAGE_MAX_BYTES) {
        throw new Error(`${label} كبير جداً. الحد ${Math.round(SETTINGS_IMAGE_MAX_BYTES / 1024 / 1024)}MB.`);
    }
    return `data:${contentType};base64,${buffer.toString('base64')}`;
}

// ── Wait for a bot's Poru node to connect (up to timeoutMs) ──────────────────
// Fixes "No nodes are available" for new bots whose Lavalink connection
// hasn't finished establishing yet when distribution/join is triggered.
async function waitForBotPoruReady(bot, timeoutMs = 12_000) {
    if (bot?.poru?.leastUsedNodes?.length) return true;
    // Try to nudge any exhausted nodes back to life
    try {
        bot.poru.nodes?.forEach(node => {
            if (!node.isConnected) {
                try {
                    node.attempt = 0;
                    clearTimeout(node.reconnectAttempt);
                    node.reconnectAttempt = null;
                    node.connect?.().catch(() => {});
                } catch {}
            }
        });
        if (!bot.poru.nodes?.size) {
            if (typeof restorePoruNodes === 'function') {
                restorePoruNodes(bot.poru, bot, 'settings waitForBotPoruReady');
            } else {
                bot.poru.init(bot).catch?.(() => {});
            }
        }
    } catch {}
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (bot?.poru?.leastUsedNodes?.length) return true;
        await new Promise(r => setTimeout(r, 500));
    }
    return !!(bot?.poru?.leastUsedNodes?.length);
}
const SETTINGS_PROGRESS_INTERVAL_MS = Math.max(750, Number(process.env.SETTINGS_PROGRESS_INTERVAL_MS || 1500));
const SETTINGS_MAX_PROGRESS_LINES = Math.max(20, Number(process.env.SETTINGS_MAX_PROGRESS_LINES || 120));

module.exports = {
    name: 'set',
    aliases: ['settings', 'إعدادات', 'اعدادات'],
    async execute(client, message, args) {
        const userId = message.author.id;
        const isAdmin = owners.includes(userId);
        const mid = message.id;

        function disableRows(rows = []) {
            return rows.map(row => {
                const next = new ActionRowBuilder();
                next.addComponents(row.components.map(component => {
                    const type = component.data?.type || component.type;
                    if (type === ComponentType.Button) return ButtonBuilder.from(component).setDisabled(true);
                    if (type === ComponentType.StringSelect) return StringSelectMenuBuilder.from(component).setDisabled(true);
                    if (type === ComponentType.ChannelSelect) return ChannelSelectMenuBuilder.from(component).setDisabled(true);
                    return component;
                }));
                return next;
            });
        }

        let tokens = store.get('tokens') || [];

        function parseUserId(value) {
            return String(value || '').match(/\d{17,20}/)?.[0] || null;
        }

        function subscriptionOwnersOf(tokenObj) {
            const raw = Array.isArray(tokenObj?.subOwners)
                ? tokenObj.subOwners
                : Array.isArray(tokenObj?.owners)
                    ? tokenObj.owners
                    : [];
            return [...new Set(raw.map(parseUserId).filter(Boolean))];
        }

        function isSubscriptionController(tokenObj, id = userId) {
            if (isAdmin) return true;
            const parsed = parseUserId(id);
            if (!tokenObj || !parsed) return false;
            return tokenObj.client === parsed || subscriptionOwnersOf(tokenObj).includes(parsed);
        }

        function primaryOwnerIdFor(code = selectedCode) {
            const timeData = store.get('time') || [];
            const subInfo = timeData.find(t => t.code === code);
            const entries = (store.get('tokens') || []).filter(t => t.code === code);
            return parseUserId(subInfo?.user || entries[0]?.client);
        }

        function subscriptionOwnerIdsFor(code = selectedCode) {
            const primary = primaryOwnerIdFor(code);
            const ids = new Set();
            (store.get('tokens') || [])
                .filter(t => t.code === code)
                .forEach(t => subscriptionOwnersOf(t).forEach(id => {
                    if (id !== primary) ids.add(id);
                }));
            return [...ids];
        }

        function canManageSubscriptionOwners(code = selectedCode) {
            const primary = primaryOwnerIdFor(code);
            return isAdmin || (primary && primary === userId);
        }

        function setSubscriptionOwnersFor(code, ownerIds) {
            const primary = primaryOwnerIdFor(code);
            const clean = [...new Set(ownerIds.map(parseUserId).filter(id => id && id !== primary))];
            tokens = store.get('tokens') || [];
            tokens.forEach(t => {
                if (t.code === code) {
                    t.subOwners = clean;
                    if (Array.isArray(t.owners)) delete t.owners;
                }
            });
            store.set('tokens', tokens);
            return clean;
        }

        const timeDataAtStart = store.get('time') || [];
        const mySubs = tokens.filter(t => isSubscriptionController(t));
        const uniqueCodes = [...new Set((
            isAdmin
                ? [
                    ...timeDataAtStart.map(t => t.code),
                    ...tokens.map(t => t.code),
                ]
                : mySubs.map(t => t.code)
        ).filter(Boolean))];

        if (uniqueCodes.length === 0) {
            return message.reply('❌ لا يوجد لديك اشتراكات نشطة.');
        }

                let selectedCode = uniqueCodes.length === 1 ? uniqueCodes[0] : null;

                        const mainMsg = await message.reply({ content: 'جاري التحميل...', components: [] });
                        await Promise.allSettled([
                            message.guild?.emojis?.fetch?.(),
                            client.application?.emojis?.fetch?.(),
                        ]);

                        const collector = mainMsg.createMessageComponentCollector({
                    filter: i => i.user.id === userId,
                    time: 300000
                });

                // Current panel state
                let currentPanel = 'SELECT';
                if (selectedCode) currentPanel = 'MAIN';
                        let selectPage = 0;
                        let activeDistributionCollector = null;
                        let activeDistributionState = null;
                        let activeChildCollector = null;
                        let modalSeq = 0;
                        const pendingModalContexts = new Map();

                function replaceChildCollector(nextCollector) {
                    if (activeChildCollector && activeChildCollector !== nextCollector) {
                        activeChildCollector.stop('replaced');
                    }
                    activeChildCollector = nextCollector;
                    nextCollector.on('end', () => {
                        if (activeChildCollector === nextCollector) activeChildCollector = null;
                    });
                }

                        function stopChildCollector(reason = 'replaced') {
                            if (!activeChildCollector) return;
                            const current = activeChildCollector;
                            activeChildCollector = null;
                            current.stop(reason);
                        }

                        function createSettingsModalId(type, context = {}) {
                            const customId = `stg_mod_${mid}_${type}_${++modalSeq}`;
                            pendingModalContexts.set(customId, {
                                type,
                                code: context.code || selectedCode,
                                createdAt: Date.now(),
                            });
                            return customId;
                        }

                        function consumeSettingsModalContext(customId) {
                            const context = pendingModalContexts.get(customId);
                            if (context) {
                                pendingModalContexts.delete(customId);
                                return context;
                            }

                            const prefix = `stg_mod_${mid}_`;
                            if (!customId.startsWith(prefix)) return null;

                            const rest = customId.slice(prefix.length);
                            const legacyTypes = [
                                'voice_status_emoji',
                                'owner_remove',
                                'owner_add',
                                'dist_prefix',
                                'moveidle',
                                'avatar',
                                'banner',
                                'status',
                            ];
                            const type = legacyTypes.find(name => rest === name || rest.startsWith(`${name}_`));
                            return type ? { type, code: selectedCode, legacy: true } : null;
                        }

        function getClientId(token) {
            try { return Buffer.from(token.split('.')[0], 'base64').toString('utf8'); } catch { return ''; }
        }

                function getBotVoiceInfo(t) {
                    const bot = runningBots.get(t.token);
                    if (!bot) return { bot: null, statusText: 'غير متصل', inRoom: false, inServer: false };
                    const guild = bot.guilds.cache.get(t.Server);
                    if (!guild) return { bot, statusText: 'خارج السيرفر', inRoom: false, inServer: false };
                    const vc = guild.members.me?.voice?.channel;
            return {
                bot,
                statusText: vc ? `<#${vc.id}>` : 'بدون روم',
                inRoom: !!vc,
                channelId: vc?.id || null,
                channelName: vc?.name || null,
                        inServer: true
            };
                }

                function isWaitingReplacement(t) {
                    return t?.awaitingReplacement || t?.invalidTokenNotifiedAt || t?.invalidBotId;
                }

                                function getSelectedTokens(options = {}) {
                                    tokens = store.get('tokens') || [];
                                    const code = options.code || selectedCode;
                                    const selected = tokens.filter(t => t.code === code);
                                    return options.includeWaiting ? selected : selected.filter(t => !isWaitingReplacement(t));
                                }

                                function subscriptionServerIdFor(code = selectedCode) {
                                    const selected = getSelectedTokens({ code, includeWaiting: true });
                                    const tokenServer = selected.find(t => t.Server)?.Server;
                                    if (tokenServer) return tokenServer;
                                    const timeData = store.get('time') || [];
                                    return timeData.find(t => t.code === code)?.server || null;
                                }

                                async function requireSubscriptionGuild(interaction, label = 'هذا الخيار', code = selectedCode) {
                                    const serverId = subscriptionServerIdFor(code);
                                    if (!serverId || message.guild?.id === serverId) return true;

                                    const content = `⚠️ ${label} يجب استخدامه داخل سيرفر الاشتراك.\nالسيرفر الصحيح: \`${serverId}\``;
                                    if (interaction.replied || interaction.deferred) {
                                        await mainMsg.edit({ content, embeds: [], components: [] }).catch(() => {});
                                    } else {
                                        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
                                    }
                                    return false;
                                }

                function isVoiceChannel(channel) {
                    return channel?.type === ChannelType.GuildVoice || channel?.type === 2;
                }

                function chatSummary(selectedTokens = getSelectedTokens()) {
                    if (selectedTokens.length === 0) {
                        return {
                            label: '`Not Set`',
                            details: 'لا توجد بوتات نشطة حالياً داخل هذا الاشتراك.',
                        };
                    }
                    const configured = selectedTokens.map(t => t.chat).filter(Boolean);
                    const unique = [...new Set(configured)];
                    if (unique.length === 0) {
                        return {
                            label: '`Not Set`',
                            details: 'الأوامر تعمل في كل الشاتات المسموحة حالياً.',
                        };
                    }
                    if (unique.length === 1) {
                        return {
                            label: `<#${unique[0]}>`,
                            details: `مطبق على **${configured.length}/${selectedTokens.length}** بوت.`,
                        };
                    }
                    return {
                        label: '`Mixed Settings`',
                        details: `يوجد **${unique.length}** شات مختلف داخل نفس الاشتراك.`,
                    };
                }

                function backToVoiceSummary(selectedTokens = getSelectedTokens({ includeWaiting: true })) {
                    const enabled = selectedTokens.filter(t => t.backToVoice !== 'off').length;
                    const total = selectedTokens.length;
                    if (!total) return { enabled: false, label: '`OFF`', details: 'لا توجد بوتات نشطة حالياً.' };
                    return {
                        enabled: enabled > 0,
                        label: enabled === total ? '`ON`' : enabled === 0 ? '`OFF`' : '`Mixed`',
                        details: `مفعل في **${enabled}/${total}** بوت.`,
                    };
                }

                        async function showMoveIdleModal(interaction, code = selectedCode) {
                            if (!(await requireSubscriptionGuild(interaction, 'Move Idle', code))) return;

                            const idleBots = getSelectedTokens({ code }).filter(t => {
                                const info = getBotVoiceInfo(t);
                                return info.inServer && !info.inRoom;
                            });

                    if (idleBots.length === 0) {
                        return interaction.reply({ content: '✅ لا يوجد بوتات خاملة — كلها في رومات.', flags: MessageFlags.Ephemeral });
                    }

                            const modal = new ModalBuilder()
                                .setCustomId(createSettingsModalId('moveidle', { code }))
                                .setTitle(`Move ${idleBots.length} Idle Bots`);
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('channelId')
                                .setLabel('Voice channel ID')
                                .setPlaceholder('Example: 111 or 111,222,333')
                                .setRequired(true)
                                .setStyle(TextInputStyle.Short)
                        )
                    );
                    return interaction.showModal(modal);
                }

                        function distributionBuckets(code = selectedCode) {
                            const selectedTokens = getSelectedTokens({ code });
                    const available = [];
                    const idle = [];
                    const inRoom = [];
                    const groupedRoomIds = new Set();
                    const roomMap = new Map();

                    selectedTokens.forEach(t => {
                        const info = getBotVoiceInfo(t);
                        if (!info.bot || !info.inServer) return;

                        const entry = { token: t, info };
                        available.push(entry);

                        if (info.inRoom && info.channelId) {
                            inRoom.push(entry);
                            const group = roomMap.get(info.channelId) || [];
                            group.push(entry);
                            roomMap.set(info.channelId, group);
                        } else {
                            idle.push(entry);
                        }
                    });

                    roomMap.forEach((group, channelId) => {
                        if (group.length > 1) groupedRoomIds.add(channelId);
                    });

                    const grouped = inRoom.filter(entry => groupedRoomIds.has(entry.info.channelId));
                    return { available, idle, inRoom, grouped };
                }

                        function distributionTargets(scope, code = selectedCode) {
                            const buckets = distributionBuckets(code);
                    if (scope === 'idle') return buckets.idle.map(entry => entry.token);
                    if (scope === 'grouped') return buckets.grouped.map(entry => entry.token);
                    if (scope === 'in_room') return buckets.inRoom.map(entry => entry.token);
                    if (scope === 'all') return buckets.available.map(entry => entry.token);
                    return [];
                }

                function buildDistributionEmbed(title, description, fields = []) {
                    const embed = new EmbedBuilder()
                        .setTitle(title)
                        .setDescription(description)
                        .setColor(getEmbedColor(client));
                    if (fields.length) embed.addFields(fields);
                    return embed;
                }

                        function channelSortValue(channel) {
                            return Number.isFinite(channel?.rawPosition)
                                ? channel.rawPosition
                                : Number.isFinite(channel?.position)
                                    ? channel.position
                                    : 0;
                        }

                        function channelSortParts(channel) {
                            const parent = channel?.parent || null;
                            return {
                                groupPosition: parent ? channelSortValue(parent) : channelSortValue(channel),
                                parentId: parent?.id || '',
                                childPosition: parent ? channelSortValue(channel) : -1,
                                id: String(channel?.id || ''),
                            };
                        }

                        function sortVoiceChannels(a, b) {
                            const left = channelSortParts(a);
                            const right = channelSortParts(b);
                            return left.groupPosition - right.groupPosition
                                || left.parentId.localeCompare(right.parentId)
                                || left.childPosition - right.childPosition
                                || left.id.localeCompare(right.id);
                        }

                        async function getDistributionChannels(firstId, lastId) {
                            const channels = await message.guild.channels.fetch();
                            const voiceChannels = [...channels.values()]
                                .filter(c => isVoiceChannel(c))
                                .sort(sortVoiceChannels);

                            const firstIndex = voiceChannels.findIndex(c => c.id === firstId);
                            const lastIndex = voiceChannels.findIndex(c => c.id === lastId);
                            if (firstIndex === -1 || lastIndex === -1) throw new Error('تعذر العثور على الرومات المحددة.');

                            const start = Math.min(firstIndex, lastIndex);
                            const end = Math.max(firstIndex, lastIndex);
                            const seen = new Set();
                            const targetChannels = voiceChannels
                                .slice(start, end + 1)
                                .filter(channel => {
                                    if (seen.has(channel.id)) return false;
                                    seen.add(channel.id);
                                    return true;
                                });
                            if (targetChannels.length === 0) throw new Error('لا توجد رومات صوتية في المدى المحدد.');

                            return targetChannels;
                        }

                        function uniqueTokensByToken(targetTokens = []) {
                            const seen = new Set();
                            return targetTokens.filter(t => {
                                if (!t?.token || seen.has(t.token)) return false;
                                seen.add(t.token);
                                return true;
                            });
                        }

                        function buildDistributionPlan(targetTokens, targetChannels) {
                            const bots = uniqueTokensByToken(targetTokens);
                            const rooms = [...new Map((targetChannels || []).map(channel => [channel.id, channel])).values()];
                            const count = Math.min(bots.length, rooms.length);
                            return {
                                assignments: Array.from({ length: count }, (_, index) => ({
                                    index,
                                    token: bots[index],
                                    channel: rooms[index],
                                })),
                                bots,
                                rooms,
                                unusedBots: bots.slice(count),
                                unusedRooms: rooms.slice(count),
                            };
                        }

                        function wait(ms) {
                            return new Promise(resolve => setTimeout(resolve, ms));
                        }

                        async function runLimited(items, limit, worker) {
                            const list = Array.isArray(items) ? items : [];
                            const concurrency = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
                            let cursor = 0;
                            const workers = Array.from({ length: concurrency }, async () => {
                                while (cursor < list.length) {
                                    const index = cursor++;
                                    await worker(list[index], index);
                                }
                            });
                            await Promise.all(workers);
                        }

                        async function waitForBotVoiceChannel(guild, bot, channelId, timeoutMs = 15000) {
                            const deadline = Date.now() + timeoutMs;
                            while (Date.now() < deadline) {
                                const currentChannelId = guild.members.me?.voice?.channelId
                                    || guild.members.cache.get(bot.user.id)?.voice?.channelId;
                                if (currentChannelId === channelId) return true;

                                const me = await guild.members.fetchMe().catch(() => null);
                                if (me?.voice?.channelId === channelId) return true;
                                await wait(750);
                            }
                            return false;
                        }

                        const SCOPE_LABELS = {
                            idle: 'الخاملين',
                            grouped: 'المتجمعين',
                            in_room: 'الموجودين بالرومات',
                            all: 'كل المتاحين',
                        };

                        function formatShortDuration(msValue) {
                            const value = Math.max(0, Number(msValue || 0));
                            const h = Math.floor(value / 3600000);
                            const m = Math.floor((value % 3600000) / 60000);
                            const s = Math.floor((value % 60000) / 1000);
                            if (h) return `${h}h ${m}m`;
                            if (m) return `${m}m ${s}s`;
                            return `${s}s`;
                        }

                        function progressStats(done, total, startedAt) {
                            const elapsedMs = Math.max(1, Date.now() - Number(startedAt || Date.now()));
                            const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 100;
                            const perSecond = done > 0 ? done / (elapsedMs / 1000) : 0;
                            const left = Math.max(0, total - done);
                            const etaMs = perSecond > 0 ? (left / perSecond) * 1000 : 0;
                            return {
                                percent,
                                left,
                                elapsed: formatShortDuration(elapsedMs),
                                eta: done >= total ? '0s' : (perSecond > 0 ? formatShortDuration(etaMs) : 'calculating'),
                                speed: perSecond > 0 ? `${perSecond.toFixed(perSecond >= 10 ? 1 : 2)}/s` : '0/s',
                            };
                        }

                        function buildSimpleProgressBar(done, total, length = 20) {
                            const safeTotal = Math.max(1, total);
                            const percent = Math.min(100, Math.round((done / safeTotal) * 100));
                            const filled = Math.round((done / safeTotal) * length);
                            return `\`[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, length - filled))}]\` **${percent}%**`;
                        }

                        function buildProcessEmbed(title, done, total, okCount, failCount, lines = [], meta = {}) {
                            const stats = progressStats(done, total, meta.startedAt);
                            const fields = [
                                {
                                    name: 'Progress',
                                    value: [
                                        buildSimpleProgressBar(done, total),
                                        '',
                                        `**1. Total :** *\`${total}\`*`,
                                        `**2. Done :** *\`${done}\`*`,
                                        `**3. Success :** *\`${okCount}\`*`,
                                        `**4. Failed :** *\`${failCount}\`*`,
                                        `**5. Left :** *\`${stats.left}\`*`,
                                    ].join('\n'),
                                    inline: true,
                                },
                                {
                                    name: 'Timing',
                                    value: [
                                        `**1. Speed :** *\`${stats.speed}\`*`,
                                        `**2. Elapsed :** *\`${stats.elapsed}\`*`,
                                        `**3. ETA :** *\`${stats.eta}\`*`,
                                        `**4. Concurrency :** *\`${meta.concurrency || SETTINGS_PROCESS_CONCURRENCY}\`*`,
                                    ].join('\n'),
                                    inline: true,
                                },
                            ];
                            if (lines.length) {
                                fields.push({
                                    name: 'Live Log',
                                    value: lines.slice(-8).join('\n').slice(0, 1024),
                                    inline: false,
                                });
                            }
                            return new EmbedBuilder()
                                .setTitle(title)
                                .setDescription([
                                    `**Status :** *${done >= total ? 'Completed' : 'Running'}*`,
                                    '',
                                    `**Current :** *\`${done}\` من \`${total}\` عملية*`,
                                ].join('\n'))
                                .addFields(fields)
                                .setColor(getEmbedColor(client));
                        }

                                async function runBotProcess(title, targetTokens, action, options = {}) {
                                    const processCode = options.code || selectedCode || 'unknown';
                                    const processKey = `process:${processCode}`;
                                    const smartKey = `smart:${processCode}`;
                                    if (activeSettingsProcesses.has(processKey) || activeSmartDistributions.has(smartKey)) {
                                        await mainMsg.edit({
                                            content: `<@${userId}>`,
                                            embeds: [buildDistributionEmbed(title, 'توجد عملية أخرى تعمل حالياً لهذا الاشتراك. انتظر حتى تنتهي ثم حاول مرة أخرى.')],
                                            components: [],
                                            allowedMentions: { users: [userId] },
                                        }).catch(() => {});
                                        return { ok: 0, failed: 0, total: 0, lines: [], locked: true };
                                    }
                                    activeSettingsProcesses.add(processKey);
                                    const targets = uniqueTokensByToken(targetTokens).filter(Boolean);
                                    let done = 0;
                                    let ok = 0;
                                    let failed = 0;
                            const lines = [];
                            const concurrency = Math.max(1, Number(options.concurrency || SETTINGS_PROCESS_CONCURRENCY));
                            const startedAt = Date.now();
                            let lastEditAt = 0;
                            let editing = false;
                            const progressMeta = { startedAt, concurrency };

                            const pushLine = (line) => {
                                lines.push(line);
                                if (lines.length > SETTINGS_MAX_PROGRESS_LINES) {
                                    lines.splice(0, lines.length - SETTINGS_MAX_PROGRESS_LINES);
                                }
                            };

                            const renderProgress = async (force = false) => {
                                const now = Date.now();
                                if (!force && now - lastEditAt < SETTINGS_PROGRESS_INTERVAL_MS) return;
                                if (editing) return;
                                editing = true;
                                lastEditAt = now;
                                try {
                                    await mainMsg.edit({
                                        content: `<@${userId}>`,
                                        embeds: [buildProcessEmbed(title, done, targets.length, ok, failed, lines, progressMeta)],
                                        components: [],
                                        allowedMentions: { users: [userId] },
                                    }).catch(() => {});
                                } finally {
                                    editing = false;
                                }
                            };

                                    try {
                                        await mainMsg.edit({
                                            content: `<@${userId}>`,
                                            embeds: [buildProcessEmbed(title, 0, targets.length, 0, 0, [], progressMeta)],
                                            components: [],
                                            allowedMentions: { users: [userId] },
                                        }).catch(() => {});

                                        await runLimited(targets, concurrency, async (t, index) => {
                                            const bot = runningBots.get(t.token);
                                            const mention = bot?.user?.id ? `<@${bot.user.id}>` : `\`${t.invalidBotName || 'Offline bot'}\``;

                                            try {
                                                await action(t, bot, index);
                                                ok++;
                                                pushLine(`✅ ${mention} done`);
                                            } catch (err) {
                                                failed++;
                                                pushLine(`❌ ${mention} ${String(err?.message || 'failed').slice(0, 80)}`);
                                            }

                                            done++;
                                            await renderProgress(false);
                                        });

                                        while (editing) await wait(100);
                                        await renderProgress(true);

                                        return { ok, failed, total: targets.length, lines };
                                            } finally {
                                                activeSettingsProcesses.delete(processKey);
                                            }
                                        }

                        function getTwitchUrl() {
                            return Array.isArray(TwitchUrl) ? TwitchUrl[0] : TwitchUrl;
                        }

                        async function promptForUserMessage(interaction, prompt, options = {}) {
                            await interaction.reply({
                                content: prompt,
                                flags: MessageFlags.Ephemeral,
                            }).catch(() => {});

                            const collected = await message.channel.awaitMessages({
                                filter: msg => msg.author.id === userId && !msg.author.bot,
                                max: 1,
                                time: options.time || 120000,
                            }).catch(() => null);
                            const replyMessage = collected?.first?.();
                            if (!replyMessage) {
                                await mainMsg.edit({ content: '❌ انتهى الوقت بدون إدخال.', embeds: [], components: [] }).catch(() => {});
                                setTimeout(() => updatePanel(), 2500);
                                return null;
                            }

                            const attachmentUrl = replyMessage.attachments?.first?.()?.url || null;
                            const text = replyMessage.content?.trim() || '';
                            if (options.delete !== false) replyMessage.delete().catch(() => {});
                            return options.allowAttachment ? (attachmentUrl || text) : text;
                        }

                        async function patchCurrentApplication(token, payload) {
                            const body = {};
                            if (payload.name) body.name = String(payload.name).slice(0, 32);
                            if (payload.icon) body.icon = payload.icon;
                            if (payload.cover_image) body.cover_image = payload.cover_image;
                            if (!Object.keys(body).length) return;
                            await axios.patch('https://discord.com/api/v10/applications/@me', body, {
                                headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
                                timeout: SETTINGS_IMAGE_TIMEOUT_MS,
                            });
                        }

                        function parseCustomEmojiInput(value) {
                            const text = String(value || '').trim();
                            const match = text.match(/^<(?<animated>a?):(?<name>[A-Za-z0-9_~.-]+):(?<id>\d{17,20})>$/);
                            if (!match?.groups) return null;
                            return {
                                id: match.groups.id,
                                name: match.groups.name,
                                animated: match.groups.animated === 'a',
                            };
                        }

                        async function syncCustomEmojiToBotApplication(bot, input) {
                            const emoji = parseCustomEmojiInput(input);
                            if (!emoji) return String(input || '').trim() || '🎵';
                            if (!bot?.application?.emojis) throw new Error('application emojis unavailable');

                            const current = await bot.application.emojis.fetch();
                            const existing = [...current.values()].find(e => e.name === emoji.name);
                            if (existing) {
                                return `<${existing.animated ? 'a' : ''}:${existing.name}:${existing.id}>`;
                            }

                            const ext = emoji.animated ? 'gif' : 'png';
                            const imageUrl = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
                            const response = await axios.get(imageUrl, {
                                responseType: 'arraybuffer',
                                timeout: SETTINGS_IMAGE_TIMEOUT_MS,
                                maxContentLength: SETTINGS_IMAGE_MAX_BYTES,
                                validateStatus: status => status >= 200 && status < 300,
                            });
                            const imageData = `data:image/${ext};base64,${Buffer.from(response.data).toString('base64')}`;
                            const created = await bot.application.emojis.create({ name: emoji.name, attachment: imageData });
                            return `<${created.animated ? 'a' : ''}:${created.name}:${created.id}>`;
                        }

                        async function moveTokenToVoice(t, targetChannelId) {
                            const bot = runningBots.get(t.token);
                            if (!bot?.poru) throw new Error('bot offline');

                            const guild = bot.guilds.cache.get(t.Server);
                            if (!guild) throw new Error('bot outside server');

                            const targetChannel = guild.channels.cache.get(targetChannelId)
                                || await guild.channels.fetch(targetChannelId).catch(() => null);
                            if (!isVoiceChannel(targetChannel)) throw new Error('invalid voice channel');

                            const poruReady = await waitForBotPoruReady(bot, 12_000);
                            if (!poruReady) throw new Error('Lavalink not connected yet');

                            t.channel = targetChannel.id;
                            t.backToVoice = 'on';

                            const existing = bot.poru.players.get(guild.id);
                            if (existing) {
                                existing.textChannel = t.chat || existing.textChannel || targetChannel.id;
                                existing.data = existing.data || {};
                                if (t.chat) existing.data.lastTextChannel = t.chat;
                                try {
                                    if (!existing.isConnected || existing.voiceChannel !== targetChannel.id) {
                                        existing.setVoiceChannel(targetChannel.id, { deaf: true, mute: false });
                                    }
                                } catch (err) {
                                    if (!(err instanceof ReferenceError)) throw err;
                                }
                            } else {
                                await bot.poru.createConnection({
                                    guildId: guild.id,
                                    voiceChannel: targetChannel.id,
                                    textChannel: t.chat || targetChannel.id,
                                    deaf: true,
                                    group: t.token,
                                });
                            }

                            const joined = await waitForBotVoiceChannel(guild, bot, targetChannel.id);
                            if (!joined) throw new Error(`bot did not join ${targetChannel.name || targetChannel.id}`);
                            return targetChannel;
                        }

                        async function setBotNameAndVerify(bot, targetName, maxRetries = 4) {
                            if (!targetName) return { required: false, ok: true, actual: bot.user?.username || 'Unknown' };
                            if (!bot?.user) return { required: true, ok: false, actual: '—', error: 'bot.user unavailable' };

                            const safeName = String(targetName).trim().slice(0, 32);
                            if (!safeName) return { required: false, ok: true, actual: bot.user.username || 'Unknown' };
                            if (bot.user.username === safeName) {
                                return { required: true, ok: true, actual: bot.user.username, expected: safeName };
                            }

                            let lastError = null;
                            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                                const result = await bot.user.setUsername(safeName).catch(err => ({ _err: err }));
                                if (!result?._err) {
                                    const actual = result?.username || bot.user?.username || safeName;
                                    return { required: true, ok: true, actual, expected: safeName };
                                }
                                lastError = result._err;

                                const rawRetryAfter =
                                    lastError?.rawError?.retry_after ??
                                    lastError?.retryAfter ??
                                    (String(lastError?.message || '').match(/(\d+(\.\d+)?)\s*second/i)?.[1]);

                                const retryAfterMs = rawRetryAfter != null
                                    ? Math.ceil(parseFloat(rawRetryAfter) * 1000) + 1500
                                    : null;

                                const isRateLimit =
                                    lastError?.status === 429 ||
                                    lastError?.httpStatus === 429 ||
                                    retryAfterMs != null;

                                if (attempt < maxRetries) {
                                    const waitMs = isRateLimit
                                        ? Math.min(retryAfterMs ?? 65_000, 90_000)
                                        : Math.min(2_000 * attempt, 10_000);
                                    await new Promise(r => setTimeout(r, waitMs));
                                    continue;
                                }
                                break;
                            }

                            return {
                                required: true,
                                ok: false,
                                actual: bot.user?.username || 'Unknown',
                                error: lastError?.message || 'name change failed',
                            };
                        }

                                async function executeSmartDistribution(interaction, state) {
                                    const code = state.code || selectedCode;

                                    // ── validation ──────────────────────────────────────
                                    if (!state.scope) {
                                        const payload = { content: '', embeds: [buildDistributionEmbed('Smart Distribution', '❌ لم يتم تحديد نطاق التوزيع (scope). افتح التوزيع مرة أخرى.')], components: [] };
                                        if (!interaction.replied && !interaction.deferred) return interaction.update(payload);
                                        return mainMsg.edit(payload);
                                    }
                                    if (!state.firstChannelId || !state.lastChannelId) {
                                        const payload = { content: '', embeds: [buildDistributionEmbed('Smart Distribution', '❌ لم يتم تحديد الرومات. افتح التوزيع مرة أخرى.')], components: [] };
                                        if (!interaction.replied && !interaction.deferred) return interaction.update(payload);
                                        return mainMsg.edit(payload);
                                    }
                                    if (!state.mode) {
                                        const payload = { content: '', embeds: [buildDistributionEmbed('Smart Distribution', '❌ لم يتم تحديد وضع التسمية. افتح التوزيع مرة أخرى.')], components: [] };
                                        if (!interaction.replied && !interaction.deferred) return interaction.update(payload);
                                        return mainMsg.edit(payload);
                                    }

                                    const targets = distributionTargets(state.scope, code);
                                    if (targets.length === 0) {
                                        const payload = {
                                            content: '',
                                            embeds: [buildDistributionEmbed('Smart Distribution', 'لا توجد بوتات مناسبة لهذا الخيار حالياً.')],
                                            components: [new ActionRowBuilder().addComponents(
                                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_back_rooms`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                                            )],
                                        };
                                        if (!interaction.replied && !interaction.deferred) return interaction.update(payload);
                                        return mainMsg.edit(payload);
                                    }

                                    const lockKey = `smart:${code}`;
                                    const processKey = `process:${code}`;
                                    if (activeSmartDistributions.has(lockKey) || activeSettingsProcesses.has(processKey)) {
                                        const payload = {
                                            content: '',
                                            embeds: [buildDistributionEmbed('Smart Distribution', 'يوجد توزيع ذكي يعمل حالياً لهذا الاشتراك. انتظر حتى ينتهي ثم حاول مرة أخرى.')],
                                            components: [],
                                        };
                                        if (!interaction.replied && !interaction.deferred) return interaction.update(payload);
                                        return mainMsg.edit(payload);
                                    }
                                    activeSmartDistributions.add(lockKey);

                                    const editMsg = async (payload) => {
                                        if (!interaction.replied && !interaction.deferred) {
                                            return interaction.update(payload).catch(() => mainMsg.edit(payload).catch(() => {}));
                                        }
                                        return mainMsg.edit(payload).catch(() => {});
                                    };

                                    const scopeLabels = { idle: 'الخاملين', grouped: 'المتجمعين', all: 'الكل' };
                                    const needsRename = state.mode === 'names' || state.mode === 'numbers';
                                    const distributionStartedAt = Date.now();
                                    let plannedTotal = targets.length;
                                    let plannedRooms = 0;
                                    let plannedAssignments = 0;
                                    let plannedUnusedBots = 0;
                                    let plannedUnusedRooms = 0;

                                    const modeLabel = state.mode === 'names'
                                        ? (state.namesWithNumbers ? 'أسماء الرومات + أرقام' : 'أسماء الرومات')
                                        : state.mode === 'numbers'
                                            ? (state.namePrefix ? `${state.namePrefix}1, ${state.namePrefix}2...` : '1, 2, 3...')
                                            : 'بدون تغيير أسماء';

                                    // ── helper: compute target name for an assignment ────
                                    function computeTargetName(idx, chan) {
                                        if (state.mode === 'names') {
                                            return state.namesWithNumbers
                                                ? `${chan.name} ${idx + 1}`.trim().slice(0, 32)
                                                : chan.name.trim().slice(0, 32);
                                        }
                                        if (state.mode === 'numbers') {
                                            return state.namePrefix
                                                ? `${state.namePrefix}${idx + 1}`.slice(0, 32)
                                                : String(idx + 1);
                                        }
                                        return null;
                                    }

                                    // ── helpers: progress tracking ──────────────────────
                                    let lastEditAt = 0;
                                    const details = [];
                                    const liveLog = [];
                                    let detailCount = 0;

                                    const addLine = (line) => {
                                        detailCount++;
                                        details.push(line);
                                        if (details.length > SETTINGS_MAX_PROGRESS_LINES) details.splice(0, details.length - SETTINGS_MAX_PROGRESS_LINES);
                                        liveLog.push(line);
                                        if (liveLog.length > 10) liveLog.splice(0, liveLog.length - 10);
                                    };

                                    const throttleEdit = async (payload, force = false) => {
                                        const now = Date.now();
                                        if (!force && now - lastEditAt < SETTINGS_PROGRESS_INTERVAL_MS) return;
                                        lastEditAt = now;
                                        await mainMsg.edit(payload).catch(() => {});
                                    };

                                    // ── phase progress embed ────────────────────────────
                                    function buildPhaseEmbed(phase, phaseDone, phaseTotal, moveDone, moveTotal, nameOk, nameFail, movOk, movFail) {
                                        const stats = progressStats(phaseDone, phaseTotal, distributionStartedAt);
                                        const overallDone = (needsRename ? nameOk + nameFail : 0) + movOk + movFail;
                                        const overallTotal = (needsRename ? plannedAssignments : 0) + plannedAssignments;
                                        return buildDistributionEmbed(
                                            `Smart Distribution — ${phase} — ${stats.percent}%`,
                                            [
                                                `**Owner :** *<@${interaction.user.id}>*`,
                                                `**Mode :** *${modeLabel}*`,
                                                `**Scope :** *${scopeLabels[state.scope] || state.scope}*`,
                                                `**Rooms :** *<#${state.firstChannelId}> → <#${state.lastChannelId}>*`,
                                                `**Plan :** *\`${plannedAssignments}\` بوت × \`${plannedRooms}\` روم*`,
                                            ].join('\n'),
                                            [
                                                {
                                                    name: needsRename ? '📝 Phase 1 — Rename' : '📝 Rename',
                                                    value: needsRename
                                                        ? [
                                                            buildSimpleProgressBar(nameOk + nameFail, plannedAssignments),
                                                            `**Done :** *\`${nameOk + nameFail}/${plannedAssignments}\`*  **✅** \`${nameOk}\`  **❌** \`${nameFail}\``,
                                                        ].join('\n')
                                                        : '`—` بدون تغيير أسماء',
                                                    inline: false,
                                                },
                                                {
                                                    name: '🔊 Phase 2 — Move to Voice',
                                                    value: [
                                                        buildSimpleProgressBar(movOk + movFail, plannedAssignments),
                                                        `**Done :** *\`${movOk + movFail}/${plannedAssignments}\`*  **✅** \`${movOk}\`  **❌** \`${movFail}\``,
                                                    ].join('\n'),
                                                    inline: false,
                                                },
                                                {
                                                    name: 'Timing',
                                                    value: [
                                                        `**Speed :** *\`${stats.speed}\`*`,
                                                        `**Elapsed :** *\`${stats.elapsed}\`*`,
                                                        `**ETA :** *\`${stats.eta}\`*`,
                                                        `**Batch :** *\`${SETTINGS_DISTRIBUTION_BATCH_SIZE}\`*`,
                                                    ].join('\n'),
                                                    inline: true,
                                                },
                                                {
                                                    name: 'Plan Safety',
                                                    value: [
                                                        `**Extra Bots :** *\`${plannedUnusedBots}\`*`,
                                                        `**Extra Rooms :** *\`${plannedUnusedRooms}\`*`,
                                                        '**Rule :** *1 bot / room*',
                                                    ].join('\n'),
                                                    inline: true,
                                                },
                                                ...(liveLog.length > 0
                                                    ? [{ name: 'Live Log', value: liveLog.slice(-8).join('\n').slice(0, 1024), inline: false }]
                                                    : []),
                                            ],
                                        );
                                    }

                                    try {
                                        // ── build plan ──────────────────────────────────
                                        const targetChannels = await getDistributionChannels(state.firstChannelId, state.lastChannelId);
                                        if (!targetChannels.length) throw new Error('لا توجد رومات في النطاق المحدد');

                                        const plan = buildDistributionPlan(targets, targetChannels);
                                        plannedTotal = plan.bots.length;
                                        plannedRooms = plan.rooms.length;
                                        plannedAssignments = plan.assignments.length;
                                        plannedUnusedBots = plan.unusedBots.length;
                                        plannedUnusedRooms = plan.unusedRooms.length;

                                        if (plan.assignments.length === 0) {
                                            await editMsg({
                                                content: '',
                                                embeds: [buildDistributionEmbed(
                                                    'Smart Distribution',
                                                    [
                                                        'لا توجد خطة توزيع قابلة للتنفيذ.',
                                                        '',
                                                        `**Bots :** *\`${plan.bots.length}\`*`,
                                                        `**Rooms :** *\`${plan.rooms.length}\`*`,
                                                    ].join('\n'),
                                                )],
                                                components: [],
                                            });
                                            return;
                                        }

                                        // initial loading embed
                                        await editMsg({
                                            content: '',
                                            embeds: [buildPhaseEmbed('Starting', 0, plannedAssignments, 0, plannedAssignments, 0, 0, 0, 0)],
                                            components: [],
                                        });

                                        // ── PHASE 1: RENAME (sequential, rate-limit safe) ─
                                        let nameOk = 0;
                                        let nameFail = 0;
                                        const nameResultMap = new Map(); // token → nameResult

                                        if (needsRename) {
                                            for (let i = 0; i < plan.assignments.length; i++) {
                                                const { index: idx, token: t, channel: chan } = plan.assignments[i];
                                                const targetName = computeTargetName(idx, chan);
                                                const bot = runningBots.get(t.token);

                                                if (!bot?.user) {
                                                    const r = { required: true, ok: false, actual: '—', error: 'bot not ready' };
                                                    nameResultMap.set(t.token, r);
                                                    nameFail++;
                                                    addLine(`📝 **${idx + 1}.** ❌ \`bot not ready\``);
                                                } else {
                                                    const r = await setBotNameAndVerify(bot, targetName);
                                                    nameResultMap.set(t.token, r);
                                                    if (r.ok) {
                                                        nameOk++;
                                                        addLine(`📝 **${idx + 1}.** ✅ \`${r.actual}\``);
                                                    } else {
                                                        nameFail++;
                                                        addLine(`📝 **${idx + 1}.** ❌ \`${r.error || 'failed'}\``);
                                                    }
                                                }

                                                await throttleEdit({
                                                    content: '',
                                                    embeds: [buildPhaseEmbed('Phase 1 — Renaming', i + 1, plannedAssignments, 0, plannedAssignments, nameOk, nameFail, 0, 0)],
                                                    components: [],
                                                });

                                                // small delay between renames to avoid Discord global rate-limits
                                                if (i < plan.assignments.length - 1) {
                                                    await new Promise(r => setTimeout(r, 600));
                                                }
                                            }

                                            // force update after rename phase
                                            await mainMsg.edit({
                                                content: '',
                                                embeds: [buildPhaseEmbed('Phase 1 — Done | Phase 2 — Starting', plannedAssignments, plannedAssignments, 0, plannedAssignments, nameOk, nameFail, 0, 0)],
                                                components: [],
                                            }).catch(() => {});
                                            lastEditAt = Date.now();

                                            await new Promise(r => setTimeout(r, 800));
                                        }

                                        // ── PHASE 2: MOVE TO VOICE (parallel batches) ────
                                        let movOk = 0;
                                        let movFail = 0;
                                        const BATCH_SIZE = SETTINGS_DISTRIBUTION_BATCH_SIZE;
                                        lastEditAt = 0;

                                        for (let batchStart = 0; batchStart < plan.assignments.length; batchStart += BATCH_SIZE) {
                                            const batch = plan.assignments.slice(batchStart, batchStart + BATCH_SIZE);

                                            const batchResults = await Promise.allSettled(batch.map(async (assignment) => {
                                                const { index: idx, token: t, channel: chan } = assignment;
                                                const bot = runningBots.get(t.token);
                                                if (!bot?.poru) throw new Error('bot offline (no Lavalink)');

                                                const targetChannel = await moveTokenToVoice(t, chan.id);
                                                const nameResult = nameResultMap.get(t.token) || { required: false, ok: true, actual: bot.user?.username || '—' };
                                                return { idx, bot, targetChannel, nameResult };
                                            }));

                                            for (const res of batchResults) {
                                                if (res.status === 'fulfilled') {
                                                    const { idx, bot, targetChannel, nameResult } = res.value;
                                                    movOk++;
                                                    const nameStr = nameResult.required
                                                        ? (nameResult.ok ? ` 📝 \`${nameResult.actual}\`` : ` 📝 ❌`)
                                                        : '';
                                                    addLine(`✅ **${idx + 1}.** <@${bot.user.id}> → <#${targetChannel.id}>${nameStr}`);
                                                } else {
                                                    movFail++;
                                                    addLine(`❌ **${batchStart + movOk + movFail}.** ${res.reason?.message || 'unknown error'}`);
                                                }
                                            }

                                            await throttleEdit({
                                                content: '',
                                                embeds: [buildPhaseEmbed(
                                                    'Phase 2 — Moving',
                                                    movOk + movFail,
                                                    plannedAssignments,
                                                    movOk + movFail,
                                                    plannedAssignments,
                                                    nameOk, nameFail, movOk, movFail,
                                                )],
                                                components: [],
                                            }, movOk + movFail >= plannedAssignments);
                                        }

                                        store.set('tokens', tokens);

                                        // ── final result embed ──────────────────────────
                                        const nameField = needsRename
                                            ? `✅ **تم:** \`${nameOk}\`\n❌ **فشل:** \`${nameFail}\``
                                            : '`—` بدون تغيير أسماء';

                                        const allSuccess = movFail === 0 && nameFail === 0 && plannedUnusedBots === 0 && plannedUnusedRooms === 0;
                                        const allFailed = movOk === 0 && nameOk === 0;
                                        const resultTitle = allSuccess
                                            ? '✅ Distribution Complete'
                                            : allFailed
                                                ? '❌ Distribution Failed'
                                                : '⚠️ Distribution Done';

                                        const resultEmbed = buildDistributionEmbed(
                                            resultTitle,
                                            [
                                                `**Owner :** *<@${interaction.user.id}>*`,
                                                `**Scope :** *${scopeLabels[state.scope] || state.scope}*`,
                                                `**Mode :** *${modeLabel}*`,
                                                `**Rooms :** *<#${state.firstChannelId}> → <#${state.lastChannelId}>*`,
                                                '**Rule :** *بوت واحد لكل روم بدون تكديس.*',
                                                '',
                                                buildSimpleProgressBar(plan.assignments.length, plan.assignments.length),
                                            ].join('\n'),
                                            [
                                                {
                                                    name: '🔊 Voice Move',
                                                    value: `**1. Success :** *\`${movOk}\`*\n**2. Failed :** *\`${movFail}\`*\n**3. Total :** *\`${plannedAssignments}\`*`,
                                                    inline: true,
                                                },
                                                {
                                                    name: '📝 Names',
                                                    value: nameField,
                                                    inline: true,
                                                },
                                                {
                                                    name: '📊 Rooms',
                                                    value: `**1. Selected :** *\`${plan.rooms.length}\`*\n**2. Used :** *\`${plan.assignments.length}\`*\n**3. Unused :** *\`${plan.unusedRooms.length}\`*`,
                                                    inline: true,
                                                },
                                                {
                                                    name: '⏱️ Timing',
                                                    value: `**Elapsed :** *\`${formatShortDuration(Date.now() - distributionStartedAt)}\`*\n**Batch :** *\`${SETTINGS_DISTRIBUTION_BATCH_SIZE}\`*`,
                                                    inline: true,
                                                },
                                                {
                                                    name: '⚖️ Skipped',
                                                    value: `**Extra Bots :** *\`${plan.unusedBots.length}\`*\n**Extra Rooms :** *\`${plan.unusedRooms.length}\`*`,
                                                    inline: true,
                                                },
                                                {
                                                    name: '📋 Details',
                                                    value: details.slice(0, 10).join('\n').slice(0, 1024) || '—',
                                                    inline: false,
                                                },
                                            ],
                                        );
                                        if (detailCount > 10) {
                                            resultEmbed.addFields({ name: 'More', value: `**Extra :** *\`${detailCount - 10}\` سجل إضافي لم يُعرض.*`, inline: false });
                                        }

                                        await mainMsg.edit({
                                            content: `<@${interaction.user.id}>`,
                                            embeds: [resultEmbed],
                                            components: [],
                                            allowedMentions: { users: [interaction.user.id] },
                                        }).catch(() => {});

                                    } catch (e) {
                                        await mainMsg.edit({
                                            content: `<@${interaction.user.id}>`,
                                            embeds: [buildDistributionEmbed('❌ Distribution Failed', `**المنظم:** <@${interaction.user.id}>\n**الخطأ:** ${e.message}`)],
                                            components: [],
                                            allowedMentions: { users: [interaction.user.id] },
                                        }).catch(() => {});
                                    } finally {
                                        activeSmartDistributions.delete(lockKey);
                                        if (activeDistributionState === state) activeDistributionState = null;
                                        setTimeout(() => updatePanel(), 5000);
                                    }
                                }

                        async function startSmartDistribution(interaction) {
                                    stopChildCollector('replaced');
                                    const code = selectedCode;
                                    if (!(await requireSubscriptionGuild(interaction, 'التوزيع الذكي', code))) return;

                            if (activeDistributionCollector) activeDistributionCollector.stop('restart');

                                    const state = {
                                        code,
                                        scope: null,
                        firstChannelId: null,
                        lastChannelId: null,
                        mode: null,
                        namePrefix: null,
                        namesWithNumbers: null,
                    };
                    activeDistributionState = state;

                            const renderScope = async (i = interaction) => {
                                const buckets = distributionBuckets(state.code);
                                const embed = buildDistributionEmbed(
                                    `Smart Distribution — ${state.code}`,
                            'اختر نوع البوتات التي تريد توزيعها أولاً.',
                            [
                                { name: 'Idle Bots', value: `\`${buckets.idle.length}\``, inline: true },
                                { name: 'Grouped Bots', value: `\`${buckets.grouped.length}\``, inline: true },
                                { name: 'Available Bots', value: `\`${buckets.available.length}\``, inline: true },
                            ]
                        );

                        const select = new StringSelectMenuBuilder()
                            .setCustomId(`stg_dist_${mid}_scope`)
                            .setPlaceholder('Select distribution scope')
                            .addOptions([
                                { label: 'Idle Only', value: 'idle', description: 'البوتات الموجودة بالسيرفر وليست داخل فويس' },
                                { label: 'Grouped In One Voice', value: 'grouped', description: 'البوتات الموجودة مع بوتات أخرى في نفس الفويس' },
                                { label: 'All Available', value: 'all', description: 'إعادة توزيع كل البوتات المتاحة داخل السيرفر' },
                            ]);

                        const rows = [
                            new ActionRowBuilder().addComponents(select),
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_back_rooms`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                            ),
                        ];

                        return i.update({ content: '', embeds: [embed], components: rows });
                    };

                    const renderNoIdleWarning = async (i) => {
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`stg_dist_${mid}_redistribute_all`).setLabel('Redistribute All').setStyle(ButtonStyle.Danger),
                            new ButtonBuilder().setCustomId(`stg_dist_${mid}_scope_back`).setLabel('Choose Again').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`stg_dist_${mid}_back_rooms`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                        );

                        return i.update({
                            content: '',
                            embeds: [buildDistributionEmbed(
                                'No Idle Bots',
                                'كل البوتات المتاحة موجودة داخل رومات. هل تريد إعادة توزيعهم كلهم؟\n\n**تنبيه:** هذا سينقل البوتات من روماتها الحالية.'
                            )],
                            components: [row],
                        });
                    };

                    const renderFirstChannel = async (i) => {
                        const select = new ChannelSelectMenuBuilder()
                            .setCustomId(`stg_dist_${mid}_first`)
                            .setPlaceholder('Search and select first voice room')
                            .setChannelTypes(ChannelType.GuildVoice);
                        const row = new ActionRowBuilder().addComponents(select);
                        const back = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`stg_dist_${mid}_scope_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                        );

                        return i.update({
                            content: '',
                            embeds: [buildDistributionEmbed('Smart Distribution', 'اختر **أول روم** من منيو البحث.')],
                            components: [row, back],
                        });
                    };

                    const renderLastChannel = async (i) => {
                        const select = new ChannelSelectMenuBuilder()
                            .setCustomId(`stg_dist_${mid}_last`)
                            .setPlaceholder('Search and select last voice room')
                            .setChannelTypes(ChannelType.GuildVoice);
                        const row = new ActionRowBuilder().addComponents(select);
                        const back = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`stg_dist_${mid}_first_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                        );

                        return i.update({
                            content: '',
                            embeds: [buildDistributionEmbed(
                                'Smart Distribution',
                                `أول روم: <#${state.firstChannelId}>\nاختر **آخر روم** من منيو البحث.`
                            )],
                            components: [row, back],
                        });
                    };

                            const renderMode = async (i) => {
                                let previewLines = [];
                                try {
                                    const previewChannels = await getDistributionChannels(state.firstChannelId, state.lastChannelId);
                                    const previewPlan = buildDistributionPlan(distributionTargets(state.scope, state.code), previewChannels);
                                    previewLines = [
                                        `**Available Bots :** *\`${previewPlan.bots.length}\`*`,
                                        `**Selected Rooms :** *\`${previewPlan.rooms.length}\`*`,
                                        `**Will Move :** *\`${previewPlan.assignments.length}\`*`,
                                        `**Extra Bots :** *\`${previewPlan.unusedBots.length}\`*`,
                                        `**Extra Rooms :** *\`${previewPlan.unusedRooms.length}\`*`,
                                    ];
                                } catch (err) {
                                    return i.update({
                                        content: '',
                                        embeds: [buildDistributionEmbed('Smart Distribution', `تعذر تجهيز مدى الرومات.\n\n**الخطأ:** ${err.message}`)],
                                        components: [new ActionRowBuilder().addComponents(
                                            new ButtonBuilder().setCustomId(`stg_dist_${mid}_last_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                                        )],
                                    });
                                }

                                const select = new StringSelectMenuBuilder()
                                    .setCustomId(`stg_dist_${mid}_mode`)
                                    .setPlaceholder('Select naming mode')
                            .addOptions([
                                { label: 'Room Names', value: 'names', description: 'يسمي كل بوت باسم الروم (اختياري : مع أرقام)' },
                                { label: 'Numbered Names', value: 'numbers', description: 'اسم مخصص + رقم: Ahmed1, Ahmed2 أو أرقام فقط: 1, 2, 3' },
                                { label: 'No Rename', value: 'none', description: 'توزيع البوتات بدون تغيير أسمائها' },
                            ]);
                        const row = new ActionRowBuilder().addComponents(select);
                        const back = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`stg_dist_${mid}_last_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                        );

                        return i.update({
                            content: '',
                            embeds: [buildDistributionEmbed(
                                'Smart Distribution',
                                [
                                            `النطاق: **${state.scope === 'idle' ? 'الخاملين' : state.scope === 'grouped' ? 'المتجمعين' : 'الكل'}**`,
                                            `الرومات: <#${state.firstChannelId}> → <#${state.lastChannelId}>`,
                                            '',
                                            '**خطة التوزيع:**',
                                            ...previewLines,
                                            '',
                                            '**قاعدة الأمان:** بوت واحد لكل روم، ولا يتم تكديس الزائد.',
                                            '',
                                            'اختر وضع التسمية.',
                                        ].join('\n')
                                    )],
                            components: [row, back],
                        });
                    };

                    const renderNamesConfirm = async (i) => {
                        return i.update({
                            content: '',
                            embeds: [buildDistributionEmbed(
                                'Smart Distribution — أسماء الرومات',
                                [
                                    `النطاق: **${state.scope === 'idle' ? 'الخاملين' : state.scope === 'grouped' ? 'المتجمعين' : 'الكل'}**`,
                                    `الرومات: <#${state.firstChannelId}> → <#${state.lastChannelId}>`,
                                    '',
                                    '**هل تريد إضافة أرقام ترتيبية لأسماء الرومات؟**',
                                    '`مع أرقام` ← روم A 1 ، روم B 2 ، روم C 3',
                                    '`بدون أرقام` ← روم A ، روم B ، روم C',
                                ].join('\n')
                            )],
                            components: [new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_names_withnum`).setLabel('With Numbers').setStyle(ButtonStyle.Primary),
                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_names_nonum`).setLabel('Without Numbers').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_last_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                            )],
                        });
                    };

                            const showNumbersModal = async (i) => {
                                const modal = new ModalBuilder()
                                    .setCustomId(createSettingsModalId('dist_prefix', { code: state.code }))
                                    .setTitle('Numbered Names — Bot Names');
                        modal.addComponents(new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('prefix')
                                .setLabel('Shared Name (or 0 for numbers only)')
                                .setPlaceholder('Ahmed → Ahmed1, Ahmed2 ... or 0 for numbers only (1, 2, 3)')
                                .setRequired(true)
                                .setStyle(TextInputStyle.Short)
                                .setMaxLength(28)
                        ));
                        return i.showModal(modal);
                    };

                    await renderScope();

                            const distCollector = mainMsg.createMessageComponentCollector({
                                filter: i => i.user.id === userId && i.customId.startsWith(`stg_dist_${mid}_`),
                                time: 180000,
                            });
                            activeDistributionCollector = distCollector;
                            replaceChildCollector(distCollector);

                    distCollector.on('collect', async i => {
                        if (i.customId === `stg_dist_${mid}_back_rooms`) {
                            distCollector.stop('back');
                            currentPanel = 'ROOMS';
                            return updatePanel(i);
                        }

                        if (i.customId === `stg_dist_${mid}_scope_back`) {
                            state.scope = null;
                            return renderScope(i);
                        }

                        if (i.customId === `stg_dist_${mid}_first_back`) {
                            state.firstChannelId = null;
                            return renderFirstChannel(i);
                        }

                        if (i.customId === `stg_dist_${mid}_last_back`) {
                            state.lastChannelId = null;
                            return renderLastChannel(i);
                        }

                        if (i.customId === `stg_dist_${mid}_redistribute_all`) {
                            state.scope = 'all';
                            return renderFirstChannel(i);
                        }

                                if (i.customId === `stg_dist_${mid}_scope`) {
                                    state.scope = i.values[0];
                                    const buckets = distributionBuckets(state.code);
                                    const targets = distributionTargets(state.scope, state.code);

                            if (state.scope === 'idle' && targets.length === 0 && buckets.available.length > 0 && buckets.available.length === buckets.inRoom.length) {
                                return renderNoIdleWarning(i);
                            }

                            if (targets.length === 0) {
                                return i.update({
                                    content: '',
                                    embeds: [buildDistributionEmbed('Smart Distribution', 'لا توجد بوتات مناسبة لهذا الخيار حالياً.')],
                                    components: [new ActionRowBuilder().addComponents(
                                        new ButtonBuilder().setCustomId(`stg_dist_${mid}_scope_back`).setLabel('Choose Again').setStyle(ButtonStyle.Secondary),
                                        new ButtonBuilder().setCustomId(`stg_dist_${mid}_back_rooms`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                                    )],
                                });
                            }

                            return renderFirstChannel(i);
                        }

                        if (i.customId === `stg_dist_${mid}_first`) {
                            state.firstChannelId = i.values[0];
                            return renderLastChannel(i);
                        }

                        if (i.customId === `stg_dist_${mid}_last`) {
                            state.lastChannelId = i.values[0];
                            return renderMode(i);
                        }

                        if (i.customId === `stg_dist_${mid}_mode`) {
                            state.mode = i.values[0];
                            if (state.mode === 'none') {
                                distCollector.stop('execute');
                                return executeSmartDistribution(i, state);
                            }
                            if (state.mode === 'names') {
                                return renderNamesConfirm(i);
                            }
                            if (state.mode === 'numbers') {
                                return showNumbersModal(i);
                            }
                        }

                        if (i.customId === `stg_dist_${mid}_names_withnum`) {
                            state.namesWithNumbers = true;
                            distCollector.stop('execute');
                            return executeSmartDistribution(i, state);
                        }

                        if (i.customId === `stg_dist_${mid}_names_nonum`) {
                            state.namesWithNumbers = false;
                            distCollector.stop('execute');
                            return executeSmartDistribution(i, state);
                        }
                    });

                            distCollector.on('end', (_, reason) => {
                                if (activeDistributionCollector === distCollector) activeDistributionCollector = null;
                                if (reason !== 'execute' && activeDistributionState === state) activeDistributionState = null;
                                if (reason === 'time') mainMsg.edit({ components: disableRows(mainMsg.components) }).catch(() => {});
                            });
                        }

                                async function startPinRoom(interaction) {
                                    stopChildCollector('replaced');
                                    const code = selectedCode;
                                    if (!(await requireSubscriptionGuild(interaction, 'تثبيت الروم', code))) return;

                            const state = { code, scope: null, channelId: null };

                            const renderScope = async (i = interaction) => {
                                const buckets = distributionBuckets(state.code);
                                const embed = buildDistributionEmbed(
                                    `Pin Bots To Room — ${state.code}`,
                            'اختر مجموعة البوتات التي تريد تثبيتها كلها في روم واحد.',
                            [
                                { name: 'Idle', value: `\`${buckets.idle.length}\``, inline: true },
                                { name: 'Grouped', value: `\`${buckets.grouped.length}\``, inline: true },
                                { name: 'In Voice', value: `\`${buckets.inRoom.length}\``, inline: true },
                                { name: 'Available', value: `\`${buckets.available.length}\``, inline: true },
                            ],
                        );
                        const select = new StringSelectMenuBuilder()
                            .setCustomId(`stg_pin_${mid}_scope`)
                            .setPlaceholder('Select bots scope')
                            .addOptions([
                                { label: 'Idle Only', value: 'idle', description: 'البوتات داخل السيرفر وخارج الفويس' },
                                { label: 'Grouped Only', value: 'grouped', description: 'البوتات المتجمعة مع بوتات أخرى في نفس الروم' },
                                { label: 'In Voice Only', value: 'in_room', description: 'كل البوتات الموجودة حالياً داخل رومات' },
                                { label: 'All Available', value: 'all', description: 'كل البوتات المتصلة والموجودة في السيرفر' },
                            ]);
                        return i.update({
                            content: '',
                            embeds: [embed],
                            components: [
                                new ActionRowBuilder().addComponents(select),
                                new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setCustomId(`stg_pin_${mid}_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary),
                                ),
                            ],
                        });
                    };

                            const renderChannel = async (i) => {
                                const targets = distributionTargets(state.scope, state.code);
                        if (!targets.length) {
                            return i.update({
                                content: '',
                                embeds: [buildDistributionEmbed('Pin Bots To Room', 'لا توجد بوتات مناسبة لهذا النطاق حالياً.')],
                                components: [new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setCustomId(`stg_pin_${mid}_scope_back`).setLabel('Choose Again').setStyle(ButtonStyle.Secondary),
                                    new ButtonBuilder().setCustomId(`stg_pin_${mid}_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary),
                                )],
                            });
                        }

                        const select = new ChannelSelectMenuBuilder()
                            .setCustomId(`stg_pin_${mid}_channel`)
                            .setPlaceholder('Select target voice room')
                            .setChannelTypes(ChannelType.GuildVoice);
                        return i.update({
                            content: '',
                            embeds: [buildDistributionEmbed(
                                'Pin Bots To Room',
                                `النطاق: **${SCOPE_LABELS[state.scope] || state.scope}**\nالبوتات المستهدفة: **${targets.length}**\nاختر الروم الذي سيتم تثبيتهم فيه.`,
                            )],
                            components: [
                                new ActionRowBuilder().addComponents(select),
                                new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setCustomId(`stg_pin_${mid}_scope_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary),
                                ),
                            ],
                        });
                    };

                    await renderScope();

                            const pinCollector = mainMsg.createMessageComponentCollector({
                                filter: i => i.user.id === userId && i.customId.startsWith(`stg_pin_${mid}_`),
                                time: 120000,
                            });
                            replaceChildCollector(pinCollector);

                    pinCollector.on('collect', async i => {
                        if (i.customId === `stg_pin_${mid}_back`) {
                            pinCollector.stop('back');
                            currentPanel = 'ROOMS';
                            return updatePanel(i);
                        }
                        if (i.customId === `stg_pin_${mid}_scope_back`) {
                            state.scope = null;
                            return renderScope(i);
                        }
                        if (i.customId === `stg_pin_${mid}_scope`) {
                            state.scope = i.values[0];
                            return renderChannel(i);
                        }
                        if (i.customId === `stg_pin_${mid}_channel`) {
                            state.channelId = i.values[0];
                            pinCollector.stop('execute');
                            await i.update({
                                content: `<@${userId}>`,
                                    embeds: [buildProcessEmbed('Pin Bots To Room', 0, distributionTargets(state.scope, state.code).length, 0, 0, [`⏳ Target room: <#${state.channelId}>`])],
                                components: [],
                                allowedMentions: { users: [userId] },
                            });
                                    const targets = distributionTargets(state.scope, state.code);
                                    await runBotProcess(`Pin Bots To Room — ${SCOPE_LABELS[state.scope] || state.scope}`, targets, async (t) => {
                                        await moveTokenToVoice(t, state.channelId);
                                    }, { code: state.code });
                            store.set('tokens', tokens);
                            setTimeout(() => updatePanel(), 3500);
                        }
                    });

                    pinCollector.on('end', (_, reason) => {
                        if (reason === 'time') mainMsg.edit({ components: disableRows(mainMsg.components) }).catch(() => {});
                    });
                }

        async function updatePanel(interaction = null) {
            try {
                let embeds = [];
                let components = [];
                let content = '';

                        if (currentPanel === 'SELECT') {
                            const totalPages = Math.max(1, Math.ceil(uniqueCodes.length / SETTINGS_SELECT_PAGE_SIZE));
                            selectPage = Math.max(0, Math.min(selectPage, totalPages - 1));
                            const pageCodes = uniqueCodes.slice(
                                selectPage * SETTINGS_SELECT_PAGE_SIZE,
                                (selectPage + 1) * SETTINGS_SELECT_PAGE_SIZE,
                            );
                            content = [
                                '**Select Subscription**',
                                'اختر الاشتراك الذي تريد التحكم به:',
                                '',
                                `Page: \`${selectPage + 1}/${totalPages}\` | Total: \`${uniqueCodes.length}\``,
                            ].join('\n');
                            const emojiData = store.get('emojis') || { emojis: [] };
                            const muEmojis = emojiData.emojis || [];
                            const selectMenu = new StringSelectMenuBuilder()
                                .setCustomId(`stg_${mid}_select_sub`)
                                .setPlaceholder('Select subscription')
                                .addOptions(pageCodes.map((code, index) => {
                                    const isPrimary = primaryOwnerIdFor(code) === userId;
                                    const timeData = store.get('time') || [];
                                    const subInfo = timeData.find(t => t.code === code);
                            const botsCount = subInfo?.botsCount || (store.get('tokens') || []).filter(t => t.code === code).length;
                            const isSubOwnerAccess = !isPrimary && !isAdmin;
                            const opt = {
                                label: isPrimary || isAdmin
                                    ? `Music x${botsCount} (${code})`
                                    : `Shared sub ${code}`,
                                description: isSubOwnerAccess
                                    ? `اشتراك ${code} — owners only`
                                    : `اشتراك ${code}`,
                                value: code,
                            };
                            const resolvedEmoji = resolveRawEmoji(client, muEmojis[index]);
                                    if (resolvedEmoji) opt.emoji = resolvedEmoji;
                                    return opt;
                                }));
                            components.push(new ActionRowBuilder().addComponents(selectMenu));
                            if (totalPages > 1) {
                                components.push(new ActionRowBuilder().addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`stg_${mid}_select_prev`)
                                        .setLabel('Previous')
                                        .setStyle(ButtonStyle.Secondary)
                                        .setDisabled(selectPage === 0),
                                    new ButtonBuilder()
                                        .setCustomId(`stg_${mid}_select_next`)
                                        .setLabel('Next')
                                        .setStyle(ButtonStyle.Secondary)
                                        .setDisabled(selectPage >= totalPages - 1),
                                ));
                            }
                        }
                else if (currentPanel === 'MAIN') {
                    const allSubTokens = getSelectedTokens({ includeWaiting: true });
                    const subTokens = getSelectedTokens();
                    const timeData = store.get('time') || [];
                    const subInfo = timeData.find(t => t.code === selectedCode);
                    const primaryOwnerId = primaryOwnerIdFor(selectedCode) || subInfo?.user || subTokens[0]?.client || allSubTokens[0]?.client;
                    const subOwnerIds = subscriptionOwnerIdsFor(selectedCode);
                    const display = getDisplay(selectedCode);
                    const chat = chatSummary(subTokens);
                    const backVoice = backToVoiceSummary(allSubTokens);
                    const waitingCount = allSubTokens.length - subTokens.length;
                    const voiceStats = subTokens.reduce((acc, t) => {
                        const info = getBotVoiceInfo(t);
                        if (!info.bot) acc.offline++;
                        else if (!info.inServer) acc.outside++;
                        else if (info.inRoom) acc.inRoom++;
                        else acc.idle++;
                        return acc;
                    }, { inRoom: 0, idle: 0, outside: 0, offline: 0 });

                    // Is the current user the primary owner or a bot admin?
                    const isPrimaryOrAdmin = isAdmin || (primaryOwnerId && primaryOwnerId === userId);

                            const panelTitle = isPrimaryOrAdmin
                                ? `Subscription Settings — ${selectedCode}`
                                : `Subscription Settings — ${selectedCode} *(Shared Access)*`;

                    const embedFields = [
                        {
                            name: 'Owner',
                            value: primaryOwnerId ? `*<@${primaryOwnerId}>*` : '*`غير معروف`*',
                            inline: true
                        },
                        {
                            name: 'Bots',
                            value: [
                                `**نشط :** *\`${subTokens.length}\`*`,
                                waitingCount ? `**انتظار :** *\`${waitingCount}\`*` : null,
                            ].filter(Boolean).join('\n'),
                            inline: true
                        },
                        {
                            name: 'Server',
                            value: `**ID :** *\`${subTokens[0]?.Server || allSubTokens[0]?.Server || 'غير محدد'}\`*`,
                            inline: true
                        },
                        {
                            name: 'Expiry',
                            value: subInfo?.expirationTime
                                ? `**الوقت :** *<t:${Math.floor(subInfo.expirationTime / 1000)}:R>*`
                                : '**الوقت :** *`غير معروف`*',
                            inline: true
                        },
                        {
                            name: 'Owners',
                            value: subOwnerIds.length
                                ? subOwnerIds.map(id => `*<@${id}>*`).join('\n')
                                : '*`لا يوجد`*',
                            inline: true
                        },
                        {
                            name: 'Display',
                            value: [
                                `**الأزرار :** *${display.buttons ? '`ON`' : '`OFF`'}*`,
                                `**الإيمبد :** *${display.embeds ? '`ON`' : '`OFF`'}*`,
                                `**حالة الروم :** *${display.voiceStatus ? '`ON`' : '`OFF`'}*`,
                            ].join('\n'),
                            inline: true
                        },
                        {
                            name: 'Platform',
                            value: `**المصدر :** *\`${display.platform}\`*`,
                            inline: true
                        },
                        {
                            name: 'Back to Voice',
                            value: [
                                `**الحالة :** ${backVoice.label}`,
                                `**تفاصيل :** *${backVoice.details}*`,
                            ].join('\n'),
                            inline: true
                        },
                        {
                            name: 'Command Chat',
                            value: [
                                `**الشات :** ${chat.label}`,
                                `**تفاصيل :** *${chat.details}*`,
                            ].join('\n'),
                            inline: false
                        },
                        {
                            name: 'Voice Status',
                            value: [
                                `**في روم :** *\`${voiceStats.inRoom}\`*`,
                                `**خامل :** *\`${voiceStats.idle}\`*`,
                                `**خارج السيرفر :** *\`${voiceStats.outside}\`*`,
                                `**غير متصل :** *\`${voiceStats.offline}\`*`,
                            ].join('\n'),
                            inline: false
                        },
                    ];

                    const embed = new EmbedBuilder()
                        .setTitle(panelTitle)
                        .setDescription('تحكم سريع ومنظم في البوتات، العرض، الغرف، والمنصة.')
                        .addFields(embedFields)
                        .setColor(getEmbedColor(client));

                    embeds.push(embed);

                            const row1 = new ActionRowBuilder().addComponents(
                                new StringSelectMenuBuilder()
                                    .setCustomId(`stg_${mid}_main_menu`)
                                    .setPlaceholder('Select section')
                                    .addOptions([
                                        settingsOption(client, { label: 'Appearance', value: 'APPEARANCE', description: 'تغيير الصورة، البنر، والحالة لكل البوتات' }, SETTINGS_EMOJI.appearance),
                                                settingsOption(client, { label: 'Rooms', value: 'ROOMS', description: 'الغرف، التوزيع الذكي، الروابط، وشات الأوامر' }, SETTINGS_EMOJI.rooms),
                                        settingsOption(client, { label: 'Display', value: 'DISPLAY', description: 'تفعيل أو تعطيل الأزرار والإيمبد' }, SETTINGS_EMOJI.display),
                                        settingsOption(client, { label: 'Platform', value: 'PLATFORM', description: 'اختيار منصة البحث والتشغيل' }, SETTINGS_EMOJI.platform),
                                        ...(canManageSubscriptionOwners(selectedCode)
                                                    ? [settingsOption(client, { label: 'Owners', value: 'OWNERS', description: 'إضافة وإزالة أونرز يتحكمون ببوتات الاشتراك' }, SETTINGS_EMOJI.owners)]
                                            : []),
                                    ])
                            );
                    const row2 = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_${mid}_close`).setLabel('Close').setStyle(ButtonStyle.Danger)
                    );
                    if (uniqueCodes.length > 1) {
                        row2.addComponents(new ButtonBuilder().setCustomId(`stg_${mid}_back_to_select`).setLabel('Change Subscription').setStyle(ButtonStyle.Secondary));
                    }
                    components.push(row1, row2);
                }
                else if (currentPanel === 'OWNERS') {
                    if (!canManageSubscriptionOwners(selectedCode)) {
                        currentPanel = 'MAIN';
                        return updatePanel(interaction);
                    }

                    const primaryOwnerId = primaryOwnerIdFor(selectedCode);
                    const subOwnerIds = subscriptionOwnerIdsFor(selectedCode);
                    const embed = new EmbedBuilder()
                        .setTitle(`Subscribe Owners — ${selectedCode}`)
                        .addFields(
                            {
                                name: 'Subscription Owner',
                                value: primaryOwnerId ? `*<@${primaryOwnerId}>*` : '*`غير معروف`*',
                                inline: true,
                            },
                            {
                                name: 'Current Owners',
                                value: subOwnerIds.length
                                    ? subOwnerIds.map((id, i) => `**${i + 1} :** *<@${id}>*`).join('\n')
                                    : '*`لا يوجد`*',
                                inline: false,
                            },
                            {
                                name: 'Permissions',
                                value: [
                                    '**يقدرون :** *استخدام Settings وأوامر التحكم مثل join / setup / settc.*',
                                    '**لا يقدرون :** *نقل الملكية أو نقل الاشتراك — تبقى للمالك الأصلي فقط.*',
                                ].join('\n'),
                                inline: false,
                            },
                        )
                        .setColor(getEmbedColor(client));
                    embeds.push(embed);

                            components.push(new ActionRowBuilder().addComponents(
                                        setSettingsEmoji(client, new ButtonBuilder().setCustomId(`stg_${mid}_owner_add`).setLabel('Add Owner').setStyle(ButtonStyle.Success), SETTINGS_EMOJI.addOwner),
                                        setSettingsEmoji(client, new ButtonBuilder().setCustomId(`stg_${mid}_owner_remove`).setLabel('Remove Owner').setStyle(ButtonStyle.Danger).setDisabled(subOwnerIds.length === 0), SETTINGS_EMOJI.removeOwner),
                                new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary),
                            ));
                }
                else if (currentPanel === 'APPEARANCE') {
                            const embed = new EmbedBuilder()
                                .setTitle(`Appearance Settings — ${selectedCode}`)
                                .setDescription('تحكم في الاسم، الصورة، البنر، وحالة الستريمنق لكل بوتات هذا الاشتراك.')
                        .setColor(getEmbedColor(client));
                    embeds.push(embed);

                                    const row = new ActionRowBuilder().addComponents(
                                        setSettingsEmoji(client, new ButtonBuilder().setCustomId(`stg_${mid}_set_name`).setLabel('Name').setStyle(ButtonStyle.Secondary), SETTINGS_EMOJI.name),
                                        setSettingsEmoji(client, new ButtonBuilder().setCustomId(`stg_${mid}_set_avatar`).setLabel('Avatar').setStyle(ButtonStyle.Secondary), SETTINGS_EMOJI.avatar),
                                        setSettingsEmoji(client, new ButtonBuilder().setCustomId(`stg_${mid}_set_banner`).setLabel('Banner').setStyle(ButtonStyle.Secondary), SETTINGS_EMOJI.banner),
                                        setSettingsEmoji(client, new ButtonBuilder().setCustomId(`stg_${mid}_set_status`).setLabel('Status').setStyle(ButtonStyle.Secondary), SETTINGS_EMOJI.status),
                                new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                            );
                    components.push(row);
                }
                        else if (currentPanel === 'DISPLAY') {
                            const display = getDisplay(selectedCode);
                            const embed = new EmbedBuilder()
                                .setTitle(`Display Settings — ${selectedCode}`)
                                .setDescription('فعّل أو عطّل عناصر التشغيل التي تظهر للمستخدمين.')
                                .setColor(getEmbedColor(client));
                    embeds.push(embed);

                            const row = new ActionRowBuilder().addComponents(
                                        setSettingsEmoji(client, new ButtonBuilder()
                                            .setCustomId(`stg_${mid}_toggle_buttons`)
                                            .setLabel(`Buttons: ${display.buttons ? 'ON' : 'OFF'}`)
                                            .setStyle(display.buttons ? ButtonStyle.Success : ButtonStyle.Danger), SETTINGS_EMOJI.toggleButtons),
                                        setSettingsEmoji(client, new ButtonBuilder()
                                            .setCustomId(`stg_${mid}_toggle_embeds`)
                                            .setLabel(`Embeds: ${display.embeds ? 'ON' : 'OFF'}`)
                                            .setStyle(display.embeds ? ButtonStyle.Success : ButtonStyle.Danger), SETTINGS_EMOJI.toggleEmbeds),
                                new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                            );
                    components.push(row);
                }
                else if (currentPanel === 'PLATFORM') {
                    const display = getDisplay(selectedCode);
                    const embed = new EmbedBuilder()
                        .setTitle(`Platform Settings — ${selectedCode}`)
                        .setDescription(`المنصة الحالية: \`${display.platform}\``)
                        .setColor(getEmbedColor(client));
                    embeds.push(embed);

                    const platBtn = (id, lbl) => new ButtonBuilder()
                        .setCustomId(`stg_${mid}_plat_${id}`)
                        .setLabel(lbl)
                        .setEmoji(MUSIC_EMOJIS.platforms[id])
                        .setStyle(display.platform === id ? ButtonStyle.Primary : ButtonStyle.Secondary);
                    const row1 = new ActionRowBuilder().addComponents(
                        platBtn('ytsearch',  'YouTube'),
                        platBtn('ytmsearch', 'YT Music'),
                        platBtn('scsearch',  'SoundCloud')
                    );
                    const row2 = new ActionRowBuilder().addComponents(
                        platBtn('spsearch',  'Spotify'),
                        platBtn('amsearch',  'Apple Music'),
                        platBtn('dzsearch',  'Deezer'),
                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                    );
                    components.push(row1, row2);
                }
                                else if (currentPanel === 'ROOMS') {
                                    const chat = chatSummary();
                                    const backVoice = backToVoiceSummary();
                                    const display = getDisplay(selectedCode);
                                    const embed = new EmbedBuilder()
                                        .setTitle(`Room Settings — ${selectedCode}`)
                                        .setDescription([
                                            '**1. Command Chat**',
                                            `   *Channel :*  ${chat.label}`,
                                            `   *Info :*  *${chat.details}*`,
                                            '',
                                            '**2. Back to Voice**',
                                            `   *Status :*  ${backVoice.label}`,
                                            `   *Info :*  *${backVoice.details}*`,
                                            '',
                                            '**3. Voice Status**',
                                            `   *Status :*  \`${display.voiceStatus ? 'ON' : 'OFF'}\`  ${display.voiceStatusEmoji || '🎵'}`,
                                            `   *Info :*  *عند تشغيل أغنية يتم تحديث Status الروم باسم مختصر للأغنية.*`,
                                            '',
                                            '**4. Options Guide**',
                                            `   **Voice Status —** *عرض مكان كل بوت داخل روم أو خارجه.*`,
                                            `   **Smart Distribution —** *توزيع البوتات على نطاق رومات تختاره.*`,
                                            `   **Move Idle —** *تحريك البوتات الخاملة إلى روم أو أكثر.*`,
                                            `   **Status Emoji —** *تغيير الإيموجي الذي يظهر قبل اسم الأغنية.*`,
                                            `   **All Links / Outside Server —** *عرض روابط دعوة البوتات.*`,
                                        ].join('\n'))
                                        .setColor(getEmbedColor(client));
                                    embeds.push(embed);

                                    const roomsMenu = new StringSelectMenuBuilder()
                                        .setCustomId(`stg_${mid}_rooms_menu`)
                                                .setPlaceholder('Select option')
                                                .addOptions([
                                                    settingsOption(client, { label: 'Voice Status', value: 'voice_status', description: 'عرض مكان كل بوت في الرومات' }, SETTINGS_EMOJI.voiceStatus),
                                                    settingsOption(client, { label: 'Smart Distribution', value: 'distribute', description: 'توزيع البوتات على نطاق رومات' }, SETTINGS_EMOJI.distribute),
                                                    settingsOption(client, { label: 'Move Idle', value: 'moveidle', description: 'تحريك البوتات الخاملة إلى روم' }, SETTINGS_EMOJI.moveIdle),
                                                    settingsOption(client, { label: `Back to Voice : ${backVoice.enabled ? 'ON' : 'OFF'}`, value: 'toggle_back_voice', description: 'تفعيل أو تعطيل الرجوع التلقائي للروم' }, SETTINGS_EMOJI.backToVoice),
                                                    settingsOption(client, { label: `Voice Status : ${display.voiceStatus ? 'ON' : 'OFF'}`, value: 'toggle_voice_status', description: 'تفعيل أو تعطيل كتابة اسم الأغنية على Status' }, SETTINGS_EMOJI.toggleSetting),
                                                    settingsOption(client, { label: 'Command Chat', value: 'panel_chat', description: 'تحديد الشات الذي يستقبل الأوامر' }, SETTINGS_EMOJI.commandChat),
                                                    settingsOption(client, { label: 'Status Emoji', value: 'voice_status_emoji', description: 'تغيير إيموجي Status الروم' }, SETTINGS_EMOJI.statusEmoji),
                                                    settingsOption(client, { label: 'Pin Room', value: 'pin_room', description: 'تثبيت كل البوتات في روم واحد' }, SETTINGS_EMOJI.pinRoom),
                                                    settingsOption(client, { label: 'All Links', value: 'links_all', description: 'روابط دعوة كل البوتات' }, SETTINGS_EMOJI.allLinks),
                                                    settingsOption(client, { label: 'Outside Server', value: 'links_out', description: 'روابط البوتات الموجودة خارج السيرفر' }, SETTINGS_EMOJI.outsideServer),
                                                ]);
                                    const roomsRow1 = new ActionRowBuilder().addComponents(roomsMenu);
                                    const roomsRow2 = new ActionRowBuilder().addComponents(
                                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                                    );
                                    components.push(roomsRow1, roomsRow2);
                        }
                                else if (currentPanel === 'CHAT') {
                                    const chat = chatSummary();
                                    const serverId = subscriptionServerIdFor(selectedCode);
                                    const embed = new EmbedBuilder()
                                        .setTitle(`Command Chat — ${selectedCode}`)
                                        .addFields(
                                    {
                                        name: 'Current Chat',
                                        value: [
                                            `**Channel :** ${chat.label}`,
                                            `**Info :** *${chat.details}*`,
                                        ].join('\n'),
                                        inline: false,
                                    },
                                    {
                                        name: 'How It Works',
                                        value: '**Info :** *عند تحديد شات استقبال، أوامر كل البوتات تعمل فقط في شات الاستقبال أو شات الفويس الخاص بكل بوت.*',
                                        inline: false,
                                    },
                                        )
                                        .setColor(getEmbedColor(client));
                                    embeds.push(embed);

                                    if (serverId && message.guild?.id !== serverId) {
                                        embed.addFields({
                                            name: 'Server Check',
                                            value: `افتح هذا الخيار داخل سيرفر الاشتراك حتى تختار الشات الصحيح.\n**Server ID :** \`${serverId}\``,
                                            inline: false,
                                        });
                                        components.push(new ActionRowBuilder().addComponents(
                                            new ButtonBuilder().setCustomId(`stg_${mid}_panel_rooms`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                                        ));
                                    } else {
                                        const select = new ChannelSelectMenuBuilder()
                                            .setCustomId(`stg_${mid}_chat_select_all`)
                                            .setPlaceholder('Select command chat')
                                            .setChannelTypes(ChannelType.GuildText);
                                        const row1 = new ActionRowBuilder().addComponents(select);
                                        const row2 = new ActionRowBuilder().addComponents(
                                            new ButtonBuilder().setCustomId(`stg_${mid}_chat_clear_all`).setLabel('Clear Command Chat').setStyle(ButtonStyle.Danger),
                                            new ButtonBuilder().setCustomId(`stg_${mid}_panel_rooms`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                                        );
                                        components.push(row1, row2);
                                    }
                                }

                const options = { content, embeds, components };
                if (interaction && !interaction.replied && !interaction.deferred) {
                    await interaction.update(options);
                } else {
                    await mainMsg.edit(options);
                }
                    } catch (err) {
                        console.error(err);
                        await mainMsg.edit({
                            content: `❌ فشل تحميل settings: ${String(err?.message || err).slice(0, 180)}`,
                            embeds: [],
                            components: [],
                        }).catch(() => {});
                    }
                }

        await updatePanel();

                collector.on('collect', async i => {
                            if (i.customId === `stg_${mid}_select_sub`) {
                                stopChildCollector('replaced');
                                selectedCode = i.values[0];
                                currentPanel = 'MAIN';
                                return updatePanel(i);
                            }

                            if (i.customId === `stg_${mid}_select_prev`) {
                                selectPage = Math.max(0, selectPage - 1);
                                return updatePanel(i);
                            }

                            if (i.customId === `stg_${mid}_select_next`) {
                                const totalPages = Math.max(1, Math.ceil(uniqueCodes.length / SETTINGS_SELECT_PAGE_SIZE));
                                selectPage = Math.min(totalPages - 1, selectPage + 1);
                                return updatePanel(i);
                            }

                    if (i.customId === `stg_${mid}_main_menu`) {
                        stopChildCollector('replaced');
                        currentPanel = i.values[0];
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_close`) {
                        stopChildCollector('closed');
                        collector.stop('closed');
                        return i.update({ content: '✅ تم إغلاق القائمة.', embeds: [], components: [] });
                    }

                    if (i.customId === `stg_${mid}_back_to_select`) {
                        stopChildCollector('replaced');
                        currentPanel = 'SELECT';
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_back_to_main`) {
                        stopChildCollector('replaced');
                        currentPanel = 'MAIN';
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_panel_appearance`) {
                        stopChildCollector('replaced');
                        currentPanel = 'APPEARANCE';
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_panel_display`) {
                        stopChildCollector('replaced');
                        currentPanel = 'DISPLAY';
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_panel_platform`) {
                        stopChildCollector('replaced');
                        currentPanel = 'PLATFORM';
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_panel_rooms`) {
                        stopChildCollector('replaced');
                        currentPanel = 'ROOMS';
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_panel_chat`) {
                        stopChildCollector('replaced');
                        currentPanel = 'CHAT';
                        return updatePanel(i);
                    }

            // Toggles
            if (i.customId === `stg_${mid}_toggle_buttons`) {
                const cur = getDisplay(selectedCode);
                const newVal = !cur.buttons;
                setDisplay(selectedCode, { buttons: newVal });
                // Apply to tokens so music.js reads the correct value
                tokens = store.get('tokens') || [];
                tokens.forEach(t => { if (t.code === selectedCode) t.buttons = newVal ? 'on' : 'off'; });
                store.set('tokens', tokens);
                return updatePanel(i);
            }
            if (i.customId === `stg_${mid}_toggle_embeds`) {
                const cur = getDisplay(selectedCode);
                const newVal = !cur.embeds;
                setDisplay(selectedCode, { embeds: newVal });
                // Apply to tokens for consistency
                tokens = store.get('tokens') || [];
                tokens.forEach(t => { if (t.code === selectedCode) t.embeds = newVal ? 'on' : 'off'; });
                store.set('tokens', tokens);
                return updatePanel(i);
            }

            // Platform
            if (i.customId.startsWith(`stg_${mid}_plat_`)) {
                const plat = i.customId.split('_').pop();
                setDisplay(selectedCode, { platform: plat });

                // Write to tokens.source so music.js picks it up
                tokens = store.get('tokens') || [];
                tokens.forEach(t => { if (t.code === selectedCode) t.source = plat; });
                store.set('tokens', tokens);

                // Apply live to running bots immediately
                tokens.filter(t => t.code === selectedCode).forEach(entry => {
                    const bot = runningBots.get(entry.token);
                    if (bot?.poru) bot.poru.options.defaultPlatform = plat;
                });

                return updatePanel(i);
            }

                    // Appearance prompts
                                    if (i.customId === `stg_${mid}_set_name`) {
                                        const text = await promptForUserMessage(i, 'اكتب اسم البوتات الجديد خلال دقيقتين.\nمثال: `Music Pro`');
                                        if (!text) return;
                                        const safeName = text.slice(0, 32);
                                        await runBotProcess('Change Names', getSelectedTokens({ code: selectedCode }), async (t, bot) => {
                                            if (!bot?.user) throw new Error('bot offline');
                                            let lastErr = null;
                                            for (let attempt = 1; attempt <= 4; attempt++) {
                                                const r = await bot.user.setUsername(safeName).catch(e => ({ _err: e }));
                                                if (!r?._err) break;
                                                lastErr = r._err;
                                                const ra = lastErr?.rawError?.retry_after ?? lastErr?.retryAfter;
                                                const waitMs = ra ? Math.min(Math.ceil(ra * 1000) + 1500, 90_000) : Math.min(2000 * attempt, 10_000);
                                                if (attempt < 4) await new Promise(res => setTimeout(res, waitMs));
                                            }
                                            if (lastErr && bot.user.username !== safeName) throw lastErr;
                                            await patchCurrentApplication(t.token, { name: safeName }).catch(() => bot.application?.edit?.({ name: safeName }).catch(() => {}));
                                        }, { concurrency: SETTINGS_NAME_CONCURRENCY, code: selectedCode });
                                        setTimeout(() => updatePanel(), 3000);
                                        return;
                                    }

                                    if (i.customId === `stg_${mid}_set_avatar`) {
                                        const url = await promptForUserMessage(i, 'ارسل رابط الصورة أو ارفق الصورة هنا خلال دقيقتين لتغيير Avatar كل البوتات.', { allowAttachment: true });
                                        if (!url) return;
                                        let imageData;
                                        try {
                                            imageData = await fetchImageDataUri(url, 'Avatar');
                                        } catch (err) {
                                            await mainMsg.edit({ content: `❌ ${err.message}`, embeds: [], components: [] });
                                            setTimeout(() => updatePanel(), 3000);
                                            return;
                                        }
                                        await runBotProcess('Change Avatars', getSelectedTokens({ code: selectedCode }), async (t, bot) => {
                                            if (!bot?.user) throw new Error('bot offline');
                                            await stgWithRetry(() => bot.user.setAvatar(imageData));
                                            await patchCurrentApplication(t.token, { icon: imageData }).catch(() => bot.application?.edit?.({ icon: imageData }).catch(() => {}));
                                            refreshEmbedColor(bot).catch(() => {});
                                        }, { concurrency: SETTINGS_IMAGE_CONCURRENCY, code: selectedCode });
                                        setTimeout(() => updatePanel(), 3000);
                                        return;
                                    }

                                    if (i.customId === `stg_${mid}_set_status`) {
                                        const text = await promptForUserMessage(i, 'اكتب حالة الستريمنق الجديدة خلال دقيقتين.');
                                        if (!text) return;
                                        tokens = store.get('tokens') || [];
                                        tokens.forEach(t => { if (t.code === selectedCode) t.status = text; });
                                        store.set('tokens', tokens);
                                        await runBotProcess('Change Streaming Status', getSelectedTokens({ code: selectedCode }), async (t, bot) => {
                                            if (!bot?.user) throw new Error('bot offline');
                                            bot.user.setPresence({
                                                activities: [{
                                                    name: text,
                                                    type: ActivityType.Streaming,
                                                    url: getTwitchUrl() || 'https://www.twitch.tv/tnbeh',
                                                }],
                                                status: 'online',
                                            });
                                        }, { code: selectedCode });
                                        setTimeout(() => updatePanel(), 3000);
                                        return;
                                    }

                                    if (i.customId === `stg_${mid}_set_banner`) {
                                        const url = await promptForUserMessage(i, 'ارسل رابط البنر أو ارفق الصورة هنا خلال دقيقتين لتغيير Banner كل البوتات.', { allowAttachment: true });
                                        if (!url) return;
                                        let data;
                                        try {
                                            data = await fetchImageDataUri(url, 'Banner');
                                        } catch (err) {
                                            await mainMsg.edit({ content: `❌ ${err.message}`, embeds: [], components: [] });
                                            setTimeout(() => updatePanel(), 3000);
                                            return;
                                        }
                                        await runBotProcess('Change Banners', getSelectedTokens({ code: selectedCode }), async (t) => {
                                            await stgWithRetry(() => axios.patch('https://discord.com/api/v10/users/@me', { banner: data }, {
                                                headers: { Authorization: `Bot ${t.token}`, 'Content-Type': 'application/json' },
                                                timeout: SETTINGS_IMAGE_TIMEOUT_MS,
                                            }));
                                            await patchCurrentApplication(t.token, { cover_image: data }).catch(() => {});
                                        }, { concurrency: SETTINGS_IMAGE_CONCURRENCY, code: selectedCode });
                                        setTimeout(() => updatePanel(), 3000);
                                        return;
                                    }

            if (i.customId === `stg_${mid}_owner_add`) {
                if (!canManageSubscriptionOwners(selectedCode)) {
                    return i.reply({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', flags: MessageFlags.Ephemeral });
                }
                        const modal = new ModalBuilder().setCustomId(createSettingsModalId('owner_add')).setTitle('Add Subscribe Owner');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('user')
                        .setLabel('User ID or mention')
                        .setPlaceholder('@user or 123456789012345678')
                        .setRequired(true)
                        .setStyle(TextInputStyle.Short)
                ));
                await i.showModal(modal);
                return;
            }

            if (i.customId === `stg_${mid}_owner_remove`) {
                if (!canManageSubscriptionOwners(selectedCode)) {
                    return i.reply({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', flags: MessageFlags.Ephemeral });
                }
                        const modal = new ModalBuilder().setCustomId(createSettingsModalId('owner_remove')).setTitle('Remove Subscribe Owner');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('user')
                        .setLabel('User ID or mention')
                        .setPlaceholder('@user or 123456789012345678')
                        .setRequired(true)
                        .setStyle(TextInputStyle.Short)
                ));
                await i.showModal(modal);
                return;
            }

            if (i.customId === `stg_${mid}_rooms_menu`) {
                const val = i.values[0];
                if (val === 'voice_status') return handleVoiceStatus(i);
                if (val === 'distribute') return startSmartDistribution(i);
                if (val === 'moveidle') return showMoveIdleModal(i);
                if (val === 'pin_room') return startPinRoom(i);
                if (val === 'panel_chat') { currentPanel = 'CHAT'; return updatePanel(i); }
                if (val === 'links_all') return showLinksPanel(i, getSelectedTokens(), selectedCode, 'all', 'rooms');
                if (val === 'links_out') return showLinksPanel(i, getSelectedTokens(), selectedCode, 'outside', 'rooms');
                if (val === 'toggle_back_voice') {
                    tokens = store.get('tokens') || [];
                    const sel = tokens.filter(t => t.code === selectedCode);
                    const enabled = sel.some(t => t.backToVoice !== 'off');
                    sel.forEach(t => { t.backToVoice = enabled ? 'off' : 'on'; });
                    store.set('tokens', tokens);
                    return updatePanel(i);
                }
                if (val === 'toggle_voice_status') {
                    const cur = getDisplay(selectedCode);
                    const newVal = !cur.voiceStatus;
                    setDisplay(selectedCode, { voiceStatus: newVal });
                    tokens = store.get('tokens') || [];
                    const sel = tokens.filter(t => t.code === selectedCode);
                    sel.forEach(t => { t.voiceStatus = newVal ? 'on' : 'off'; });
                    store.set('tokens', tokens);
                    if (!newVal) {
                        await runLimited(sel, SETTINGS_PROCESS_CONCURRENCY, async t => {
                            const bot = runningBots.get(t.token);
                            const channelId = bot?.guilds.cache.get(t.Server)?.members.me?.voice?.channelId;
                            if (bot?.rest && channelId) {
                                await bot.rest.put(`/channels/${channelId}/voice-status`, { body: { status: null } }).catch(() => {});
                            }
                        });
                    }
                    return updatePanel(i);
                }
                        if (val === 'voice_status_emoji') {
                            const modal = new ModalBuilder().setCustomId(createSettingsModalId('voice_status_emoji')).setTitle('Voice Status Emoji');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('emoji')
                            .setLabel('Emoji before track name')
                            .setPlaceholder('🎵 or <:music:123456789012345678>')
                            .setRequired(true)
                            .setStyle(TextInputStyle.Short)
                    ));
                    await i.showModal(modal);
                    return;
                }
                return;
            }

            if (i.customId === `stg_${mid}_distribute`) {
                return startSmartDistribution(i);
            }

            if (i.customId === `stg_${mid}_pin_room`) {
                return startPinRoom(i);
            }

                    if (i.customId === `stg_${mid}_chat_select_all`) {
                        if (!(await requireSubscriptionGuild(i, 'Command Chat'))) return;
                        const channelId = i.values[0];
                tokens = store.get('tokens') || [];
                tokens.forEach(t => {
                    if (t.code === selectedCode) t.chat = channelId;
                });
                store.set('tokens', tokens);

                await i.update({
                    content: '',
                    embeds: [new EmbedBuilder()
                        .setTitle('Command Chat Updated')
                        .setDescription(`تم تحديد شات استقبال الأوامر لكل بوتات الاشتراك: <#${channelId}>`)
                        .setColor(getEmbedColor(client))],
                    components: [],
                });
                setTimeout(() => updatePanel(), 2500);
                return;
            }

            if (i.customId === `stg_${mid}_chat_clear_all`) {
                tokens = store.get('tokens') || [];
                tokens.forEach(t => {
                    if (t.code === selectedCode) delete t.chat;
                });
                store.set('tokens', tokens);

                await i.update({
                    content: '',
                    embeds: [new EmbedBuilder()
                        .setTitle('Command Chat Cleared')
                        .setDescription('تم إلغاء شات استقبال الأوامر لكل بوتات الاشتراك.')
                        .setColor(getEmbedColor(client))],
                    components: [],
                });
                setTimeout(() => updatePanel(), 2500);
                return;
            }

                        });

                // Handle Modal Submits
                        const modalHandler = async (interaction) => {
                            if (!interaction.isModalSubmit()) return;
                            if (!interaction.customId.startsWith(`stg_mod_${mid}_`)) return;

                                    await interaction.deferUpdate();
                                    const modalContext = consumeSettingsModalContext(interaction.customId);
                                    if (!modalContext) return;
                                    const modalCode = modalContext.code || selectedCode;

                            // ── توزيع ذكي: modal اسم الترقيم ─────────────────────────────
                            if (modalContext.type === 'dist_prefix') {
                                if (!activeDistributionState || activeDistributionState.code !== modalCode) {
                                    await mainMsg.edit({
                                        content: 'انتهت جلسة التوزيع الذكي أو تغير الاشتراك. افتح التوزيع مرة أخرى.',
                                        embeds: [],
                                        components: [],
                                    }).catch(() => {});
                                    setTimeout(() => updatePanel(), 2500);
                                    return;
                                }
                                const input = interaction.fields.getTextInputValue('prefix').trim();
                                activeDistributionState.namePrefix = input === '0' ? '' : input;
                        if (activeDistributionCollector) activeDistributionCollector.stop('execute');
                        return executeSmartDistribution(interaction, activeDistributionState);
                    }

                            if (modalContext.type === 'owner_add') {
                                if (!canManageSubscriptionOwners(modalCode)) {
                                    await mainMsg.edit({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', embeds: [], components: [] });
                                    setTimeout(() => updatePanel(), 2500);
                                    return;
                                }
                                const targetId = parseUserId(interaction.fields.getTextInputValue('user'));
                                const primary = primaryOwnerIdFor(modalCode);
                        if (!targetId) {
                            await mainMsg.edit({ content: '❌ اكتب منشن أو ID صحيح.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 2500);
                            return;
                        }
                        if (targetId === primary) {
                            await mainMsg.edit({ content: '⚠️ مالك الاشتراك موجود أساساً ولا يحتاج إضافته كأونر.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 2500);
                            return;
                        }
                                const current = subscriptionOwnerIdsFor(modalCode);
                                const next = setSubscriptionOwnersFor(modalCode, [...current, targetId]);
                        await mainMsg.edit({
                            content: '',
                            embeds: [new EmbedBuilder()
                                .setTitle('Subscribe Owner Added')
                                .setDescription(`تمت إضافة <@${targetId}> كأونر للاشتراك.\n\n**الأونرز الآن:**\n${next.length ? next.map(id => `<@${id}>`).join('\n') : '`لا يوجد`'}`)
                                .setColor(getEmbedColor(client))],
                            components: [],
                        });
                        setTimeout(() => updatePanel(), 3000);
                        return;
                    }

                            if (modalContext.type === 'owner_remove') {
                                if (!canManageSubscriptionOwners(modalCode)) {
                                    await mainMsg.edit({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', embeds: [], components: [] });
                                    setTimeout(() => updatePanel(), 2500);
                                    return;
                                }
                                const targetId = parseUserId(interaction.fields.getTextInputValue('user'));
                                const primary = primaryOwnerIdFor(modalCode);
                        if (!targetId) {
                            await mainMsg.edit({ content: '❌ اكتب منشن أو ID صحيح.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 2500);
                            return;
                        }
                        if (targetId === primary) {
                            await mainMsg.edit({ content: '❌ لا يمكن حذف مالك الاشتراك الأصلي من الأونرز.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 2500);
                            return;
                        }
                                const current = subscriptionOwnerIdsFor(modalCode);
                                const next = setSubscriptionOwnersFor(modalCode, current.filter(id => id !== targetId));
                        await mainMsg.edit({
                            content: '',
                            embeds: [new EmbedBuilder()
                                .setTitle('Subscribe Owner Removed')
                                .setDescription(`تمت إزالة <@${targetId}> من أونرز الاشتراك.\n\n**الأونرز الآن:**\n${next.length ? next.map(id => `<@${id}>`).join('\n') : '`لا يوجد`'}`)
                                .setColor(getEmbedColor(client))],
                            components: [],
                        });
                        setTimeout(() => updatePanel(), 3000);
                        return;
                    }

                                    if (modalContext.type === 'avatar') {
                                const url = interaction.fields.getTextInputValue('url');
                                let imageData;
                                try {
                                    imageData = await fetchImageDataUri(url, 'Avatar');
                                } catch (err) {
                                    await mainMsg.edit({ content: `❌ ${err.message}`, embeds: [], components: [] });
                                    setTimeout(() => updatePanel(), 3000);
                                    return;
                                }
                                                await runBotProcess('Change Avatars', getSelectedTokens({ code: modalCode }), async (t, bot) => {
                                                    if (!bot?.user) throw new Error('bot offline');
                                                    await bot.user.setAvatar(imageData);
                                                    await patchCurrentApplication(t.token, { icon: imageData }).catch(() => bot.application?.edit?.({ icon: imageData }).catch(() => {}));
                                                    refreshEmbedColor(bot).catch(() => {});
                                                }, { concurrency: SETTINGS_PROFILE_CONCURRENCY, code: modalCode });
                                setTimeout(() => updatePanel(), 3000);
                                return;
                            }

                            if (modalContext.type === 'status') {
                                const text = interaction.fields.getTextInputValue('text');
                                tokens = store.get('tokens') || [];
                                tokens.forEach(t => { if (t.code === modalCode) t.status = text; });
                                store.set('tokens', tokens);

                                        await runBotProcess('Change Status', getSelectedTokens({ code: modalCode }), async (t, bot) => {
                                            if (!bot?.user) throw new Error('bot offline');
                                            bot.user.setPresence({
                                                activities: [{
                                                    name: text,
                                                    type: ActivityType.Streaming,
                                                    url: getTwitchUrl() || 'https://www.twitch.tv/tnbeh',
                                                }],
                                                status: 'online'
                                            });
                                        }, { code: modalCode });
                                setTimeout(() => updatePanel(), 3000);
                                return;
                            }

                            if (modalContext.type === 'voice_status_emoji') {
                                const emoji = interaction.fields.getTextInputValue('emoji').trim().slice(0, 128) || '🎵';
                                setDisplay(modalCode, { voiceStatusEmoji: emoji });
                                tokens = store.get('tokens') || [];
                                const selected = tokens.filter(t => t.code === modalCode);
                                if (parseCustomEmojiInput(emoji)) {
                                    await runBotProcess('Sync Status Emoji', selected, async (t, bot) => {
                                        if (!bot?.user) throw new Error('bot offline');
                                        t.voiceStatusEmoji = await syncCustomEmojiToBotApplication(bot, emoji);
                                    }, { concurrency: SETTINGS_PROFILE_CONCURRENCY, code: modalCode });
                                } else {
                                    selected.forEach(t => { t.voiceStatusEmoji = emoji; });
                                }
                                store.set('tokens', tokens);
                                await mainMsg.edit({ content: `✅ تم تحديث إيموجي Status الروم إلى ${emoji}.`, embeds: [], components: [] });
                                setTimeout(() => updatePanel(), 2500);
                                return;
                            }

                                    if (modalContext.type === 'banner') {
                                const url = interaction.fields.getTextInputValue('url');
                                let data;
                                try {
                                    data = await fetchImageDataUri(url, 'Banner');

                                            await runBotProcess('Change Banners', getSelectedTokens({ code: modalCode }), async (t) => {
                                                await axios.patch('https://discord.com/api/v10/users/@me', { banner: data }, {
                                                    headers: { Authorization: `Bot ${t.token}`, 'Content-Type': 'application/json' },
                                                    timeout: SETTINGS_IMAGE_TIMEOUT_MS,
                                                });
                                                await patchCurrentApplication(t.token, { cover_image: data }).catch(() => {});
                                            }, { concurrency: SETTINGS_PROFILE_CONCURRENCY, code: modalCode });
                                } catch (e) {
                                    await mainMsg.edit({ content: `❌ فشل تحديث البانر: ${e.message}` });
                                }
                                setTimeout(() => updatePanel(), 3000);
                                return;
                            }

                                    if (modalContext.type === 'moveidle') {
                                        stopChildCollector('modal_execute');
                                const input = interaction.fields.getTextInputValue('channelId');
                        const channelIds = input.split(',').map(s => s.trim()).filter(Boolean);

                        if (channelIds.length === 0 || channelIds.some(id => !/^\d{17,20}$/.test(id))) {
                            await mainMsg.edit({ content: '❌ ايدي الروم غير صحيح.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 3000);
                            return;
                        }

                                        const idleBots = getSelectedTokens({ code: modalCode }).filter(t => {
                                    const info = getBotVoiceInfo(t);
                                    return info.inServer && !info.inRoom;
                                });

                                if (channelIds.length === 1) {
                                            await runBotProcess('Move Idle Bots', idleBots, async (t) => {
                                                await moveTokenToVoice(t, channelIds[0]);
                                            }, { code: modalCode });
                                } else {
                                    const resolvedChannels = [];
                                    const seenChannels = new Set();
                                    for (const id of channelIds) {
                                        if (seenChannels.has(id)) continue;
                                        seenChannels.add(id);
                                        const channel = message.guild.channels.cache.get(id)
                                            || await message.guild.channels.fetch(id).catch(() => null);
                                        if (!isVoiceChannel(channel)) {
                                            await mainMsg.edit({ content: `❌ الروم غير صحيح: \`${id}\``, embeds: [], components: [] });
                                            setTimeout(() => updatePanel(), 3000);
                                            return;
                                        }
                                        resolvedChannels.push(channel);
                                    }

                                    const plan = buildDistributionPlan(idleBots, resolvedChannels);
                                    plan.assignments.forEach(assignment => {
                                        assignment.token._targetChannelId = assignment.channel.id;
                                    });
                                    try {
                                                await runBotProcess('Move Idle Bots', plan.assignments.map(assignment => assignment.token), async (t) => {
                                                    await moveTokenToVoice(t, t._targetChannelId);
                                                }, { code: modalCode });
                                    } finally {
                                        plan.assignments.forEach(assignment => {
                                            delete assignment.token._targetChannelId;
                                        });
                                    }
                                }

                                store.set('tokens', tokens);
                                setTimeout(() => updatePanel(), 3000);
                            }
                };
                client.on('interactionCreate', modalHandler);
                        collector.on('end', (_, reason) => {
                            stopChildCollector('main_end');
                            client.off('interactionCreate', modalHandler);
                            if (reason !== 'closed') {
                                mainMsg.edit({ components: disableRows(mainMsg.components) }).catch(() => {});
                            }
                        });

                        async function handleVoiceStatus(interaction) {
                            stopChildCollector('replaced');
                            let page = 0;
                    const subTokens = getSelectedTokens();

            async function renderVoicePanel(i = null) {
                const start = page * 10;
                const end = Math.min(start + 10, subTokens.length);
                const slice = subTokens.slice(start, end);

                let countRoom = 0, countIdle = 0, countOffline = 0;
                subTokens.forEach(t => {
                    const info = getBotVoiceInfo(t);
                    if (info.inRoom) countRoom++;
                    else if (info.inServer) countIdle++;
                    else countOffline++;
                });

                const lines = slice.map((t, idx) => {
                    const { bot, statusText, inRoom, inServer } = getBotVoiceInfo(t);
                    const mention = bot ? `<@${bot.user.id}>` : '`غير معروف`';
                    const num = start + idx + 1;
                    const icon = inRoom ? '🔊' : inServer ? '💤' : '⛔';
                    return `${icon} **#${num}** — ${mention} → ${statusText}`;
                });

                const summary =
                    `🔊 **في روم :** \`${countRoom}\`　💤 **خامل :** \`${countIdle}\`　⛔ **خارج السيرفر :** \`${countOffline}\``;

                const embed = new EmbedBuilder()
                    .setTitle(`Voice Status — ${selectedCode}`)
                    .setDescription(
                        summary + `\n\u200b\n` +
                        `> البوتات **${start + 1}–${end}** من أصل **${subTokens.length}**\n\u200b\n` +
                        lines.join('\n\u200b\n')
                    )
                    .setColor(getEmbedColor(client))
                    .setFooter({ text: `Page ${page + 1} / ${Math.ceil(subTokens.length / 10)}` });

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_prev`).setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_next`).setEmoji(MUSIC_EMOJIS.pageNext).setStyle(ButtonStyle.Secondary).setDisabled(end >= subTokens.length),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_restart`).setLabel('Restart').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_moveidle`).setLabel('Move Idle').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                );
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_links_all`).setLabel('All Links').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_links_out`).setLabel('Outside Server').setStyle(ButtonStyle.Secondary)
                );

                const payload = { embeds: [embed], components: [row1, row2], content: '' };
                if (i) await i.update(payload);
                else await mainMsg.edit(payload);
            }

            await renderVoicePanel(interaction);

                    const vsCollector = mainMsg.createMessageComponentCollector({
                        filter: i => i.user.id === userId && (
                            i.customId.startsWith(`stg_vs_${mid}_`) || i.customId.startsWith(`stg_vsc_${mid}_`)
                        ),
                        time: 120000
                    });
                    replaceChildCollector(vsCollector);

            vsCollector.on('collect', async i => {
                // ── Pagination ─────────────────────────────────────────────
                if (i.customId === `stg_vs_${mid}_prev`) { page--; return renderVoicePanel(i); }
                if (i.customId === `stg_vs_${mid}_next`) { page++; return renderVoicePanel(i); }

                // ── Restart → اسأل: الكل أم اللي بالرومات فقط ─────────────
                if (i.customId === `stg_vs_${mid}_restart`) {
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_vsc_${mid}_rst_all`).setLabel('All Bots').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`stg_vsc_${mid}_rst_rooms`).setLabel('In Voice Only').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`stg_vsc_${mid}_rst_cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                    );
                    return i.update({ content: '⚠️ اختر نوع إعادة التشغيل:', embeds: [], components: [row] });
                }

                if (i.customId === `stg_vsc_${mid}_rst_cancel`) {
                    return renderVoicePanel(i);
                }

                if (i.customId === `stg_vsc_${mid}_rst_all` || i.customId === `stg_vsc_${mid}_rst_rooms`) {
                    const roomsOnly = i.customId === `stg_vsc_${mid}_rst_rooms`;
                    const targets = roomsOnly
                        ? subTokens.filter(t => getBotVoiceInfo(t).inRoom)
                        : subTokens;

                    await i.update({ content: `⏳ جاري إعادة تشغيل **${targets.length}** بوت...`, embeds: [], components: [] });

                            await runLimited(targets, SETTINGS_PROCESS_CONCURRENCY, async t => {
                                const bot = runningBots.get(t.token);
                                if (bot) {
                                    await bot.destroy().catch(() => {});
                                    runningBots.delete(t.token);
                                    botLastActivity?.delete(t.token);
                                }
                            });

                    await mainMsg.edit({ content: `✅ تم إعادة تشغيل **${targets.length}** بوت. سيُعاد تشغيلها خلال 10 ثوانٍ.` });
                    vsCollector.stop();
                    setTimeout(() => updatePanel(), 10000);
                    return;
                }

                // ── لوحة الروابط (الكل أو خارج السيرفر) ──────────────────
                if (i.customId === `stg_vs_${mid}_links_all` || i.customId === `stg_vs_${mid}_links_out`) {
                    const initFilter = i.customId === `stg_vs_${mid}_links_out` ? 'outside' : 'all';
                    vsCollector.stop('open_links');
                    return showLinksPanel(i, subTokens, selectedCode, initFilter, 'voice_status');
                }

                        // ── إدخال الخاملين إلى روم ───────────────────────────────
                        if (i.customId === `stg_vs_${mid}_moveidle`) {
                            return showMoveIdleModal(i);
                        }

                        // ── الرجوع إلى ROOMS ─────────────────────────────────────
                        if (i.customId === `stg_vs_${mid}_back`) {
                            vsCollector.stop('back');
                            currentPanel = 'ROOMS';
                            return updatePanel(i);
                        }
                    });

                    vsCollector.on('end', (_, reason) => {
                        if (reason === 'time') mainMsg.edit({ components: disableRows(mainMsg.components) }).catch(() => {});
                    });
                }

        // ════════════════════════════════════════════════════════════════
        //  showLinksPanel — لوحة روابط البوتات بإيمبد + فلتر + صفحات
        // ════════════════════════════════════════════════════════════════
                async function showLinksPanel(triggerInteraction, allBots, code, initFilter = 'all', returnTo = 'voice_status') {
                    stopChildCollector('replaced');
                    let lpPage   = 0;
            let lpFilter = initFilter;   // 'all' | 'in_room' | 'idle' | 'outside' | 'offline'

            const PAGE_SIZE = 10;
            const indexedBots = allBots.map((t, globalIdx) => ({ t, globalIdx }));

            // تسميات الفلاتر
            const FILTER_LABELS = {
                all:     'All',
                in_room: 'In Voice',
                idle:    'Idle',
                outside: 'Outside Server',
                offline: 'Offline',
            };

            // فلترة البوتات حسب الاختيار
            function applyFilter(entries, filter) {
                return entries.filter(({ t }) => {
                    const info = getBotVoiceInfo(t);
                    if (filter === 'all')     return true;
                    if (filter === 'in_room') return info.inRoom;
                    if (filter === 'idle')    return info.inServer && !info.inRoom;
                    if (filter === 'outside') return !info.inServer && info.bot;
                    if (filter === 'offline') return !info.bot;
                    return true;
                });
            }

            function buildEmbed(filtered) {
                const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
                const start = lpPage * PAGE_SIZE;
                const end   = Math.min(start + PAGE_SIZE, filtered.length);
                const slice = filtered.slice(start, end);

                const lines = slice.map(({ t, globalIdx }) => {
                    const info     = getBotVoiceInfo(t);
                    const clientId = getClientId(t.token);
                    const botName = info.bot?.user?.username || t.invalidBotName || `Bot ${globalIdx + 1}`;
                    const invite = clientId
                        ? `[Invite Bot](https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot)`
                        : '`No Link`';
                    const target = info.inServer ? '`In server`' : invite;
                    const status = info.inServer
                        ? (info.inRoom ? `Voice: <#${info.channelId}>` : 'Voice: `Idle`')
                        : (info.bot ? 'Status: `Outside Server`' : 'Status: `Offline`');
                    const num = String(globalIdx + 1).padStart(3, ' ');
                    return `\`${num}\` **${botName}**\n     → ${target}\n     ${status}`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`Bot Links — ${code}`)
                    .setDescription(
                        `> **الفلتر:** ${FILTER_LABELS[lpFilter]}  |  **النتائج:** ${filtered.length} بوت\n` +
                        `\u200b\n` +
                        (lines.length ? lines.join('\n\n') : '*لا توجد بوتات في هذه الفئة.*')
                    )
                    .setColor(getEmbedColor(client))
                    .setFooter({ text: `صفحة ${lpPage + 1} / ${totalPages}  •  ${code}` });

                return { embed, totalPages, start, end };
            }

            function buildComponents(filtered, totalPages) {
                const end = Math.min((lpPage + 1) * PAGE_SIZE, filtered.length);

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`lp_${mid}_prev`)
                        .setEmoji(MUSIC_EMOJIS.pagePrev)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(lpPage === 0),
                    new ButtonBuilder()
                        .setCustomId(`lp_${mid}_next`)
                        .setEmoji(MUSIC_EMOJIS.pageNext)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(end >= filtered.length),
                    new ButtonBuilder()
                        .setCustomId(`lp_${mid}_back`)
                        .setLabel('Back')
                        .setEmoji(MUSIC_EMOJIS.pagePrev)
                        .setStyle(ButtonStyle.Secondary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`lp_${mid}_filter`)
                        .setPlaceholder('Filter bots')
                        .addOptions(
                            Object.entries(FILTER_LABELS).map(([val, lbl]) => ({
                                label: lbl,
                                value: val,
                                default: val === lpFilter
                            }))
                        )
                );

                return [row1, row2];
            }

            async function renderLinks(i = null) {
                // أعد فلترة وحساب الصفحة في كل رسم
                const filtered = applyFilter(indexedBots, lpFilter);

                const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
                // تصحيح الصفحة إذا خرجت عن الحدود
                if (lpPage >= totalPages) lpPage = totalPages - 1;
                if (lpPage < 0) lpPage = 0;

                const { embed } = buildEmbed(filtered);
                const components = buildComponents(filtered, totalPages);

                const payload = { embeds: [embed], components, content: '' };
                if (i) await i.update(payload);
                else    await mainMsg.edit(payload);
            }

            // أول عرض
            await renderLinks(triggerInteraction);

                    const lpCollector = mainMsg.createMessageComponentCollector({
                        filter: i => i.user.id === userId && i.customId.startsWith(`lp_${mid}_`),
                        time: 180000
                    });
                    replaceChildCollector(lpCollector);

            lpCollector.on('collect', async i => {
                if (i.customId === `lp_${mid}_prev`) { lpPage--; return renderLinks(i); }
                if (i.customId === `lp_${mid}_next`) { lpPage++; return renderLinks(i); }
                if (i.customId === `lp_${mid}_back`) {
                    lpCollector.stop();
                    if (returnTo === 'rooms') {
                        currentPanel = 'ROOMS';
                        return updatePanel(i);
                    }
                    return handleVoiceStatus(i);
                }
                if (i.customId === `lp_${mid}_filter`) {
                    lpFilter = i.values[0];
                    lpPage   = 0;
                    return renderLinks(i);
                }
            });

            lpCollector.on('end', (_, reason) => {
                if (reason === 'time') mainMsg.edit({ components: disableRows(mainMsg.components) }).catch(() => {});
            });
        }
    }
};
