const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');
const { Colors, prefix } = require('../../settings/config');
const { getLikes, getAllLikes } = require('../../utils/likes');
const { check } = require('../../utils/rateLimit');

const PAGE_SIZE = 10;

function fmtDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = String(s % 60).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

module.exports = {
    name: 'mylikes',
    aliases: ['لايكاتي', 'likes', 'liked'],
    async execute(client, message, args) {
        const userId = message.author.id;
        if (!check(userId, 'mylikes')) return;

        let page = 0;

        async function getData() {
            return getLikes(userId, { offset: page * PAGE_SIZE, limit: PAGE_SIZE });
        }

        async function getAllData() {
            return getAllLikes(userId);
        }

        // ── بناء الإيمبد ──────────────────────────────────────────────
        function buildEmbed(rows, total) {
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            const start = page * PAGE_SIZE;

            const lines = rows.map((r, idx) => {
                const dur  = fmtDuration(r.duration);
                const num  = String(start + idx + 1).padStart(3, ' ');
                const title = r.title.length > 45 ? r.title.slice(0, 42) + '…' : r.title;
                return `\`${num}\` **[${title}](${r.uri})** \`${dur}\`\n` +
                       `       ↳ ${r.author || '—'}`;
            });

            return new EmbedBuilder()
                .setTitle(`❤️ لايكاتك — ${message.author.displayName}`)
                .setDescription(
                    total === 0
                        ? '*لا توجد أغاني في لايكاتك بعد.\nشغّل أغنية واضغط ❤️ لايك.*'
                        : `> **${total}** أغنية محفوظة  |  صفحة **${page + 1}** من **${totalPages}**\n\u200b\n` +
                          lines.join('\n\n')
                )
                .setColor(Colors)
                .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: `${prefix}mylikes  •  اضغط ◀️ ▶️ للتنقل  •  استخدم القائمة لإضافة للطابور` });
        }

        // ── بناء الأزرار ──────────────────────────────────────────────
        function buildNavRow(total, disabled = false) {
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ml_prev_${message.id}`)
                    .setLabel('◀️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(disabled || page === 0),
                new ButtonBuilder()
                    .setCustomId(`ml_next_${message.id}`)
                    .setLabel('▶️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(disabled || page >= totalPages - 1),
                new ButtonBuilder()
                    .setCustomId(`ml_queueall_${message.id}`)
                    .setLabel('▶️ تشغيل الكل')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(disabled || total === 0),
                new ButtonBuilder()
                    .setCustomId(`ml_close_${message.id}`)
                    .setLabel('✖')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(disabled),
            );
        }

        // ── بناء منيو الاختيار المتعدد (حتى 25 خيار = صفحتان+) ────────
        function buildSelectRow(rows, pageOffset) {
            if (!rows || rows.length === 0) return null;
            const options = rows.slice(0, 25).map((r, idx) => {
                const label = r.title.length > 99 ? r.title.slice(0, 96) + '…' : r.title;
                const desc  = `${fmtDuration(r.duration)} · ${(r.author || '').slice(0, 50)}`.slice(0, 99);
                return {
                    label,
                    value: String(pageOffset + idx),
                    description: desc,
                    emoji: '🎵',
                };
            });

            return new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`ml_queue_${message.id}`)
                    .setPlaceholder('🎵 اختر أغاني لإضافتها للطابور (اختيار متعدد)')
                    .setMinValues(1)
                    .setMaxValues(options.length)
                    .addOptions(options)
            );
        }

        // ── أول عرض ──────────────────────────────────────────────────
        let { rows, total } = await getData().catch(() => ({ rows: [], total: 0 }));

        const navRow    = buildNavRow(total);
        const selectRow = buildSelectRow(rows, page * PAGE_SIZE);
        const components = [navRow, ...(selectRow ? [selectRow] : [])];

        const msg = await message.reply({
            embeds: [buildEmbed(rows, total)],
            components,
            allowedMentions: { repliedUser: false },
        });

        // ── Collector ─────────────────────────────────────────────────
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === userId && i.customId.endsWith(`_${message.id}`),
            time: 300000,
        });

        // تخزين مؤقت لكل اللايكات (للقائمة والتشغيل الكامل)
        let allCache = null;

        collector.on('collect', async i => {
            await i.deferUpdate().catch(() => {});

            // ── تنقل الصفحات ────────────────────────────────────────
            if (i.customId === `ml_prev_${message.id}`) { page--; }
            if (i.customId === `ml_next_${message.id}`) { page++; }

            if (
                i.customId === `ml_prev_${message.id}` ||
                i.customId === `ml_next_${message.id}`
            ) {
                const d = await getData().catch(() => ({ rows: [], total: 0 }));
                rows = d.rows; total = d.total;
                const nR = buildNavRow(total);
                const sR = buildSelectRow(rows, page * PAGE_SIZE);
                return msg.edit({
                    embeds: [buildEmbed(rows, total)],
                    components: [nR, ...(sR ? [sR] : [])],
                });
            }

            // ── إغلاق ────────────────────────────────────────────────
            if (i.customId === `ml_close_${message.id}`) {
                collector.stop('closed');
                return msg.edit({ components: [] });
            }

            // ── تشغيل المختار من منيو ────────────────────────────────
            if (i.customId === `ml_queue_${message.id}`) {
                const selectedIdxs = i.values.map(Number);
                if (!allCache) allCache = await getAllData().catch(() => []);

                const player = client.poru?.players?.get(message.guild.id);
                if (!player) {
                    return msg.channel.send({ content: '❌ لا يوجد بلاير نشط في هذا السيرفر.', allowedMentions: { repliedUser: false } })
                        .then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
                }

                const toQueue = selectedIdxs
                    .map(idx => allCache[idx])
                    .filter(Boolean);

                for (const song of toQueue) {
                    try {
                        const res = await client.poru.resolve({ query: song.uri, source: 'ytsearch' });
                        const track = res?.tracks?.[0];
                        if (track) {
                            track.info.requester = message.author;
                            player.queue.add(track);
                        }
                    } catch { /* تجاوز الأغنية اللي ما تحمّلت */ }
                }

                if (!player.isPlaying && !player.isPaused) player.play();

                return msg.channel.send({
                    content: `✅ تم إضافة **${toQueue.length}** أغنية للطابور.`,
                    allowedMentions: { repliedUser: false },
                }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
            }

            // ── تشغيل الكل ───────────────────────────────────────────
            if (i.customId === `ml_queueall_${message.id}`) {
                if (!allCache) allCache = await getAllData().catch(() => []);
                if (allCache.length === 0) return;

                const player = client.poru?.players?.get(message.guild.id);
                if (!player) {
                    return msg.channel.send({ content: '❌ لا يوجد بلاير نشط.', allowedMentions: { repliedUser: false } })
                        .then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
                }

                // تحميل متوازي بحد أقصى 5 في وقت واحد (لا تثقل الـ Lavalink)
                const BATCH = 5;
                let added = 0;
                for (let b = 0; b < allCache.length; b += BATCH) {
                    const batch = allCache.slice(b, b + BATCH);
                    await Promise.allSettled(batch.map(async song => {
                        try {
                            const res = await client.poru.resolve({ query: song.uri, source: 'ytsearch' });
                            const track = res?.tracks?.[0];
                            if (track) {
                                track.info.requester = message.author;
                                player.queue.add(track);
                                added++;
                            }
                        } catch { }
                    }));
                }

                if (!player.isPlaying && !player.isPaused) player.play();

                return msg.channel.send({
                    content: `✅ تم إضافة **${added}** أغنية من لايكاتك للطابور.`,
                    allowedMentions: { repliedUser: false },
                }).then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
            }
        });

        collector.on('end', (_, reason) => {
            if (reason !== 'closed') msg.edit({ components: [] }).catch(() => {});
        });
    },
};
