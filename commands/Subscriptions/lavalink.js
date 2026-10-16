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
        return { runningBots: require('../../music').runningBots };
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

function getBotId(botClient, token) {
    if (botClient?.user?.id) return botClient.user.id;
    try {
        const id = Buffer.from(String(token || '').split('.')[0], 'base64url').toString('utf8');
        return /^\d{17,20}$/.test(id) ? id : null;
    } catch {
        return null;
    }
}

function escapeMarkdownLabel(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
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

function stableHash(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function getAssignedNodeConfigs(tokenRow) {
    let nodes = store.get('host') || [];
    if (process.env.LAVALINK_HOST) {
        nodes = [{
            name: 'main',
            host: process.env.LAVALINK_HOST,
            port: parseInt(process.env.LAVALINK_PORT || '2333', 10),
            secure: process.env.LAVALINK_SECURE === 'true',
        }];
    }
    nodes = Array.isArray(nodes) ? nodes.filter(node => node?.host && node?.port) : [];
    if (nodes.length <= 1) return nodes;

    const strategy = String(process.env.LAVALINK_NODE_STRATEGY || 'partition').toLowerCase();
    if (strategy === 'all' || strategy === 'full') return nodes;

    const replicas = Math.max(1, Math.min(
        nodes.length,
        Number(process.env.LAVALINK_NODE_REPLICAS || 1) || 1,
    ));
    const start = stableHash(`${tokenRow.Server || ''}:${String(tokenRow.token || '').slice(-12)}`) % nodes.length;
    return Array.from({ length: replicas }, (_, offset) => nodes[(start + offset) % nodes.length]);
}

function configuredNodeName(node) {
    const options = node?.options || node || {};
    const configuredNodes = store.get('host') || [];
    const runtimeHost = String(options.host || '').trim().toLowerCase();
    const runtimePort = options.port == null ? '' : String(options.port);
    const configured = Array.isArray(configuredNodes)
        ? configuredNodes.find(entry => {
            const configHost = String(entry?.host || '').trim().toLowerCase();
            const configPort = entry?.port == null ? '' : String(entry.port);
            return configHost && runtimeHost === configHost
                && (!runtimePort || !configPort || runtimePort === configPort);
        })
        : null;

    return configured?.name || options.name || node?.name || configured?.host || options.host || 'Unknown';
}

function getBotNodeRows(tokenRow, botClient) {
    const liveNodes = getNodeList(botClient);
    if (liveNodes.length) {
        return liveNodes.map(node => ({
            name: configuredNodeName(node),
            connected: Boolean(node?.isConnected),
            rest: node?.rest,
        }));
    }
    return getAssignedNodeConfigs(tokenRow).map(node => ({
        name: configuredNodeName(node),
        connected: false,
    }));
}

async function measureNodeRtts(tokenRows, runningBots) {
    const measurements = new Map();
    const requests = new Map();

    for (const tokenRow of tokenRows) {
        const botClient = runningBots.get(tokenRow.token);
        for (const node of getBotNodeRows(tokenRow, botClient)) {
            if (!node.connected || !node.rest?.get) continue;
            const key = node.rest.url || node.name;
            if (requests.has(key)) continue;

            const start = Date.now();
            let timer;
            const request = Promise.race([
                Promise.resolve(node.rest.get('/v4/info')),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), 1400); }),
            ]).then(result => result == null ? null : Date.now() - start)
                .catch(() => null)
                .finally(() => clearTimeout(timer));
            requests.set(key, request);
        }
    }

    await Promise.all([...requests.entries()].map(async ([key, request]) => {
        measurements.set(key, await request);
    }));
    return measurements;
}

function formatRtt(value) {
    return Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : 'N/A';
}

function makeButton(customId, label, style, disabled = false) {
    return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
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
        .setTitle('Lavalink • Choose Subscription')
        .setDescription(subscriptions.length
            ? `Select a subscription to view its bots and node status.\n**Subscriptions:** ${subscriptions.length}`
            : 'No subscriptions found.')
        .setFooter({ text: `Subscriptions ${currentPage}/${totalPages}` })
        .setTimestamp();

    const components = [];
    if (pageRows.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`${customPrefix}:select`)
            .setPlaceholder('Select a subscription')
            .addOptions(pageRows.map(group => {
                const status = group.time?.expirationTime
                    ? (group.time.expirationTime > Date.now() ? 'Active' : 'Expired')
                    : 'Registered';
                return {
                    label: String(group.code).slice(0, 100),
                    value: String(group.code).slice(0, 100),
                    description: `${group.bots.length} bots • ${status}`.slice(0, 100),
                };
            }));
        components.push(new ActionRowBuilder().addComponents(select));
        components.push(new ActionRowBuilder().addComponents(
            makeButton(`${customPrefix}:subs_prev`, 'Prev', ButtonStyle.Secondary, currentPage <= 1),
            makeButton(`${customPrefix}:subs_refresh`, 'Refresh', ButtonStyle.Primary),
            makeButton(`${customPrefix}:subs_next`, 'Next', ButtonStyle.Secondary, currentPage >= totalPages),
        ));
    }

    return { embed, components, totalPages, currentPage };
}

