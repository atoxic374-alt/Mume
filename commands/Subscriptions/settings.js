const fs = require('fs');
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
    ComponentType
} = require('discord.js');
const { owners } = require('../../config');
const { runningBots } = require('../../music');
const { getDisplay, setDisplay } = require('../../utils/display');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const MUSIC_EMOJIS = require('../../utils/musicEmojis');
const { getEmbedColor, refreshEmbedColor } = require('../../utils/embedColor');

const SETTINGS_PROCESS_CONCURRENCY = Math.max(1, Number(process.env.SETTINGS_PROCESS_CONCURRENCY || 16));
const SETTINGS_PROFILE_CONCURRENCY = Math.max(1, Number(process.env.SETTINGS_PROFILE_CONCURRENCY || 4));
const SETTINGS_DISTRIBUTION_BATCH_SIZE = Math.max(1, Number(process.env.SETTINGS_DISTRIBUTION_BATCH_SIZE || 12));
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

        const mySubs = tokens.filter(t => isSubscriptionController(t));
        const uniqueCodes = [...new Set(mySubs.map(t => t.code))];

        if (uniqueCodes.length === 0) {
            return message.reply('❌ لا يوجد لديك اشتراكات نشطة.');
        }

        let selectedCode = uniqueCodes.length === 1 ? uniqueCodes[0] : null;

        const mainMsg = await message.reply({ content: 'جاري التحميل...', components: [] });

        const collector = mainMsg.createMessageComponentCollector({
            filter: i => i.user.id === userId,
            time: 300000
        });

        // Current panel state
        let currentPanel = 'SELECT'; 
        if (selectedCode) currentPanel = 'MAIN';
        let activeDistributionCollector = null;
        let activeDistributionState = null;

        function getClientId(token) {
            try { return Buffer.from(token.split('.')[0], 'base64').toString('utf8'); } catch { return ''; }
        }

                function getBotVoiceInfo(t) {
                    const bot = runningBots.get(t.token);
                    if (!bot) return { bot: null, statusText: '🚫 غير متصل', inRoom: false, inServer: false };
                    const guild = bot.guilds.cache.get(t.Server);
                    if (!guild) return { bot, statusText: '🌐 خارج السيرفر', inRoom: false, inServer: false };
                    const vc = guild.members.me?.voice?.channel;
            return {
                bot,
                statusText: vc ? `🔊 <#${vc.id}>` : '💤 بدون روم',
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
                    const selected = tokens.filter(t => t.code === selectedCode);
                    return options.includeWaiting ? selected : selected.filter(t => !isWaitingReplacement(t));
                }

                function isVoiceChannel(channel) {
                    return channel?.type === ChannelType.GuildVoice || channel?.type === 2;
                }

                function chatSummary(selectedTokens = getSelectedTokens()) {
                    if (selectedTokens.length === 0) {
                        return {
                            label: '`غير محدد`',
                            details: 'لا توجد بوتات نشطة حالياً داخل هذا الاشتراك.',
                        };
                    }
                    const configured = selectedTokens.map(t => t.chat).filter(Boolean);
                    const unique = [...new Set(configured)];
                    if (unique.length === 0) {
                        return {
                            label: '`غير محدد`',
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
                        label: '`إعدادات مختلفة`',
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

                async function showMoveIdleModal(interaction) {
                    const idleBots = getSelectedTokens().filter(t => {
                        const info = getBotVoiceInfo(t);
                        return info.inServer && !info.inRoom;
                    });

                    if (idleBots.length === 0) {
                        return interaction.reply({ content: '✅ لا يوجد بوتات خاملة — كلها في رومات.', ephemeral: true });
                    }

                    const modal = new ModalBuilder()
                        .setCustomId(`stg_mod_${mid}_moveidle`)
                        .setTitle(`إدخال ${idleBots.length} بوت خامل`);
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

                function distributionBuckets() {
                    const selectedTokens = getSelectedTokens();
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

                function distributionTargets(scope) {
                    const buckets = distributionBuckets();
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

                        async function getDistributionChannels(firstId, lastId) {
                            const channels = await message.guild.channels.fetch();
                    const voiceChannels = channels
                        .filter(c => isVoiceChannel(c))
                        .sort((a, b) => a.position - b.position)
                        .toJSON();

                    const firstChan = voiceChannels.find(c => c.id === firstId);
                    const lastChan = voiceChannels.find(c => c.id === lastId);
                    if (!firstChan || !lastChan) throw new Error('تعذر العثور على الرومات المحددة.');

                    const minPosition = Math.min(firstChan.position, lastChan.position);
                    const maxPosition = Math.max(firstChan.position, lastChan.position);
                    const targetChannels = voiceChannels.filter(c => c.position >= minPosition && c.position <= maxPosition);
                    if (targetChannels.length === 0) throw new Error('لا توجد رومات صوتية في المدى المحدد.');

                            return targetChannels;
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
                            const targets = targetTokens.filter(Boolean);
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
                        }

                        async function moveTokenToVoice(t, targetChannelId) {
                            const bot = runningBots.get(t.token);
                            if (!bot?.poru) throw new Error('bot offline');

                            const guild = bot.guilds.cache.get(t.Server);
                            if (!guild) throw new Error('bot outside server');

                            const targetChannel = guild.channels.cache.get(targetChannelId)
                                || await guild.channels.fetch(targetChannelId).catch(() => null);
                            if (!isVoiceChannel(targetChannel)) throw new Error('invalid voice channel');

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

                            await waitForBotVoiceChannel(guild, bot, targetChannel.id);
                            return targetChannel;
                        }

                        async function setBotNameAndVerify(bot, targetName, maxRetries = 3) {
                            if (!targetName) return { required: false, ok: true, actual: bot.user?.username || 'Unknown' };
                            const safeName = String(targetName).slice(0, 32);
                            if (bot.user?.username === safeName) {
                                return { required: true, ok: true, actual: bot.user.username, expected: safeName };
                            }

                            let lastError = null;
                            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                                const result = await bot.user.setUsername(safeName).catch(err => ({ _rateErr: err }));
                                if (!result?._rateErr) {
                                    const actual = result?.username || bot.user?.username || 'Unknown';
                                    return { required: true, ok: true, actual, expected: safeName };
                                }
                                lastError = result._rateErr;

                                const rawRetryAfter =
                                    lastError?.rawError?.retry_after ??
                                    String(lastError?.message || '').match(/(\d+(\.\d+)?)\s*second/i)?.[1];
                                const retryAfterMs = rawRetryAfter
                                    ? Math.ceil(parseFloat(rawRetryAfter) * 1000) + 1500
                                    : null;
                                const isRateLimit =
                                    lastError?.status === 429 ||
                                    lastError?.httpStatus === 429 ||
                                    retryAfterMs != null;

                                if (isRateLimit && attempt < maxRetries) {
                                    await new Promise(r => setTimeout(r, Math.min(retryAfterMs ?? 65000, 90000)));
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
                            const targets = distributionTargets(state.scope);
                            if (targets.length === 0) {
                                return interaction.update({
                                    content: '',
                                    embeds: [buildDistributionEmbed('Smart Distribution', 'لا توجد بوتات مناسبة لهذا الخيار حالياً.')],
                                    components: [new ActionRowBuilder().addComponents(
                                        new ButtonBuilder().setCustomId(`stg_dist_${mid}_back_rooms`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                                    )],
                                });
                            }

                            const scopeLabels = { idle: 'الخاملين', grouped: 'المتجمعين', all: 'الكل' };
                            const modeLabel = state.mode === 'names'
                                ? (state.namesWithNumbers ? 'أسماء الرومات + أرقام' : 'أسماء الرومات')
                                : state.mode === 'numbers'
                                    ? (state.namePrefix ? `${state.namePrefix}1, ${state.namePrefix}2...` : '1, 2, 3...')
                                    : 'بدون تغيير أسماء';

                            const distributionStartedAt = Date.now();

                            function buildProgressEmbed(done, total, okCount, failCount, liveLog) {
                                const stats = progressStats(done, total, distributionStartedAt);
                                return buildDistributionEmbed(
                                    `Smart Distribution — ${stats.percent}%`,
                                    [
                                        `**Status :** *${done >= total ? 'Completed' : 'Running'}*`,
                                        '',
                                        `**Owner :** *<@${interaction.user.id}>*`,
                                        '',
                                        `**Mode :** *${modeLabel}*`,
                                        '',
                                        `**Scope :** *${scopeLabels[state.scope] || state.scope}*`,
                                        '',
                                        `**Rooms :** *<#${state.firstChannelId}> إلى <#${state.lastChannelId}>*`,
                                    ].join('\n'),
                                    [
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
                                                `**4. Batch :** *\`${SETTINGS_DISTRIBUTION_BATCH_SIZE}\`*`,
                                            ].join('\n'),
                                            inline: true,
                                        },
                                        ...(liveLog.length > 0
                                            ? [{ name: 'Live Log', value: liveLog.slice(-8).join('\n').slice(0, 1024), inline: false }]
                                            : []),
                                    ],
                                );
                            }

                            // ── initial paint ───────────────────────────────────────
                            const initPayload = {
                                content: '',
                                embeds: [buildProgressEmbed(0, targets.length, 0, 0, [])],
                                components: [],
                            };
                            if (!interaction.replied && !interaction.deferred) {
                                await interaction.update(initPayload);
                            } else {
                                await mainMsg.edit(initPayload);
                            }

                            let done = 0;
                            let success = 0;
                            let failed = 0;
                            let nameSuccess = 0;
                            let nameRequired = 0;
                            const details = [];
                            const liveLog = [];
                            let detailCount = 0;
                            let lastDistributionEditAt = 0;

                            const rememberDistributionLine = (line) => {
                                detailCount++;
                                details.push(line);
                                if (details.length > SETTINGS_MAX_PROGRESS_LINES) {
                                    details.splice(0, details.length - SETTINGS_MAX_PROGRESS_LINES);
                                }
                                liveLog.push(line);
                                if (liveLog.length > 12) {
                                    liveLog.splice(0, liveLog.length - 12);
                                }
                            };

                            try {
                                const targetChannels = await getDistributionChannels(state.firstChannelId, state.lastChannelId);

                                const BATCH_SIZE = SETTINGS_DISTRIBUTION_BATCH_SIZE;
                                for (let batchStart = 0; batchStart < targets.length; batchStart += BATCH_SIZE) {
                                    const batch = targets.slice(batchStart, batchStart + BATCH_SIZE);
                                    const batchResults = await Promise.allSettled(batch.map(async (t, batchIdx) => {
                                        const idx = batchStart + batchIdx;
                                        const bot = runningBots.get(t.token);
                                        if (!bot?.poru) throw new Error('bot offline');

                                        const guild = bot.guilds.cache.get(t.Server);
                                        if (!guild) throw new Error('bot outside server');

                                        const chan = targetChannels[idx % targetChannels.length];
                                        const targetChannel = guild.channels.cache.get(chan.id)
                                            || await guild.channels.fetch(chan.id).catch(() => null);
                                        if (!isVoiceChannel(targetChannel)) throw new Error('invalid channel');

                                        let targetName = null;
                                        if (state.mode === 'names') {
                                            targetName = state.namesWithNumbers
                                                ? `${targetChannel.name} ${idx + 1}`.slice(0, 32)
                                                : targetChannel.name.slice(0, 32);
                                        } else if (state.mode === 'numbers') {
                                            targetName = state.namePrefix
                                                ? `${state.namePrefix}${idx + 1}`.slice(0, 32)
                                                : String(idx + 1);
                                        }

                                        const nameResult = await setBotNameAndVerify(bot, targetName);

                                        t.channel = targetChannel.id;
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
                                        return { idx, bot, targetChannel, nameResult, joined };
                                    }));

                                    // ── accumulate results ──────────────────────────
                                    for (const res of batchResults) {
                                        done++;
                                        if (res.status === 'fulfilled') {
                                            const { idx, bot, targetChannel, nameResult, joined } = res.value;
                                            if (joined) success++; else failed++;
                                            if (nameResult.required) {
                                                nameRequired++;
                                                if (nameResult.ok) nameSuccess++;
                                            }
                                            const nameStr = nameResult.required
                                                ? (nameResult.ok ? ` • 📝 \`${nameResult.actual}\`` : ` • 📝 ❌`)
                                                : '';
                                            const line = `${joined ? '✅' : '❌'} **${idx + 1}.** <@${bot.user.id}> → <#${targetChannel.id}>${nameStr}`;
                                            rememberDistributionLine(line);
                                        } else {
                                            failed++;
                                            const errLine = `❌ **${done}.** ${res.reason?.message || 'unknown error'}`;
                                            rememberDistributionLine(errLine);
                                        }
                                    }

                                    // ── live update after each batch ────────────────
                                    if (Date.now() - lastDistributionEditAt >= SETTINGS_PROGRESS_INTERVAL_MS || done >= targets.length) {
                                        lastDistributionEditAt = Date.now();
                                        await mainMsg.edit({
                                            content: '',
                                            embeds: [buildProgressEmbed(done, targets.length, success, failed, liveLog)],
                                            components: [],
                                        }).catch(() => {});
                                    }
                                }

                                store.set('tokens', tokens);

                                // ── final result embed ──────────────────────────────
                                const nameField = nameRequired
                                    ? `✅ **تم:** \`${nameSuccess}\`\n❌ **فشل:** \`${nameRequired - nameSuccess}\``
                                    : '`—` بدون تغيير أسماء';

                                const resultEmbed = buildDistributionEmbed(
                                    failed === 0 ? '✅ Distribution Complete' : success === 0 ? '❌ Distribution Failed' : '⚠️ Distribution Done',
                                    [
                                        `**Owner :** *<@${interaction.user.id}>*`,
                                        '',
                                        `**Scope :** *${scopeLabels[state.scope] || state.scope}*`,
                                        '',
                                        `**Mode :** *${modeLabel}*`,
                                        '',
                                        `**Rooms :** *<#${state.firstChannelId}> إلى <#${state.lastChannelId}>*`,
                                        '',
                                        buildSimpleProgressBar(targets.length, targets.length),
                                    ].join('\n'),
                                    [
                                        { name: 'Bots', value: `**1. Success :** *\`${success}\`*\n**2. Failed :** *\`${failed}\`*\n**3. Total :** *\`${targets.length}\`*`, inline: true },
                                        { name: 'Names', value: nameField, inline: true },
                                        { name: '\u200b', value: '\u200b', inline: true },
                                        { name: 'Timing', value: `**1. Elapsed :** *\`${formatShortDuration(Date.now() - distributionStartedAt)}\`*\n**2. Batch :** *\`${SETTINGS_DISTRIBUTION_BATCH_SIZE}\`*`, inline: true },
                                        { name: 'Details', value: details.slice(0, 8).join('\n') || '—', inline: false },
                                    ],
                                );
                                if (detailCount > 8) {
                                    resultEmbed.addFields({ name: 'More', value: `**Extra :** *\`${detailCount - 8}\` بوت إضافي لم يتم عرضه داخل الإيمبد.*`, inline: false });
                                }

                                await mainMsg.edit({
                                    content: `<@${interaction.user.id}>`,
                                    embeds: [resultEmbed],
                                    components: [],
                                    allowedMentions: { users: [interaction.user.id] },
                                });
                            } catch (e) {
                                await mainMsg.edit({
                                    content: `<@${interaction.user.id}>`,
                                    embeds: [buildDistributionEmbed('❌ Distribution Failed', `**المنظم:** <@${interaction.user.id}>\n**الخطأ:** ${e.message}`)],
                                    components: [],
                                    allowedMentions: { users: [interaction.user.id] },
                                });
                            }

                            setTimeout(() => updatePanel(), 5000);
                        }

                async function startSmartDistribution(interaction) {
                    const subTokens = getSelectedTokens();
                    const serverId = subTokens[0]?.Server;
                    if (serverId && message.guild.id !== serverId) {
                        return interaction.reply({
                            content: '⚠️ استخدم التوزيع الذكي داخل سيرفر الاشتراك حتى تظهر الرومات في منيو البحث.',
                            ephemeral: true,
                        });
                    }

                    if (activeDistributionCollector) activeDistributionCollector.stop('restart');

                    const state = {
                        scope: null,
                        firstChannelId: null,
                        lastChannelId: null,
                        mode: null,
                        namePrefix: null,
                        namesWithNumbers: null,
                    };
                    activeDistributionState = state;

                    const renderScope = async (i = interaction) => {
                        const buckets = distributionBuckets();
                        const embed = buildDistributionEmbed(
                            `Smart Distribution — ${selectedCode}`,
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
                        const select = new StringSelectMenuBuilder()
                            .setCustomId(`stg_dist_${mid}_mode`)
                            .setPlaceholder('Select naming mode')
                            .addOptions([
                                { label: 'Room Names', value: 'names', description: 'يسمي كل بوت باسم الروم (اختياري: مع أرقام)' },
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
                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_names_withnum`).setLabel('مع أرقام').setStyle(ButtonStyle.Primary),
                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_names_nonum`).setLabel('بدون أرقام').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`stg_dist_${mid}_last_back`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                            )],
                        });
                    };

                    const showNumbersModal = async (i) => {
                        const modal = new ModalBuilder()
                            .setCustomId(`stg_mod_${mid}_dist_prefix`)
                            .setTitle('Numbered Names — اسم البوتات');
                        modal.addComponents(new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('prefix')
                                .setLabel('الاسم المشترك (أو اكتب 0 لأرقام فقط)')
                                .setPlaceholder('Ahmed → Ahmed1, Ahmed2 ... أو اكتب 0 للترقيم فقط (1, 2, 3)')
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
                            const buckets = distributionBuckets();
                            const targets = distributionTargets(state.scope);

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
                        if (reason === 'time') mainMsg.edit({ components: disableRows(mainMsg.components) }).catch(() => {});
                    });
                }

                async function startPinRoom(interaction) {
                    const subTokens = getSelectedTokens();
                    const serverId = subTokens[0]?.Server;
                    if (serverId && message.guild.id !== serverId) {
                        return interaction.reply({
                            content: '⚠️ استخدم تثبيت الروم داخل سيرفر الاشتراك حتى تظهر الرومات.',
                            ephemeral: true,
                        });
                    }

                    const state = { scope: null, channelId: null };

                    const renderScope = async (i = interaction) => {
                        const buckets = distributionBuckets();
                        const embed = buildDistributionEmbed(
                            `Pin Bots To Room — ${selectedCode}`,
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
                        const targets = distributionTargets(state.scope);
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
                                embeds: [buildProcessEmbed('Pin Bots To Room', 0, distributionTargets(state.scope).length, 0, 0, [`⏳ Target room: <#${state.channelId}>`])],
                                components: [],
                                allowedMentions: { users: [userId] },
                            });
                            const targets = distributionTargets(state.scope);
                            await runBotProcess(`Pin Bots To Room — ${SCOPE_LABELS[state.scope] || state.scope}`, targets, async (t) => {
                                await moveTokenToVoice(t, state.channelId);
                            });
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
                    content = '**Select Subscription**\nاختر الاشتراك الذي تريد التحكم به:';
                    const emojiData = store.get('emojis') || { emojis: [] };
                    const muEmojis = emojiData.emojis || [];
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`stg_${mid}_select_sub`)
                        .setPlaceholder('Select subscription')
                        .addOptions(uniqueCodes.map((code, index) => {
                            const isPrimary = primaryOwnerIdFor(code) === userId;
                            const timeData = store.get('time') || [];
                            const subInfo = timeData.find(t => t.code === code);
                            const botsCount = subInfo?.botsCount || (store.get('tokens') || []).filter(t => t.code === code).length;
                            const opt = {
                                label: isPrimary || isAdmin
                                    ? `Music x${botsCount} (${code})`
                                    : `Admin sub ${code}`,
                                description: isPrimary || isAdmin
                                    ? `Subscription ${code}`
                                    : `Subscription ${code} — Admin Access`,
                                value: code,
                            };
                            const emoji = muEmojis[index];
                            if (emoji) opt.emoji = emoji;
                            return opt;
                        }));
                    components.push(new ActionRowBuilder().addComponents(selectMenu));
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

                    const embed = new EmbedBuilder()
                        .setTitle(`Subscription Settings — ${selectedCode}`)
                        .setDescription('تحكم سريع ومنظم في البوتات، العرض، الغرف، والمنصة.')
                        .addFields(
                            {
                                name: '👤  Owner',
                                value: primaryOwnerId ? `*<@${primaryOwnerId}>*` : '*`غير معروف`*',
                                inline: true
                            },
                            {
                                name: '🤖  Bots',
                                value: [
                                    `**Active :** *\`${subTokens.length}\`*`,
                                    waitingCount ? `**Waiting :** *\`${waitingCount}\`*` : null,
                                ].filter(Boolean).join('\n'),
                                inline: true
                            },
                            {
                                name: '🖥️  Server',
                                value: `**ID :** *\`${subTokens[0]?.Server || allSubTokens[0]?.Server || 'غير محدد'}\`*`,
                                inline: true
                            },
                            {
                                name: '📅  Expires',
                                value: subInfo?.expirationTime
                                    ? `**Time :** *<t:${Math.floor(subInfo.expirationTime / 1000)}:R>*`
                                    : '**Time :** *`غير معروف`*',
                                inline: true
                            },
                            {
                                name: '👥  Subscribe Owners',
                                value: subOwnerIds.length
                                    ? subOwnerIds.map(id => `*<@${id}>*`).join('\n')
                                    : '*`لا يوجد`*',
                                inline: true
                            },
                            {
                                name: '🎛️  Display',
                                value: [
                                    `**Buttons :** *${display.buttons ? '`ON`' : '`OFF`'}*`,
                                    `**Embeds :** *${display.embeds ? '`ON`' : '`OFF`'}*`,
                                    `**Voice Status :** *${display.voiceStatus ? '`ON`' : '`OFF`'}*`,
                                ].join('\n'),
                                inline: true
                            },
                            {
                                name: '🎵  Platform',
                                value: `**Source :** *\`${display.platform}\`*`,
                                inline: true
                            },
                            {
                                name: '🔁  Back to Voice',
                                value: [
                                    `**Status :** ${backVoice.label}`,
                                    `**Info :** *${backVoice.details}*`,
                                ].join('\n'),
                                inline: true
                            },
                            {
                                name: '💬  Command Chat',
                                value: [
                                    `**Channel :** ${chat.label}`,
                                    `**Info :** *${chat.details}*`,
                                ].join('\n'),
                                inline: false
                            },
                            {
                                name: '📊  Voice Status',
                                value: [
                                    `**In Room :** *\`${voiceStats.inRoom}\`*`,
                                    `**Idle :** *\`${voiceStats.idle}\`*`,
                                    `**Outside :** *\`${voiceStats.outside}\`*`,
                                    `**Offline :** *\`${voiceStats.offline}\`*`,
                                ].join('\n'),
                                inline: false
                            },
                        )
                        .setColor(getEmbedColor(client));
                    
                    embeds.push(embed);

                    const row1 = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`stg_${mid}_main_menu`)
                            .setPlaceholder('Select settings section')
                            .addOptions([
                                { label: 'Appearance', value: 'APPEARANCE', description: 'تغيير الصورة، البنر، والحالة لكل البوتات' },
                                { label: 'Rooms', value: 'ROOMS', description: 'الغرف، التوزيع الذكي، الروابط، وشات الأوامر' },
                                { label: 'Display', value: 'DISPLAY', description: 'تفعيل أو تعطيل الأزرار والإيمبد' },
                                { label: 'Platform', value: 'PLATFORM', description: 'اختيار منصة البحث والتشغيل' },
                                ...(canManageSubscriptionOwners(selectedCode)
                                    ? [{ label: 'Subscribe Owners', value: 'OWNERS', description: 'إضافة وإزالة أونرز يتحكمون ببوتات الاشتراك' }]
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
                                name: '👑  مالك الاشتراك',
                                value: primaryOwnerId ? `*<@${primaryOwnerId}>*` : '*`غير معروف`*',
                                inline: true,
                            },
                            {
                                name: '👥  الأونرز الحاليين',
                                value: subOwnerIds.length
                                    ? subOwnerIds.map((id, i) => `**${i + 1} :** *<@${id}>*`).join('\n')
                                    : '*`لا يوجد`*',
                                inline: false,
                            },
                            {
                                name: '📋  الصلاحيات',
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
                        new ButtonBuilder().setCustomId(`stg_${mid}_owner_add`).setLabel('Add Owner').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`stg_${mid}_owner_remove`).setLabel('Remove Owner').setStyle(ButtonStyle.Danger).setDisabled(subOwnerIds.length === 0),
                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary),
                    ));
                }
                else if (currentPanel === 'APPEARANCE') {
                    const embed = new EmbedBuilder()
                        .setTitle(`Appearance Settings — ${selectedCode}`)
                        .setDescription('تحكم في مظهر جميع بوتات هذا الاشتراك.')
                        .setColor(getEmbedColor(client));
                    embeds.push(embed);

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_${mid}_set_avatar`).setLabel('Avatar').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_set_banner`).setLabel('Banner').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_set_status`).setLabel('Status').setStyle(ButtonStyle.Secondary),
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
                                new ButtonBuilder()
                                    .setCustomId(`stg_${mid}_toggle_buttons`)
                                    .setLabel(`Buttons: ${display.buttons ? 'ON' : 'OFF'}`)
                                    .setStyle(display.buttons ? ButtonStyle.Success : ButtonStyle.Danger),
                                new ButtonBuilder()
                                    .setCustomId(`stg_${mid}_toggle_embeds`)
                                    .setLabel(`Embeds: ${display.embeds ? 'ON' : 'OFF'}`)
                                    .setStyle(display.embeds ? ButtonStyle.Success : ButtonStyle.Danger),
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
                                        .setDescription('راقب البوتات، وزّعها، وحدد شات استقبال الأوامر.')
                                        .addFields(
                                            {
                                                name: '💬  Command Chat',
                                                value: [
                                                    `**Channel :** ${chat.label}`,
                                                    `**Info :** *${chat.details}*`,
                                                ].join('\n'),
                                                inline: true,
                                            },
                                            {
                                                name: '🔁  Back to Voice',
                                                value: [
                                                    `**Status :** ${backVoice.label}`,
                                                    `**Info :** *${backVoice.details}*`,
                                                ].join('\n'),
                                                inline: true,
                                            },
                                            {
                                                name: '🎙️  Voice Status',
                                                value: [
                                                    `**Status :** *\`${display.voiceStatus ? 'ON' : 'OFF'}\`*  ${display.voiceStatusEmoji || '🎵'}`,
                                                    `**Info :** *عند تشغيل أغنية يتم تحديث Status الروم باسم مختصر للأغنية.*`,
                                                ].join('\n'),
                                                inline: false,
                                            },
                                            {
                                                name: '📖  ماذا تفعل الأزرار؟',
                                                value: [
                                                    '**Voice Status :** *يعرض مكان كل بوت — داخل روم، خامل، خارج السيرفر، أو غير متصل.*',
                                                    '**Smart Distribution :** *يوزع البوتات على نطاق رومات تختاره ويحافظ على ترتيبها.*',
                                                    '**Move Idle :** *يدخل البوتات الخاملة فقط إلى روم أو عدة رومات تحددها.*',
                                                    '**Back to Voice :** *يرجع البوت تلقائياً للروم المحدد إذا خرج أو انتقل.*',
                                                    '**Status :** *يفعّل أو يعطل كتابة اسم الأغنية المختصر على Status الروم.*',
                                                    '**Command Chat :** *يحدد الشات الذي يستقبل أوامر التشغيل.*',
                                                    '**All Links / Outside Server :** *يعرض روابط دعوة البوتات حسب حالتها.*',
                                                ].join('\n'),
                                                inline: false,
                                            },
                                        )
                                        .setColor(getEmbedColor(client));
                                    embeds.push(embed);

                                    const row1 = new ActionRowBuilder().addComponents(
                                        new ButtonBuilder().setCustomId(`stg_${mid}_voice_status`).setLabel('Voice Status').setStyle(ButtonStyle.Secondary),
                                        new ButtonBuilder().setCustomId(`stg_${mid}_distribute`).setLabel('Smart Distribution').setStyle(ButtonStyle.Secondary),
                                        new ButtonBuilder().setCustomId(`stg_${mid}_moveidle`).setLabel('Move Idle').setStyle(ButtonStyle.Secondary),
                                        new ButtonBuilder()
                                            .setCustomId(`stg_${mid}_toggle_back_voice`)
                                            .setLabel(`Back to Voice: ${backVoice.enabled ? 'ON' : 'OFF'}`)
                                            .setStyle(backVoice.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
                                        new ButtonBuilder()
                                            .setCustomId(`stg_${mid}_toggle_voice_status`)
                                            .setLabel(`Status: ${display.voiceStatus ? 'ON' : 'OFF'}`)
                                            .setStyle(display.voiceStatus ? ButtonStyle.Success : ButtonStyle.Danger)
                                    );
                                    const row2 = new ActionRowBuilder().addComponents(
                                        new ButtonBuilder().setCustomId(`stg_${mid}_panel_chat`).setLabel('Command Chat').setStyle(ButtonStyle.Secondary),
                                        new ButtonBuilder().setCustomId(`stg_${mid}_voice_status_emoji`).setLabel('Status Emoji').setStyle(ButtonStyle.Secondary),
                                        new ButtonBuilder().setCustomId(`stg_${mid}_links_all`).setLabel('All Links').setStyle(ButtonStyle.Secondary),
                                        new ButtonBuilder().setCustomId(`stg_${mid}_links_out`).setLabel('Outside Server').setStyle(ButtonStyle.Secondary)
                                    );
                                    const row3 = new ActionRowBuilder().addComponents(
                                        new ButtonBuilder().setCustomId(`stg_${mid}_pin_room`).setLabel('Pin Room').setStyle(ButtonStyle.Primary),
                                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('Back').setEmoji(MUSIC_EMOJIS.pagePrev).setStyle(ButtonStyle.Secondary)
                            );
                            components.push(row1, row2, row3);
                        }
                        else if (currentPanel === 'CHAT') {
                            const chat = chatSummary();
                            const embed = new EmbedBuilder()
                                .setTitle(`Command Chat — ${selectedCode}`)
                                .addFields(
                                    {
                                        name: '💬  الشات الحالي',
                                        value: [
                                            `**Channel :** ${chat.label}`,
                                            `**Info :** *${chat.details}*`,
                                        ].join('\n'),
                                        inline: false,
                                    },
                                    {
                                        name: '📋  كيف يعمل؟',
                                        value: '**Info :** *عند تحديد شات استقبال، أوامر كل البوتات تعمل فقط في شات الاستقبال أو شات الفويس الخاص بكل بوت.*',
                                        inline: false,
                                    },
                                )
                                .setColor(getEmbedColor(client));
                            embeds.push(embed);

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

                const options = { content, embeds, components };
                if (interaction && !interaction.replied && !interaction.deferred) {
                    await interaction.update(options);
                } else {
                    await mainMsg.edit(options);
                }
            } catch (err) {
                console.error(err);
            }
        }

        await updatePanel();

        collector.on('collect', async i => {
            if (i.customId === `stg_${mid}_select_sub`) {
                selectedCode = i.values[0];
                currentPanel = 'MAIN';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_main_menu`) {
                currentPanel = i.values[0];
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_close`) {
                collector.stop('closed');
                return i.update({ content: '✅ تم إغلاق القائمة.', embeds: [], components: [] });
            }

            if (i.customId === `stg_${mid}_back_to_select`) {
                currentPanel = 'SELECT';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_back_to_main`) {
                currentPanel = 'MAIN';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_appearance`) {
                currentPanel = 'APPEARANCE';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_display`) {
                currentPanel = 'DISPLAY';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_platform`) {
                currentPanel = 'PLATFORM';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_rooms`) {
                currentPanel = 'ROOMS';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_chat`) {
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

            // Modals: Avatar, Banner, Status, Distribute
            if (i.customId === `stg_${mid}_set_avatar`) {
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_avatar`).setTitle('Change Bot Avatars');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('Image URL').setRequired(true).setStyle(TextInputStyle.Short)));
                await i.showModal(modal);
            }

            if (i.customId === `stg_${mid}_set_status`) {
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_status`).setTitle('Change Bot Status');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Status Text').setRequired(true).setStyle(TextInputStyle.Short)));
                await i.showModal(modal);
            }
            
            if (i.customId === `stg_${mid}_set_banner`) {
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_banner`).setTitle('Change Bot Banners');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('Image URL').setRequired(true).setStyle(TextInputStyle.Short)));
                await i.showModal(modal);
            }

            if (i.customId === `stg_${mid}_owner_add`) {
                if (!canManageSubscriptionOwners(selectedCode)) {
                    return i.reply({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', ephemeral: true });
                }
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_owner_add`).setTitle('Add Subscribe Owner');
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
                    return i.reply({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', ephemeral: true });
                }
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_owner_remove`).setTitle('Remove Subscribe Owner');
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

            if (i.customId === `stg_${mid}_distribute`) {
                return startSmartDistribution(i);
            }

            if (i.customId === `stg_${mid}_pin_room`) {
                return startPinRoom(i);
            }

            if (i.customId === `stg_${mid}_chat_select_all`) {
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

                    if (i.customId === `stg_${mid}_toggle_back_voice`) {
                        tokens = store.get('tokens') || [];
                        const selected = tokens.filter(t => t.code === selectedCode);
                        const currentlyEnabled = selected.some(t => t.backToVoice !== 'off');
                        selected.forEach(t => {
                    t.backToVoice = currentlyEnabled ? 'off' : 'on';
                });
                        store.set('tokens', tokens);
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_toggle_voice_status`) {
                        const cur = getDisplay(selectedCode);
                        const newVal = !cur.voiceStatus;
                        setDisplay(selectedCode, { voiceStatus: newVal });
                        tokens = store.get('tokens') || [];
                        const selected = tokens.filter(t => t.code === selectedCode);
                        selected.forEach(t => {
                            if (t.code === selectedCode) t.voiceStatus = newVal ? 'on' : 'off';
                        });
                        store.set('tokens', tokens);
                        if (!newVal) {
                            await runLimited(selected, SETTINGS_PROCESS_CONCURRENCY, async t => {
                                const bot = runningBots.get(t.token);
                                const channelId = bot?.guilds.cache.get(t.Server)?.members.me?.voice?.channelId;
                                if (bot?.rest && channelId) {
                                    await bot.rest.put(`/channels/${channelId}/voice-status`, { body: { status: null } }).catch(() => {});
                                }
                            });
                        }
                        return updatePanel(i);
                    }

                    if (i.customId === `stg_${mid}_voice_status_emoji`) {
                        const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_voice_status_emoji`).setTitle('Voice Status Emoji');
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

                            if (i.customId === `stg_${mid}_voice_status`) {
                                // Voice status sub-panel logic
                        await handleVoiceStatus(i);
                    }

                    if (i.customId === `stg_${mid}_links_all`) {
                        return showLinksPanel(i, getSelectedTokens(), selectedCode, 'all', 'rooms');
                    }

                    if (i.customId === `stg_${mid}_links_out`) {
                        return showLinksPanel(i, getSelectedTokens(), selectedCode, 'outside', 'rooms');
                    }

                    if (i.customId === `stg_${mid}_moveidle`) {
                        return showMoveIdleModal(i);
                    }
                });

                // Handle Modal Submits
                const modalHandler = async (interaction) => {
                    if (!interaction.isModalSubmit()) return;
                    if (!interaction.customId.startsWith(`stg_mod_${mid}_`)) return;

                    const subTokens = getSelectedTokens();
                    await interaction.deferUpdate();

                    // ── توزيع ذكي: modal اسم الترقيم ─────────────────────────────
                    if (interaction.customId === `stg_mod_${mid}_dist_prefix`) {
                        if (!activeDistributionState) return;
                        const input = interaction.fields.getTextInputValue('prefix').trim();
                        activeDistributionState.namePrefix = input === '0' ? '' : input;
                        if (activeDistributionCollector) activeDistributionCollector.stop('execute');
                        return executeSmartDistribution(interaction, activeDistributionState);
                    }

                    if (interaction.customId === `stg_mod_${mid}_owner_add`) {
                        if (!canManageSubscriptionOwners(selectedCode)) {
                            await mainMsg.edit({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 2500);
                            return;
                        }
                        const targetId = parseUserId(interaction.fields.getTextInputValue('user'));
                        const primary = primaryOwnerIdFor(selectedCode);
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
                        const current = subscriptionOwnerIdsFor(selectedCode);
                        const next = setSubscriptionOwnersFor(selectedCode, [...current, targetId]);
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

                    if (interaction.customId === `stg_mod_${mid}_owner_remove`) {
                        if (!canManageSubscriptionOwners(selectedCode)) {
                            await mainMsg.edit({ content: '❌ إدارة الأونرز متاحة لمالك الاشتراك فقط.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 2500);
                            return;
                        }
                        const targetId = parseUserId(interaction.fields.getTextInputValue('user'));
                        const primary = primaryOwnerIdFor(selectedCode);
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
                        const current = subscriptionOwnerIdsFor(selectedCode);
                        const next = setSubscriptionOwnersFor(selectedCode, current.filter(id => id !== targetId));
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

            if (interaction.customId === `stg_mod_${mid}_avatar`) {
                const url = interaction.fields.getTextInputValue('url');
                await runBotProcess('Change Avatars', subTokens, async (t, bot) => {
                    if (!bot?.user) throw new Error('bot offline');
                    await bot.user.setAvatar(url);
                    refreshEmbedColor(bot).catch(() => {});
                }, { concurrency: SETTINGS_PROFILE_CONCURRENCY });
                setTimeout(() => updatePanel(), 3000);
            }

                    if (interaction.customId === `stg_mod_${mid}_status`) {
                        const text = interaction.fields.getTextInputValue('text');
                        tokens = store.get('tokens') || [];
                        tokens.forEach(t => { if (t.code === selectedCode) t.status = text; });
                        store.set('tokens', tokens);

                        await runBotProcess('Change Status', subTokens, async (t, bot) => {
                            if (!bot?.user) throw new Error('bot offline');
                            bot.user.setPresence({
                                activities: [{ name: text, type: 3 }],
                                status: 'online'
                            });
                        });
                        setTimeout(() => updatePanel(), 3000);
                    }

                    if (interaction.customId === `stg_mod_${mid}_voice_status_emoji`) {
                        const emoji = interaction.fields.getTextInputValue('emoji').trim().slice(0, 64);
                        setDisplay(selectedCode, { voiceStatusEmoji: emoji || '🎵' });
                        tokens = store.get('tokens') || [];
                        tokens.forEach(t => {
                            if (t.code === selectedCode) t.voiceStatusEmoji = emoji || '🎵';
                        });
                        store.set('tokens', tokens);
                        await mainMsg.edit({ content: `✅ تم تحديث إيموجي Status الروم إلى ${emoji || '🎵'}.`, embeds: [], components: [] });
                        setTimeout(() => updatePanel(), 2500);
                    }

                    if (interaction.customId === `stg_mod_${mid}_banner`) {
                        const url = interaction.fields.getTextInputValue('url');
                        try {
                            const response = await axios.get(url, { responseType: 'arraybuffer' });
                            const base64 = Buffer.from(response.data, 'binary').toString('base64');
                            const data = `data:${response.headers['content-type']};base64,${base64}`;

                            await runBotProcess('Change Banners', subTokens, async (t) => {
                                await axios.patch('https://discord.com/api/v9/users/@me', { banner: data }, {
                                    headers: { Authorization: `Bot ${t.token}`, 'Content-Type': 'application/json' }
                                });
                            }, { concurrency: SETTINGS_PROFILE_CONCURRENCY });
                        } catch (e) {
                            await mainMsg.edit({ content: `❌ فشل تحديث البانر: ${e.message}` });
                        }
                        setTimeout(() => updatePanel(), 3000);
                    }

                    if (interaction.customId === `stg_mod_${mid}_moveidle`) {
                        const input = interaction.fields.getTextInputValue('channelId');
                        const channelIds = input.split(',').map(s => s.trim()).filter(Boolean);

                        if (channelIds.length === 0 || channelIds.some(id => !/^\d{17,20}$/.test(id))) {
                            await mainMsg.edit({ content: '❌ ايدي الروم غير صحيح.', embeds: [], components: [] });
                            setTimeout(() => updatePanel(), 3000);
                            return;
                        }

                        const idleBots = getSelectedTokens().filter(t => {
                            const info = getBotVoiceInfo(t);
                            return info.inServer && !info.inRoom;
                        });

                        await runBotProcess('Move Idle Bots', idleBots, async (t, bot, index) => {
                            const targetChannelId = channelIds[index % channelIds.length];
                            await moveTokenToVoice(t, targetChannelId);
                        });

                        store.set('tokens', tokens);
                        setTimeout(() => updatePanel(), 3000);
                    }
                };
                client.on('interactionCreate', modalHandler);
                collector.on('end', (_, reason) => {
                    client.off('interactionCreate', modalHandler);
                    if (reason !== 'closed') {
                        mainMsg.edit({ components: disableRows(mainMsg.components) }).catch(() => {});
                    }
                });

                async function handleVoiceStatus(interaction) {
                    let page = 0;
                    const subTokens = getSelectedTokens();

            async function renderVoicePanel(i = null) {
                const start = page * 10;
                const end = Math.min(start + 10, subTokens.length);
                const slice = subTokens.slice(start, end);

                const lines = slice.map((t, idx) => {
                    const { bot, statusText } = getBotVoiceInfo(t);
                    const mention = bot ? `<@${bot.user.id}>` : '`غير معروف`';
                    const num = String(start + idx + 1).padStart(3, ' ');
                    return `\`${num}\` ${mention}  ${statusText}`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`Voice Status — ${selectedCode}`)
                    .setDescription(
                        `> البوتات **${start + 1}–${end}** من أصل **${subTokens.length}**\n` +
                        `> 🔊 بروم  |  💤 بدون روم  |  🌐 خارج سيرفر  |  🚫 غير متصل\n` +
                        `\u200b\n` +
                        lines.join('\n')
                    )
                    .setColor(getEmbedColor(client))
                    .setFooter({ text: `صفحة ${page + 1} / ${Math.ceil(subTokens.length / 10)}` });

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
