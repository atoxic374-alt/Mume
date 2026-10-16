'use strict';

const { owners } = require('../../config');
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');
const store = require('../../utils/store');
const { getEmbedColor } = require('../../utils/embedColor');

const SUBSCRIPTIONS_PER_PAGE = 25;
const BOTS_PER_PAGE = 10;
const COLLECTOR_MS = 120_000;

function getRuntime() {
    try {
        const music = require('../../music');
        return { runningBots: music.runningBots };
    } catch {
        return { runningBots: new Map() };
    }
}

function getNodeList(botClient) {
    try {
        return [...(botClient?.poru?.nodes?.values?.() || [])];
    } catch {
        return [];
    }
}

function isDiscordReady(botClient) {
    try {
        return Boolean(botClient?.isReady?.() || botClient?.readyAt);
    } catch {
        return false;
    }
}

function getSubscriptions() {
    const timeRows = store.get('time') || [];
    const tokenRows = (store.get('tokens') || []).filter(item => item?.token);
    const groups = new Map();

    for (const entry of timeRows) {
        if (!entry?.code) continue;
        groups.set(entry.code, { code: entry.code, time: entry, bots: [] });
    }
    for (const tokenRow of tokenRows) {
        if (!tokenRow?.code) continue;
        let group = groups.get(tokenRow.code);
        if (!group) {
            group = { code: tokenRow.code, time: null, bots: [] };
            groups.set(tokenRow.code, group);
        }
        group.bots.push(tokenRow);
    }

    return [...groups.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

function makeButton(customId, label, style, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled);
}

function buildSubscriptionView(client, page, customPrefix) {
    const subscriptions = getSubscriptions();
    const totalPages = Math.max(1, Math.ceil(subscriptions.length / SUBSCRIPTIONS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const pageRows = subscriptions.slice(
        (currentPage - 1) * SUBSCRIPTIONS_PER_PAGE,
        currentPage * SUBSCRIPTIONS_PER_PAGE,
    );

    const embed = new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setTitle('Lavalink — اختر الاشتراك')
        .setDescription(subscriptions.length
            ? `اختر الاشتراك لعرض بوتاته وحالة اتصال Discord وعقدة Lavalink.\nالاشتراكات: **${subscriptions.length}**`
            : 'لم أجد اشتراكات مسجلة مرتبطة ببوتات.')
        .setFooter({ text: `صفحة الاشتراكات ${currentPage}/${totalPages}` })
        .setTimestamp();

    const components = [];
    if (pageRows.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`${customPrefix}:select`)
            .setPlaceholder('اختر الاشتراك')
            .addOptions(pageRows.map(group => {
                const owner = group.time?.user ? `المالك ${group.time.user}` : 'اشتراك مسجل';
                const active = group.time?.expirationTime
                    ? (group.time.expirationTime > Date.now() ? 'نشط' : 'منتهي')
                    : 'بيانات الاشتراك';
                return {
                    label: String(group.code).slice(0, 100),
                    value: String(group.code).slice(0, 100),
                    description: `${group.bots.length} بوت • ${active} • ${owner}`.slice(0, 100),
                };
            }));
        components.push(new ActionRowBuilder().addComponents(select));
        components.push(new ActionRowBuilder().addComponents(
            makeButton(`${customPrefix}:subs_prev`, 'السابق', ButtonStyle.Secondary, currentPage <= 1),
            makeButton(`${customPrefix}:subs_refresh`, 'تحديث', ButtonStyle.Primary),
            makeButton(`${customPrefix}:subs_next`, 'التالي', ButtonStyle.Secondary, currentPage >= totalPages),
        ));
    }

    return { embed, components, totalPages, currentPage };
}

function buildBotsView(client, code, page, customPrefix) {
    const { runningBots } = getRuntime();
    const group = getSubscriptions().find(item => item.code === code);
    const tokenRows = group?.bots || [];
    const totalPages = Math.max(1, Math.ceil(tokenRows.length / BOTS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const pageRows = tokenRows.slice(
        (currentPage - 1) * BOTS_PER_PAGE,
        currentPage * BOTS_PER_PAGE,
    );

    let discordReadyCount = 0;
    let hasOnlineNodeCount = 0;
    const nodeCounts = new Map();

    for (const tokenRow of tokenRows) {
        const botClient = runningBots.get(tokenRow.token);
        if (isDiscordReady(botClient)) discordReadyCount++;
        const nodes = getNodeList(botClient);
        if (nodes.some(node => node?.isConnected)) hasOnlineNodeCount++;
        for (const node of nodes) {
            const name = node?.options?.name || node?.options?.host || 'unknown';
            const counts = nodeCounts.get(name) || { assigned: 0, connected: 0 };
            counts.assigned++;
            if (node?.isConnected) counts.connected++;
            nodeCounts.set(name, counts);
        }
    }

    for (const config of (store.get('host') || [])) {
        const name = config?.name || config?.host;
        if (name && !nodeCounts.has(name)) nodeCounts.set(name, { assigned: 0, connected: 0 });
    }

    const nodeSummary = nodeCounts.size
        ? [...nodeCounts.entries()]
            .map(([name, counts]) => `\`${name}\`: ${counts.connected}/${counts.assigned} متصلة`)
            .join(' • ')
        : 'لا توجد بيانات عقد متاحة.';

    const embed = new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setTitle(`Lavalink — الاشتراك ${code}`.slice(0, 256))
        .setDescription([
            `**البوتات:** ${tokenRows.length} | **Discord جاهز:** ${discordReadyCount} | **لديها عقدة متصلة:** ${hasOnlineNodeCount}`,
            `**العقد (متصل/مخصص):** ${nodeSummary}`,
        ].join('\n'))
        .setFooter({ text: `صفحة البوتات ${currentPage}/${totalPages} • ${BOTS_PER_PAGE} بوتات في الصفحة` })
        .setTimestamp();

    if (!group) {
        embed.addFields({ name: 'الاشتراك غير موجود', value: 'تغيرت قائمة الاشتراكات. ارجع واختر اشتراكًا آخر.' });
    } else if (!pageRows.length) {
        embed.addFields({ name: 'لا توجد بوتات', value: 'لا توجد بوتات مرتبطة بهذا الاشتراك.' });
    } else {
        pageRows.forEach((tokenRow, index) => {
            const botClient = runningBots.get(tokenRow.token);
            const discordReady = isDiscordReady(botClient);
            const botName = botClient?.user?.tag
                || botClient?.user?.username
                || tokenRow.profileName
                || `بوت ${(currentPage - 1) * BOTS_PER_PAGE + index + 1}`;
            const botId = botClient?.user?.id;
            const nodes = getNodeList(botClient);

            let nodeText;
            if (!botClient) {
                nodeText = 'غير مشغّل؛ لا توجد جلسة عقدة لهذا البوت.';
            } else if (!nodes.length) {
                nodeText = 'لا توجد عقدة مهيأة أو لم يبدأ اتصالها بعد.';
            } else {
                nodeText = nodes.map(node => {
                    const name = node?.options?.name || node?.options?.host || 'unknown';
                    return `\`${name}\` ${node?.isConnected ? '🟢 Connected' : '🔴 Disconnected'}`;
                }).join('\n');
            }

            const ordinal = (currentPage - 1) * BOTS_PER_PAGE + index + 1;
            embed.addFields({
                name: `${ordinal}. ${String(botName).slice(0, 205)}${botId ? ` • ${botId}` : ''}`.slice(0, 256),
                value: `Discord: ${discordReady ? '🟢 Connected' : (botClient ? '🟡 Starting' : '🔴 Offline')}\nLavalink:\n${nodeText}`.slice(0, 1024),
                inline: false,
            });
        });
    }

    const buttons = new ActionRowBuilder().addComponents(
        makeButton(`${customPrefix}:bots_prev`, 'السابق', ButtonStyle.Secondary, currentPage <= 1),
        makeButton(`${customPrefix}:bots_refresh`, 'تحديث', ButtonStyle.Primary),
        makeButton(`${customPrefix}:back`, 'اختيار اشتراك', ButtonStyle.Secondary),
        makeButton(`${customPrefix}:bots_next`, 'التالي', ButtonStyle.Secondary, currentPage >= totalPages),
    );

    return { embed, components: [buttons], totalPages, currentPage };
}

module.exports = {
    name: 'lavalink',
    aliases: ['llstatus', 'll'],
    async execute(client, message) {
        if (!owners.includes(message.author.id)) return;

        let selectedCode = null;
        let subscriptionPage = 1;
        let botsPage = 1;
        const customPrefix = `lavalink:${message.id}`;
        let view = buildSubscriptionView(client, subscriptionPage, customPrefix);
        const reply = await message.reply({
            embeds: [view.embed],
            components: view.components,
            allowedMentions: { parse: [] },
        });

        const collector = reply.createMessageComponentCollector({
            filter: interaction => interaction.user.id === message.author.id
                && interaction.customId.startsWith(`${customPrefix}:`),
            time: COLLECTOR_MS,
        });

        collector.on('collect', async interaction => {
            const action = interaction.customId.slice(customPrefix.length + 1);

            if (action === 'select') {
                selectedCode = interaction.values?.[0] || null;
                botsPage = 1;
                view = buildBotsView(client, selectedCode, botsPage, customPrefix);
            } else if (action === 'back') {
                selectedCode = null;
                view = buildSubscriptionView(client, subscriptionPage, customPrefix);
            } else if (action === 'subs_prev' || action === 'subs_next' || action === 'subs_refresh') {
                const current = buildSubscriptionView(client, subscriptionPage, customPrefix);
                if (action === 'subs_prev') subscriptionPage = Math.max(1, current.currentPage - 1);
                if (action === 'subs_next') subscriptionPage = Math.min(current.totalPages, current.currentPage + 1);
                view = buildSubscriptionView(client, subscriptionPage, customPrefix);
                subscriptionPage = view.currentPage;
            } else if (action === 'bots_prev' || action === 'bots_next' || action === 'bots_refresh') {
                const current = buildBotsView(client, selectedCode, botsPage, customPrefix);
                if (action === 'bots_prev') botsPage = Math.max(1, current.currentPage - 1);
                if (action === 'bots_next') botsPage = Math.min(current.totalPages, current.currentPage + 1);
                view = buildBotsView(client, selectedCode, botsPage, customPrefix);
                botsPage = view.currentPage;
            }

            await interaction.update({
                embeds: [view.embed],
                components: view.components,
                allowedMentions: { parse: [] },
            }).catch(() => {});
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => {});
        });
    },
};
