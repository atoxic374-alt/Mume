const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ComponentType,
} = require('discord.js');
const { getLikes, getAllLikes } = require('../../utils/likes');
const { getEmbedColor } = require('../../utils/embedColor');

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

async function ensurePlayer(client, message) {
    if (!client.poru) throw new Error('Music player is not ready.');

    let player = client.poru.players.get(message.guild.id);
    if (player) {
        player.textChannel = message.channel.id;
        player.data = player.data || {};
        player.data.lastTextChannel = message.channel.id;
        return player;
    }

    const memberVoice = message.member?.voice?.channel;
    const botVoice = message.guild.members?.me?.voice?.channel;
    if (!memberVoice) throw new Error('Join your voice room first.');
    if (botVoice && botVoice.id !== memberVoice.id) throw new Error('Join the same voice room as the bot.');

    const voiceChannel = botVoice || memberVoice;
    player = await client.poru.createConnection({
        guildId: message.guild.id,
        voiceChannel: voiceChannel.id,
        textChannel: message.channel.id,
        deaf: true,
        autoPlay: false,
        group: client.token,
    });
    player.data = player.data || {};
    player.data.autoPlay = false;
    player.data.lastTextChannel = message.channel.id;
    return player;
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

async function bumpQueueVersion(player, reason = 'likes_add') {
    player.data = player.data || {};
    player.data.queueVersion = (player.data.queueVersion || 0) + 1;
    player.data.lastQueuePanelReason = reason;

    const panels = player.data.queuePanels;
    if (!panels?.size) return;

    const entries = [...panels.values()];
    panels.clear();
    await Promise.allSettled(entries.map(({ message }) => {
        if (!message?.components?.length) return null;
        return message.edit({ components: disableComponents(message.components) }).catch(() => null);
    }));
}

function cloneTrackForQueue(track, requester) {
    return { ...track, info: { ...track.info, requester } };
}

async function resolveLikedRows(client, rows, requester) {
    const tracks = [];
    for (let b = 0; b < rows.length; b += 5) {
        const batch = rows.slice(b, b + 5);
        const resolved = await Promise.allSettled(batch.map(async row => {
            const res = await client.poru.resolve({ query: row.uri });
            const track = res?.tracks?.[0];
            return track ? cloneTrackForQueue(track, requester) : null;
        }));

        for (const item of resolved) {
            if (item.status === 'fulfilled' && item.value) tracks.push(item.value);
        }
    }
    return tracks;
}

function buildQueueEmbed(client, message, player, added, label) {
    const current = player.currentTrack;
    const upcoming = Array.from(player.queue || []).slice(0, 10);
    const lines = upcoming.map((track, index) => {
        const title = (track.info?.title || 'Unknown').slice(0, 54);
        const author = (track.info?.author || 'Unknown').slice(0, 40);
        return `\`${String(index + 1).padStart(2, '0')}\` **${title}**\n     \`${fmt(track.info?.length)}\` · ${author}`;
    });

    return new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setTitle('Queue Updated')
        .setDescription([
            `> **${added}** track${added === 1 ? '' : 's'} added from **${label}**.`,
            current ? `> Now: **${(current.info?.title || 'Unknown').slice(0, 70)}**` : '> Playback will start now.',
            '',
            lines.length ? lines.join('\n\n') : '> No upcoming songs after the current track.',
        ].join('\n'))
        .setFooter({ text: `Requested by ${message.author.displayName}` });
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
                .setColor(getEmbedColor(client))
                .setAuthor({
                    name: `Liked Songs — ${message.author.displayName}`,
                    iconURL: message.author.displayAvatarURL({ dynamic: true }),
                })
                .setDescription(
                    total === 0
                        ? '> **No liked songs yet.**\n> شغّل أغنية واضغط لايك لحفظها هنا.'
                        : `> **${total}** saved tracks  ·  page **${page + 1}** of **${pages}**\n> اختر أغنية أو عدة أغاني لإضافتها للطابور.\n\u200b\n` + lines.join('\n\n')
                )
                .setFooter({ text: 'Liked songs are queued in the current voice session' });
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

            // ── Play All ─────────────────────────────────────────────────
            if (i.customId === `ml_all_${message.id}`) {
                await i.deferUpdate();
                let player;
                try {
                    player = await ensurePlayer(client, message);
                } catch (err) {
                    return i.followUp({ content: `> ${err.message}`, ephemeral: true });
                }
                const allRows = await getAll().catch(() => []);
                if (!allRows.length) return i.followUp({ content: '> لا توجد لايكات محفوظة.', ephemeral: true });

                const tracks = await resolveLikedRows(client, allRows, message.author);
                for (const track of tracks) player.queue.add(track);
                await bumpQueueVersion(player, 'likes_play_all');
                if (!player.isPlaying && !player.isPaused && player.queue.length) await player.play().catch(() => {});

                await msg.edit({
                    embeds: [buildEmbed(rows, total), buildQueueEmbed(client, message, player, tracks.length, 'Play All')],
                    components: [buildNav(total), ...(buildSelect(rows, page * PAGE) ? [buildSelect(rows, page * PAGE)] : [])],
                }).catch(() => {});
                return i.followUp({ content: `> Queued **${tracks.length}** liked tracks`, ephemeral: true });
            }

            // ── Queue Selected ───────────────────────────────────────────
            if (i.customId === `ml_queue_${message.id}`) {
                await i.deferUpdate();
                let player;
                try {
                    player = await ensurePlayer(client, message);
                } catch (err) {
                    return i.followUp({ content: `> ${err.message}`, ephemeral: true });
                }
                const allRows = await getAll().catch(() => []);

                const idxs   = i.values.map(Number);
                const selectedRows = idxs.map(x => allRows[x]).filter(Boolean);
                const tracks = await resolveLikedRows(client, selectedRows, message.author);

                for (const track of tracks) player.queue.add(track);
                await bumpQueueVersion(player, 'likes_selected');
                if (!player.isPlaying && !player.isPaused && player.queue.length) await player.play().catch(() => {});

                const sr = buildSelect(rows, page * PAGE);
                await msg.edit({
                    embeds: [buildEmbed(rows, total), buildQueueEmbed(client, message, player, tracks.length, 'Selected Likes')],
                    components: [buildNav(total), ...(sr ? [sr] : [])],
                }).catch(() => {});
                return i.followUp({ content: `> Queued **${tracks.length}** track${tracks.length !== 1 ? 's' : ''}`, ephemeral: true });
            }
        });

        col.on('end', (_, r) => { if (r !== 'closed') msg.edit({ components: [] }).catch(() => {}); });
    },
};
