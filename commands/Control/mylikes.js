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
const MUSIC_EMOJIS = require('../../utils/musicEmojis');

const PAGE = 8;

function fmt(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return h
        ? `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`
        : `${m}:${String(s % 60).padStart(2,'0')}`;
}

function cleanText(value, fallback = 'Unknown', max = 80) {
    const text = String(value || fallback).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function escapeLinkText(value, max = 80) {
    return cleanText(value, 'Unknown', max)
        .replace(/\]/g, '\\]');
}

function trackLink(title, uri, max = 70) {
    const label = escapeLinkText(title, max);
    return uri ? `[${label}](${uri})` : label;
}

function isMemberDeafened(member) {
    const voice = member?.voice;
    return !!(voice?.deaf || voice?.selfDeaf || voice?.serverDeaf);
}

async function ensurePlayer(client, message) {
    if (!client.poru) throw new Error('Music player is not ready.');
    if (isMemberDeafened(message.member)) throw new Error('فك الديفن أولاً ثم شغّل الأغاني.');

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
    const upcoming = Array.from(player.queue || []).slice(0, 8);

    const lines = upcoming.map((track, index) => {
        return `\`${index + 1}.\` ${trackLink(track.info?.title, track.info?.uri, 64)}`;
    });

    return new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setTitle('Queue Updated')
        .setDescription([
            `**Added:** ${added} liked track${added === 1 ? '' : 's'} from **${label}**`,
            current
                ? `**Now Playing:** ${trackLink(current.info?.title, current.info?.uri, 64)}`
                : '**Playback:** starting now',
            '',
            lines.length ? `**Up Next**\n${lines.join('\n')}` : '',
        ].filter(Boolean).join('\n'))
        .setFooter({
            text: `Requested by ${message.author.displayName}`,
            iconURL: message.author.displayAvatarURL({ dynamic: true }),
        });
}

