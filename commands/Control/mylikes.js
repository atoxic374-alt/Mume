const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');
const { Colors } = require('../../settings/config');
const { getLikes, getAllLikes } = require('../../utils/likes');

const PAGE = 10;

function fmt(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return h
        ? `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`
        : `${m}:${String(s % 60).padStart(2,'0')}`;
}

module.exports = {
    name: 'mylikes',
    aliases: ['لايكاتي', 'likes', 'liked'],
    async execute(client, message, args) {
        const userId = message.author.id;
        let page = 0;

        const getData = () => getLikes(userId, { offset: page * PAGE, limit: PAGE });
        const getAll  = () => getAllLikes(userId);

        // ── Embed ─────────────────────────────────────────────────────────
        function buildEmbed(rows, total) {
            const pages = Math.max(1, Math.ceil(total / PAGE));
            const start = page * PAGE;

            const lines = rows.map((r, i) => {
                const n     = String(start + i + 1).padStart(3, ' ');
                const title = r.title.length > 48 ? r.title.slice(0, 45) + '…' : r.title;
                return `\`${n}\` **[${title}](${r.uri})** \`${fmt(r.duration)}\`\n       ↳ ${r.author || '—'}`;
            });

            return new EmbedBuilder()
                .setColor(Colors)
                .setAuthor({
                    name: `Liked Songs — ${message.author.displayName}`,
                    iconURL: message.author.displayAvatarURL({ dynamic: true }),
                })
                .setDescription(
                    total === 0
                        ? '> No liked songs yet.\n> Play a track and press ❤️ to save it.'
                        : `> **${total}** tracks saved  ·  page **${page + 1}** of **${pages}**\n\u200b\n` + lines.join('\n\n')
                )
                .setFooter({ text: `Use the menu below to queue selected tracks` });
        }

        // ── Rows ──────────────────────────────────────────────────────────
        function buildNav(total) {
            const pages = Math.max(1, Math.ceil(total / PAGE));
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ml_prev_${message.id}`)
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`ml_next_${message.id}`)
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= pages - 1),
                new ButtonBuilder()
                    .setCustomId(`ml_all_${message.id}`)
                    .setLabel('Play All')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(total === 0),
                new ButtonBuilder()
                    .setCustomId(`ml_close_${message.id}`)
                    .setLabel('✕')
                    .setStyle(ButtonStyle.Danger),
            );
        }

        function buildSelect(rows, offset) {
            if (!rows?.length) return null;
            return new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`ml_queue_${message.id}`)
                    .setPlaceholder('Queue selected tracks')
                    .setMinValues(1)
                    .setMaxValues(Math.min(rows.length, 25))
                    .addOptions(rows.slice(0, 25).map((r, i) => ({
                        label: r.title.length > 99 ? r.title.slice(0, 96) + '…' : r.title,
                        value: String(offset + i),
                        description: `${fmt(r.duration)} · ${(r.author || '').slice(0, 50)}`.slice(0, 99),
                    })))
            );
        }

        // ── Render ────────────────────────────────────────────────────────
        let { rows, total } = await getData().catch(() => ({ rows: [], total: 0 }));
        const selRow = buildSelect(rows, page * PAGE);

        const msg = await message.reply({
            embeds: [buildEmbed(rows, total)],
            components: [buildNav(total), ...(selRow ? [selRow] : [])],
            allowedMentions: { repliedUser: false },
        });

        // ── Collector ─────────────────────────────────────────────────────
        const col = msg.createMessageComponentCollector({
            filter: i => i.user.id === userId && i.customId.endsWith(`_${message.id}`),
            time: 300000,
        });

        let allCache = null;

        async function re(i) {
            const d = await getData().catch(() => ({ rows: [], total: 0 }));
            rows = d.rows; total = d.total;
            const sr = buildSelect(rows, page * PAGE);
            await i.update({
                embeds: [buildEmbed(rows, total)],
                components: [buildNav(total), ...(sr ? [sr] : [])],
            });
        }

        col.on('collect', async i => {
            if (i.customId === `ml_prev_${message.id}`)  { page--; return re(i); }
            if (i.customId === `ml_next_${message.id}`)  { page++; return re(i); }
            if (i.customId === `ml_close_${message.id}`) { col.stop('closed'); return i.update({ components: [] }); }

            const player = client.poru?.players?.get(message.guild.id);

            // ── Play All ─────────────────────────────────────────────────
            if (i.customId === `ml_all_${message.id}`) {
                await i.deferUpdate();
                if (!player) return i.followUp({ content: '> No active player in this server.', ephemeral: true });
                if (!allCache) allCache = await getAll().catch(() => []);
                if (!allCache.length) return;

                let added = 0;
                for (let b = 0; b < allCache.length; b += 5) {
                    await Promise.allSettled(allCache.slice(b, b + 5).map(async r => {
                        try {
                            const res = await client.poru.resolve({ query: r.uri, source: 'ytsearch' });
                            const t = res?.tracks?.[0];
                            if (t) { t.info.requester = message.author; player.queue.add(t); added++; }
                        } catch { }
                    }));
                }
                if (!player.isPlaying && !player.isPaused) player.play();
                return i.followUp({ content: `> Queued **${added}** liked tracks`, ephemeral: true });
            }

            // ── Queue Selected ───────────────────────────────────────────
            if (i.customId === `ml_queue_${message.id}`) {
                await i.deferUpdate();
                if (!player) return i.followUp({ content: '> No active player in this server.', ephemeral: true });
                if (!allCache) allCache = await getAll().catch(() => []);

                const idxs   = i.values.map(Number);
                const tracks = idxs.map(x => allCache[x]).filter(Boolean);
                let added = 0;

                await Promise.allSettled(tracks.map(async r => {
                    try {
                        const res = await client.poru.resolve({ query: r.uri, source: 'ytsearch' });
                        const t = res?.tracks?.[0];
                        if (t) { t.info.requester = message.author; player.queue.add(t); added++; }
                    } catch { }
                }));
                if (!player.isPlaying && !player.isPaused) player.play();
                return i.followUp({ content: `> Queued **${added}** track${added !== 1 ? 's' : ''}`, ephemeral: true });
            }
        });

        col.on('end', (_, r) => { if (r !== 'closed') msg.edit({ components: [] }).catch(() => {}); });
    },
};