async function buildBotsView(client, code, page, customPrefix) {
    const { runningBots } = getRuntime();
    const group = getSubscriptions().find(item => item.code === code);
    const tokenRows = group?.bots || [];
    const totalPages = Math.max(1, Math.ceil(tokenRows.length / BOTS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const pageRows = tokenRows.slice(
        (currentPage - 1) * BOTS_PER_PAGE,
        currentPage * BOTS_PER_PAGE,
    );
    const nodeRtts = await measureNodeRtts(pageRows, runningBots);

    let discordReadyCount = 0;
    let botsWithConnectedNode = 0;
    const nodeCounts = new Map();

    for (const tokenRow of tokenRows) {
        const botClient = runningBots.get(tokenRow.token);
        if (isDiscordReady(botClient)) discordReadyCount++;
        const nodes = getBotNodeRows(tokenRow, botClient);
        if (nodes.some(node => node.connected)) botsWithConnectedNode++;
        for (const node of nodes) {
            const counts = nodeCounts.get(node.name) || { assigned: 0, connected: 0 };
            counts.assigned++;
            if (node.connected) counts.connected++;
            nodeCounts.set(node.name, counts);
        }
    }

    const nodeSummary = nodeCounts.size
        ? [...nodeCounts.entries()]
            .map(([name, counts]) => `\`${name}\` ${counts.connected}/${counts.assigned}`)
            .join('  •  ')
        : 'No nodes configured';

    const embed = new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setTitle(`Lavalink • ${code}`.slice(0, 256))
        .setDescription([
            `**Bots:** ${tokenRows.length}  •  **Discord ready:** ${discordReadyCount}  •  **Node online:** ${botsWithConnectedNode}`,
            `**Nodes (online/assigned):** ${nodeSummary}`,
        ].join('\n'))
        .setFooter({ text: `Bots ${currentPage}/${totalPages} • ${BOTS_PER_PAGE} per page` })
        .setTimestamp();

    if (!group) {
        embed.addFields({ name: 'Subscription Not Found', value: 'Go back and select another subscription.' });
    } else if (!pageRows.length) {
        embed.addFields({ name: 'No Bots', value: 'No bots are linked to this subscription.' });
    } else {
        pageRows.forEach((tokenRow, index) => {
            const botClient = runningBots.get(tokenRow.token);
            const botId = getBotId(botClient, tokenRow.token);
            const botName = botClient?.user?.tag
                || botClient?.user?.username
                || tokenRow.profileName
                || `Bot ${(currentPage - 1) * BOTS_PER_PAGE + index + 1}`;
            const discordState = isDiscordReady(botClient) ? '✅ Ready' : (botClient ? '⏳ Starting' : '❌ Offline');
            const discordRtt = Number(botClient?.ws?.ping);
            const nodes = getBotNodeRows(tokenRow, botClient);
            const nodeText = nodes.length
                ? nodes.map(node => {
                    const key = node.rest?.url || node.name;
                    const rtt = nodeRtts.get(key);
                    return `\`${node.name}\` ${node.connected ? '✅' : '❌'} • Ping ${formatRtt(rtt)}`;
                }).join('\n')
                : 'No node configured';
            const ordinal = (currentPage - 1) * BOTS_PER_PAGE + index + 1;
            const botLabel = botId
                ? `[${escapeMarkdownLabel(String(botName).slice(0, 150))}](https://discord.com/users/${encodeURIComponent(botId)})`
                : escapeMarkdownLabel(botName);

            embed.addFields({
                name: `${ordinal}. ${botLabel}`.slice(0, 256),
                value: `Discord: ${discordState} • Ping ${formatRtt(discordRtt)}\nLavalink: ${nodeText}`.slice(0, 1024),
                inline: false,
            });
        });
    }

    const buttons = new ActionRowBuilder().addComponents(
        makeButton(`${customPrefix}:bots_prev`, 'Prev', ButtonStyle.Secondary, currentPage <= 1),
        makeButton(`${customPrefix}:bots_refresh`, 'Refresh', ButtonStyle.Primary),
        makeButton(`${customPrefix}:back`, 'Subscriptions', ButtonStyle.Secondary),
        makeButton(`${customPrefix}:bots_next`, 'Next', ButtonStyle.Secondary, currentPage >= totalPages),
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
                view = await buildBotsView(client, selectedCode, botsPage, customPrefix);
            } else if (action === 'back') {
                selectedCode = null;
                view = buildSubscriptionView(client, subscriptionPage, customPrefix);
            } else if (action.startsWith('subs_')) {
                const current = buildSubscriptionView(client, subscriptionPage, customPrefix);
                if (action === 'subs_prev') subscriptionPage = Math.max(1, current.currentPage - 1);
                if (action === 'subs_next') subscriptionPage = Math.min(current.totalPages, current.currentPage + 1);
                view = buildSubscriptionView(client, subscriptionPage, customPrefix);
                subscriptionPage = view.currentPage;
            } else if (action.startsWith('bots_')) {
                const current = await buildBotsView(client, selectedCode, botsPage, customPrefix);
                if (action === 'bots_prev') botsPage = Math.max(1, current.currentPage - 1);
                if (action === 'bots_next') botsPage = Math.min(current.totalPages, current.currentPage + 1);
                view = await buildBotsView(client, selectedCode, botsPage, customPrefix);
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
