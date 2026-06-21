const store = require('../../utils/store');
const { owners } = require('../../config');
const { EmbedBuilder } = require('discord.js');
const { applyProfileToToken, getSubBotProfile, resolveProfileAssets } = require('../../utils/subBotProfile');
const { getEmbedColor } = require('../../utils/embedColor');

const RESTART_CONCURRENCY = 5;

async function runLimited(items, concurrency, worker) {
    let index = 0;
    let active = 0;
    let resolve;
    const done = new Promise(r => { resolve = r; });
    if (items.length === 0) { resolve(); return done; }

    function next() {
        while (active < concurrency && index < items.length) {
            const i = index++;
            active++;
            Promise.resolve(worker(items[i], i)).finally(() => {
                active--;
                if (index >= items.length && active === 0) resolve();
                else next();
            });
        }
    }
    next();
    return done;
}

module.exports = {
    name: 'musicrestart',
    aliases: ['musicrestart'],
    async execute(client, message) {
        if (!owners.includes(message.author.id)) return;

        try {
            const allBots = store.get('bots') || [];
            const activeSubs = new Set((store.get('tokens') || []).map(t => t.token));
            const botsArray = allBots.filter(b => !activeSubs.has(b.token));
            const skipped = allBots.length - botsArray.length;

            if (botsArray.length === 0) {
                return message.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle('Restart Stock Bots')
                        .setDescription(`لا توجد بوتات حرة في الستوك حالياً.${skipped > 0 ? `\n\nتم تجاهل \`${skipped}\` بوت لأنها ضمن اشتراكات نشطة.` : ''}`)
                        .setColor(getEmbedColor(client))],
                });
            }

            const total = botsArray.length;
            const estSecs = Math.ceil((total / RESTART_CONCURRENCY) * 5);
            const estMin = Math.floor(estSecs / 60);
            const estSec = estSecs % 60;

            const progressMsg = await message.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Restart Stock Bots')
                    .setDescription('جاري إعادة تهيئة البوتات الحرة في الستوك وتطبيق إعدادات الاسم والصورة والبنر.')
                    .addFields(
                        { name: 'Stock Bots', value: `\`${total}\``, inline: true },
                        { name: 'Concurrency', value: `\`${RESTART_CONCURRENCY}\``, inline: true },
                        { name: 'Estimated Time', value: `\`${estMin}:${String(estSec).padStart(2, '0')}\``, inline: true },
                        { name: 'Skipped Active', value: `\`${skipped}\``, inline: true },
                        { name: 'Progress', value: `\`0/${total}\``, inline: true },
                    )
                    .setColor(getEmbedColor(client))],
            });

            // Resolve profile + assets once (download image once for all bots)
            const profile = getSubBotProfile();
            let assets = { avatarData: null, bannerData: null };
            try { assets = await resolveProfileAssets(profile); } catch {}

            let done = 0;
            let failed = 0;
            let lastEdit = 0;

            const buildBar = (current, total) => {
                const pct = total > 0 ? Math.round((current / total) * 20) : 0;
                return `\`[${'▰'.repeat(pct)}${'▱'.repeat(20 - pct)}]\` \`${current}/${total}\``;
            };

            await runLimited(botsArray, RESTART_CONCURRENCY, async (bot) => {
                try {
                    await applyProfileToToken(bot.token, { profile, assets, leaveGuilds: true });
                    done++;
                } catch (err) {
                    failed++;
                    console.error(`[musicrestart] token error: ${err.message}`);
                }

                const now = Date.now();
                if (now - lastEdit >= 2000) {
                    lastEdit = now;
                    await progressMsg.edit({
                        embeds: [new EmbedBuilder()
                            .setTitle('Restart Stock Bots — In Progress')
                            .addFields(
                                { name: 'Progress', value: buildBar(done + failed, total), inline: false },
                                { name: '✅ Done', value: `\`${done}\``, inline: true },
                                { name: '❌ Failed', value: `\`${failed}\``, inline: true },
                                { name: 'Left', value: `\`${total - done - failed}\``, inline: true },
                            )
                            .setColor(getEmbedColor(client))],
                    }).catch(() => {});
                }
            });

            await progressMsg.edit({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Restart Stock Bots — Complete')
                    .addFields(
                        { name: 'Total', value: `\`${total}\``, inline: true },
                        { name: '✅ Success', value: `\`${done}\``, inline: true },
                        { name: '❌ Failed', value: `\`${failed}\``, inline: true },
                        { name: 'Skipped Active', value: `\`${skipped}\``, inline: true },
                    )
                    .setColor(getEmbedColor(client))],
            }).catch(() => {});

        } catch (error) {
            console.error('[musicrestart] fatal error:', error);
            message.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Restart Failed')
                    .setDescription('حدث خطأ أثناء معالجة الأمر.')
                    .setColor(getEmbedColor(client))],
            });
        }
    },
};
