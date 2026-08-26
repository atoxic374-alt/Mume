const { owners } = require('../../config');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('../../utils/store');
const { getEmbedColor } = require('../../utils/embedColor');

function getRunningBots() {
    try {
        const music = require('../../music');
        return { runningBots: music.runningBots, botLastActivity: music.botLastActivity };
    } catch {
        return { runningBots: new Map(), botLastActivity: new Map() };
    }
}

function fmtUptime(ms) {
    if (!ms || ms <= 0) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m ${s % 60}s`;
}

function fmtAgo(ts) {
    if (!ts) return 'لم يُستخدم';
    const diff = Date.now() - ts;
    return fmtUptime(diff) + ' مضت';
}

function nodeStatus(botClient) {
    try {
        const nodes = [...(botClient.poru?.nodes?.values() || [])];
        if (!nodes.length) return { text: 'No Nodes' };
        const online = nodes.filter(n => n.isConnected).length;
        if (online === nodes.length) return { text: `Lavalink ${online}/${nodes.length}` };
        if (online > 0) return { text: `Lavalink ${online}/${nodes.length}` };
        return { text: `Lavalink 0/${nodes.length}` };
    } catch {
        return { text: 'Unknown' };
    }
}

function playerStatus(botClient) {
    try {
        const players = [...(botClient.poru?.players?.values() || [])];
        const playing = players.filter(p => p.isPlaying && !p.isPaused);
        const paused = players.filter(p => p.isPaused);
        if (playing.length) return { text: `Playing (${playing.length})` };
        if (paused.length) return { text: `Paused (${paused.length})` };
        if (players.length) return { text: 'Connected without playback' };
        return { text: 'Idle' };
    } catch {
        return { text: 'Unknown' };
    }
}

function buildEmbed(client, page, perPage) {
    const { runningBots, botLastActivity } = getRunningBots();
    const tokens = store.get('tokens') || [];
    const bots = store.get('bots') || [];
    const now = Date.now();

    const allTokens = tokens;
    const totalPages = Math.max(1, Math.ceil(allTokens.length / perPage));
    const safePageNum = Math.min(page, totalPages);
    const slice = allTokens.slice((safePageNum - 1) * perPage, safePageNum * perPage);

    // ── Global stats ─────────────────────────────────────────────────────────
    const totalRunning = runningBots.size;
    const totalPlaying = [...runningBots.values()].filter(b => {
        return [...(b.poru?.players?.values() || [])].some(p => p.isPlaying && !p.isPaused);
    }).length;
    const totalInVC = [...runningBots.values()].filter(b =>
        [...(b.guilds?.cache?.values() || [])].some(g => g.members?.me?.voice?.channel)
    ).length;
    const totalNodes_online = [...runningBots.values()].reduce((acc, b) => {
        return acc + [...(b.poru?.nodes?.values() || [])].filter(n => n.isConnected).length;
    }, 0);
    const totalNodes_all = [...runningBots.values()].reduce((acc, b) => {
        return acc + (b.poru?.nodes?.size || 0);
    }, 0);

    const embed = new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setTitle('Music Bots Status')
        .setDescription('عرض مختصر لحالة بوتات الاشتراكات، الاتصال، التشغيل، وآخر نشاط.')
        .setFooter({
            text: `Page ${safePageNum}/${totalPages} | Active: ${allTokens.length} | Stock: ${bots.length}`,
            iconURL: client.user.displayAvatarURL(),
        })
        .setTimestamp();

    // ── Summary bar ──────────────────────────────────────────────────────────
    embed.addFields({
        name: 'Summary',
        value: [
            `Running: \`${totalRunning}\` | Playing: \`${totalPlaying}\` | In Voice: \`${totalInVC}\``,
            `Lavalink: \`${totalNodes_online}/${totalNodes_all}\` nodes متصلة`,
        ].join('\n'),
        inline: false,
    });

    if (!slice.length) {
        embed.addFields({ name: 'لا توجد اشتراكات', value: 'لا يوجد توكن نشط حاليًا.', inline: false });
        return { embed, totalPages: safePageNum };
    }

    // ── Per-bot rows ─────────────────────────────────────────────────────────
    let desc = '';
    for (const tokenObj of slice) {
        const botClient = runningBots.get(tokenObj.token);
        const isRunning = !!botClient && botClient.readyAt;

        const runStatus = isRunning ? 'Running' : 'Offline';
        const botName = isRunning
            ? (botClient.user?.username || 'Unknown')
            : `توكن …${tokenObj.token.slice(-6)}`;

        const lastActive = botLastActivity?.get(tokenObj.token);
        const agoText = fmtAgo(lastActive);

        let lines = `**${runStatus} | ${botName}**`;

        if (isRunning) {
            const nd = nodeStatus(botClient);
            const ps = playerStatus(botClient);
            const vcLine = (() => {
                const guild = botClient.guilds?.cache?.get(tokenObj.Server);
                const vc = guild?.members?.me?.voice?.channel;
                return vc ? `Voice: ${vc.name}` : (tokenObj.channel ? 'خارج الروم' : '—');
            })();
            lines += `\n> ${nd.text} | ${ps.text}\n> آخر نشاط: ${agoText} | ${vcLine}`;
        } else {
            lines += `\n> غير مشغّل | الاشتراك: \`${tokenObj.code || '—'}\``;
        }

        desc += lines + '\n\n';
    }

    embed.setDescription(desc.trim() || 'لا يوجد');
    return { embed, totalPages };
}

module.exports = {
    name: 'musicstatus',
    aliases: ['mstatus', 'botstatus', 'ms'],
    async execute(client, message, args) {
        if (!owners.includes(message.author.id)) return;

        const PER_PAGE = 5;
        let page = 1;

        const { embed, totalPages } = buildEmbed(client, page, PER_PAGE);

        const makeButtons = (currentPage, total) => new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('status_prev')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage <= 1),
            new ButtonBuilder()
                .setCustomId('status_refresh')
                .setLabel('Refresh')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('status_next')
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage >= total),
        );

        const msg = await message.reply({
            embeds: [embed],
            components: totalPages > 1 || true ? [makeButtons(page, totalPages)] : [],
        });

        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === message.author.id,
            time: 120_000,
        });

        collector.on('collect', async (i) => {
            if (i.customId === 'status_next') page = Math.min(totalPages, page + 1);
            else if (i.customId === 'status_prev') page = Math.max(1, page - 1);
            // 'status_refresh' keeps same page, just rebuilds

            const { embed: newEmbed, totalPages: newTotal } = buildEmbed(client, page, PER_PAGE);
            await i.update({
                embeds: [newEmbed],
                components: [makeButtons(page, newTotal)],
            }).catch(() => {});
        });

        collector.on('end', () => {
            msg.edit({ components: [] }).catch(() => {});
        });
    },
};