module.exports = {
    name: 'mylikes',
    aliases: ['لايكاتي', 'likes', 'liked'],
    async execute(client, message, args) {
        const userId = message.author.id;
        let page = 0;

        const getData = () => getLikes(userId, { offset: page * PAGE, limit: PAGE });
        const getAll  = () => getAllLikes(userId);

        function buildEmbed(rows, total) {
            const pages = Math.max(1, Math.ceil(total / PAGE));
            const start = page * PAGE;
            const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 256 });

            if (total === 0) {
                return new EmbedBuilder()
                    .setColor(getEmbedColor(client))
                    .setAuthor({
                        name: `${message.author.displayName}'s Liked Songs`,
                        iconURL: avatarURL,
                    })
                    .setThumbnail(avatarURL)
                    .setDescription(
                        '> **No liked songs yet.**\n> شغّل أغنية واضغط ❤️ لحفظها هنا.'
                    )
                    .setFooter({ text: `All songs : 0 | Page 1 / 1` });
            }

            const lines = rows.map((r, i) => {
                const num = start + i + 1;
                const meta = [cleanText(r.author, '', 34), fmt(r.duration)].filter(Boolean).join(' • ');
                return `\`${num}.\` ${trackLink(r.title, r.uri, 72)}${meta ? `\n> ${meta}` : ''}`;
            });

            return new EmbedBuilder()
                .setColor(getEmbedColor(client))
                .setAuthor({
                    name: `${message.author.displayName}'s Liked Songs`,
                    iconURL: avatarURL,
                })
                .setThumbnail(avatarURL)
                .setDescription(lines.join('\n'))
                .setFooter({
                    text: `All songs : ${total} | Page ${page + 1} / ${pages}`,
                });
        }

        function buildNav(total) {
            const pages = Math.max(1, Math.ceil(total / PAGE));
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ml_prev_${message.id}`)
                    .setEmoji(MUSIC_EMOJIS.pagePrev)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`ml_next_${message.id}`)
                    .setEmoji(MUSIC_EMOJIS.pageNext)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= pages - 1),
                new ButtonBuilder()
                    .setCustomId(`ml_all_${message.id}`)
                    .setEmoji(MUSIC_EMOJIS.skip)
                    .setLabel('Play All')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(total === 0),
                new ButtonBuilder()
                    .setCustomId(`ml_close_${message.id}`)
                    .setEmoji(MUSIC_EMOJIS.stop)
                    .setLabel('Close')
                    .setStyle(ButtonStyle.Danger),
            );
        }

        function buildSelect(rows, offset) {
            if (!rows?.length) return null;
            return new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`ml_queue_${message.id}`)
                    .setPlaceholder('Select tracks to queue...')
                    .setMinValues(1)
                    .setMaxValues(Math.min(rows.length, 25))
                    .addOptions(rows.slice(0, 25).map((r, i) => ({
                        label: r.title.length > 99 ? r.title.slice(0, 96) + '…' : r.title,
                        value: String(offset + i),
                        description: `${fmt(r.duration)}`.slice(0, 99),
                        emoji: MUSIC_EMOJIS.like,
                    })))
            );
        }

        function buildComponents(rows, total) {
            const sr = buildSelect(rows, page * PAGE);
            return [buildNav(total), ...(sr ? [sr] : [])];
        }

        let { rows, total } = await getData().catch(() => ({ rows: [], total: 0 }));

        const msg = await message.reply({
            embeds: [buildEmbed(rows, total)],
            components: buildComponents(rows, total),
            allowedMentions: { repliedUser: false },
        });

        const col = msg.createMessageComponentCollector({
            filter: i => i.user.id === userId && i.customId.endsWith(`_${message.id}`),
            time: 300000,
        });

        async function re(i) {
            const d = await getData().catch(() => ({ rows: [], total: 0 }));
            rows = d.rows; total = d.total;
            await i.update({
                embeds: [buildEmbed(rows, total)],
                components: buildComponents(rows, total),
            });
        }

        col.on('collect', async i => {
            if (i.customId === `ml_prev_${message.id}`)  { page--; return re(i); }
            if (i.customId === `ml_next_${message.id}`)  { page++; return re(i); }
            if (i.customId === `ml_close_${message.id}`) { col.stop('closed'); return i.update({ components: [] }); }

            if (i.customId === `ml_all_${message.id}`) {
                await i.deferReply({ ephemeral: true });
                await i.editReply({ content: '> ⏳ Loading liked tracks...' }).catch(() => {});
                await msg.edit({ components: disableComponents(msg.components) }).catch(() => {});
                let player;
                try {
                    player = await ensurePlayer(client, message);
                } catch (err) {
                    await msg.edit({ components: buildComponents(rows, total) }).catch(() => {});
                    return i.editReply({ content: `> ❌ ${err.message}` });
                }
                const allRows = await getAll().catch(() => []);
                if (!allRows.length) {
                    await msg.edit({ components: buildComponents(rows, total) }).catch(() => {});
                    return i.editReply({ content: '> ❌ لا توجد لايكات محفوظة.' });
                }

                const tracks = await resolveLikedRows(client, allRows, message.author);
                for (const track of tracks) player.queue.add(track);
                await bumpQueueVersion(player, 'likes_play_all');
                if (!player.isPlaying && !player.isPaused && player.queue.length) await player.play().catch(() => {});

                await msg.edit({
                    embeds: [buildEmbed(rows, total), buildQueueEmbed(client, message, player, tracks.length, 'Play All')],
                    components: buildComponents(rows, total),
                }).catch(() => {});
                return i.editReply({ content: `> ✅ Queued **${tracks.length}** liked tracks` });
            }

            if (i.customId === `ml_queue_${message.id}`) {
                await i.deferReply({ ephemeral: true });
                await i.editReply({ content: '> ⏳ Loading selected tracks...' }).catch(() => {});
                await msg.edit({ components: disableComponents(msg.components) }).catch(() => {});
                let player;
                try {
                    player = await ensurePlayer(client, message);
                } catch (err) {
                    await msg.edit({ components: buildComponents(rows, total) }).catch(() => {});
                    return i.editReply({ content: `> ❌ ${err.message}` });
                }
                const allRows = await getAll().catch(() => []);

                const idxs   = i.values.map(Number);
                const selectedRows = idxs.map(x => allRows[x]).filter(Boolean);
                if (!selectedRows.length) {
                    await msg.edit({ components: buildComponents(rows, total) }).catch(() => {});
                    return i.editReply({ content: '> ❌ لم تعد الاختيارات متاحة.' });
                }
                const tracks = await resolveLikedRows(client, selectedRows, message.author);

                for (const track of tracks) player.queue.add(track);
                await bumpQueueVersion(player, 'likes_selected');
                if (!player.isPlaying && !player.isPaused && player.queue.length) await player.play().catch(() => {});

                await msg.edit({
                    embeds: [buildEmbed(rows, total), buildQueueEmbed(client, message, player, tracks.length, 'Selected Likes')],
                    components: buildComponents(rows, total),
                }).catch(() => {});
                return i.editReply({ content: `> ✅ Queued **${tracks.length}** liked tracks` });
            }
        });

        col.on('end', (_, r) => { if (r !== 'closed') msg.edit({ components: [] }).catch(() => {}); });
    },
};
