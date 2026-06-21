const store = require('../../utils/store');
const { owners } = require('../../config');
const { EmbedBuilder } = require('discord.js');
const { applyProfileToToken, getSubBotProfile, resolveProfileAssets } = require('../../utils/subBotProfile');
const { getEmbedColor } = require('../../utils/embedColor');

// ── constants ────────────────────────────────────────────────────────────────
const RESTART_BATCH_SIZE  = 5;    // bots processed in parallel per batch
const RESTART_BATCH_DELAY = 1200; // ms pause between batches (avoids API flood)
const RESTART_EDIT_DELAY  = 2500; // ms minimum between progress edits

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildBar(current, total, width = 20) {
    const filled = total > 0 ? Math.round((current / total) * width) : 0;
    return `\`[${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}]\` \`${current}/${total}\``;
}

function fmtTime(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

function fmtSpeed(done, elapsedMs) {
    if (!elapsedMs || done === 0) return '—';
    return `${(done / (elapsedMs / 1000)).toFixed(1)}/s`;
}

// ── command ──────────────────────────────────────────────────────────────────
module.exports = {
    name: 'musicrestart',
    aliases: ['musicrestart'],
    async execute(client, message) {
        if (!owners.includes(message.author.id)) return;

        try {
            const allBots   = store.get('bots') || [];
            const activeSubs = new Set((store.get('tokens') || []).map(t => t.token));
            const botsArray  = allBots.filter(b => !activeSubs.has(b.token));
            const skipped    = allBots.length - botsArray.length;
            const total      = botsArray.length;

            if (total === 0) {
                return message.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle('Restart Stock Bots')
                        .setDescription(
                            `لا توجد بوتات حرة في الستوك حالياً.` +
                            (skipped > 0 ? `\n\nتم تجاهل \`${skipped}\` بوت لأنها ضمن اشتراكات نشطة.` : ''))
                        .setColor(getEmbedColor(client))],
                });
            }

            // Batch math for ETA estimate
            const totalBatches = Math.ceil(total / RESTART_BATCH_SIZE);
            const estMs        = totalBatches * (5000 + RESTART_BATCH_DELAY);

            const progressMsg = await message.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Restart Stock Bots — Starting')
                    .setDescription('جاري إعادة تهيئة البوتات الحرة وتطبيق الاسم والصورة والبنر.')
                    .addFields(
                        { name: 'Total',         value: `\`${total}\``,                                      inline: true },
                        { name: 'Batch Size',    value: `\`${RESTART_BATCH_SIZE}\``,                         inline: true },
                        { name: 'Total Batches', value: `\`${totalBatches}\``,                               inline: true },
                        { name: 'Batch Delay',   value: `\`${RESTART_BATCH_DELAY}ms\``,                      inline: true },
                        { name: 'Skipped Active',value: `\`${skipped}\``,                                    inline: true },
                        { name: 'ETA (est)',      value: `\`${fmtTime(estMs)}\``,                             inline: true },
                    )
                    .setColor(getEmbedColor(client))],
            });

            // Resolve profile + assets ONCE (one image download for all bots)
            const profile = getSubBotProfile();
            let assets = { avatarData: null, bannerData: null };
            try { assets = await resolveProfileAssets(profile); } catch {}

            let done     = 0;
            let failed   = 0;
            let lastEdit = 0;
            const startMs = Date.now();

            const buildProgressEmbed = (title, batchNum) => {
                const elapsedMs = Date.now() - startMs;
                const processed = done + failed;
                const remaining = total - processed;
                const speed     = elapsedMs > 0 && processed > 0 ? processed / (elapsedMs / 1000) : 0;
                const etaMs     = speed > 0 ? (remaining / speed) * 1000 : null;

                return new EmbedBuilder()
                    .setTitle(title)
                    .addFields(
                        { name: 'Progress',       value: buildBar(processed, total),              inline: false },
                        { name: '✅ Done',         value: `\`${done}\``,                           inline: true  },
                        { name: '❌ Failed',       value: `\`${failed}\``,                         inline: true  },
                        { name: 'Left',           value: `\`${remaining}\``,                      inline: true  },
                        { name: 'Batch',          value: `\`${batchNum}/${totalBatches}\``,       inline: true  },
                        { name: 'Elapsed',        value: `\`${fmtTime(elapsedMs)}\``,             inline: true  },
                        { name: 'Speed',          value: `\`${fmtSpeed(processed, elapsedMs)}\``, inline: true  },
                        { name: 'ETA',            value: `\`${fmtTime(etaMs)}\``,                 inline: true  },
                    )
                    .setColor(getEmbedColor(client));
            };

            // ── main loop — true batches with inter-batch delay ──────────────
            for (let b = 0; b < totalBatches; b++) {
                const batchNum = b + 1;
                const slice    = botsArray.slice(b * RESTART_BATCH_SIZE, batchNum * RESTART_BATCH_SIZE);

                await Promise.allSettled(slice.map(async (bot) => {
                    try {
                        await applyProfileToToken(bot.token, { profile, assets, leaveGuilds: true });
                        done++;
                    } catch (err) {
                        failed++;
                        console.error(`[musicrestart] batch ${batchNum} error: ${err.message}`);
                    }
                }));

                // Progress edit (rate-limited to once per RESTART_EDIT_DELAY)
                const now = Date.now();
                if (b < totalBatches - 1 && now - lastEdit >= RESTART_EDIT_DELAY) {
                    lastEdit = now;
                    await progressMsg.edit({
                        embeds: [buildProgressEmbed('Restart Stock Bots — In Progress', batchNum)],
                    }).catch(() => {});
                }

                // Inter-batch delay (avoids API flood; skip after last batch)
                if (b < totalBatches - 1) await sleep(RESTART_BATCH_DELAY);
            }

            // ── final summary ────────────────────────────────────────────────
            const totalMs = Date.now() - startMs;
            await progressMsg.edit({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Restart Stock Bots — Complete')
                    .addFields(
                        { name: 'Progress',      value: buildBar(total, total),          inline: false },
                        { name: '✅ Success',     value: `\`${done}\``,                   inline: true  },
                        { name: '❌ Failed',      value: `\`${failed}\``,                 inline: true  },
                        { name: 'Total',         value: `\`${total}\``,                  inline: true  },
                        { name: 'Batches',       value: `\`${totalBatches}\``,           inline: true  },
                        { name: 'Skipped Active',value: `\`${skipped}\``,                inline: true  },
                        { name: 'Elapsed',       value: `\`${fmtTime(totalMs)}\``,       inline: true  },
                        { name: 'Avg Speed',     value: `\`${fmtSpeed(done, totalMs)}\``,inline: true  },
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
            }).catch(() => {});
        }
    },
};
