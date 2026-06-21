const store = require('../../utils/store');
const { owners } = require('../../config');
const { EmbedBuilder } = require('discord.js');
const {
    applyProfileToToken,
    getSubBotProfile,
    resolveProfileAssets,
} = require('../../utils/subBotProfile');
const { getEmbedColor } = require('../../utils/embedColor');

// ── constants ────────────────────────────────────────────────────────────────
const MADD_BATCH_SIZE  = 3;    // parallel per batch (login is heavy — keep low)
const MADD_BATCH_DELAY = 1000; // ms pause between batches
const MADD_EDIT_DELAY  = 2500; // ms minimum between progress edits

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

// Incrementally save a new valid token to bots store
function saveTokenIncremental(tokenValue) {
    let bots = [...(store.get('bots') || [])];
    if (!bots.some(b => b.token === tokenValue)) {
        bots.push({ token: tokenValue });
        store.set('bots', bots);
    }
}

// ── command ──────────────────────────────────────────────────────────────────
module.exports = {
    name: 'musicaddtokens',
    aliases: ['madd-tokens'],
    async execute(client, message) {
        if (!owners.includes(message.author.id)) return;
        if (message.author.bot) return;

        const args = message.content.split(/\s+/);
        args.shift();
        const tokenValues = args.filter(Boolean);

        if (tokenValues.length === 0) {
            return message.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Add Bot Tokens')
                    .setDescription('يرجى كتابة التوكنات بعد الأمر، ويمكن وضع أكثر من توكن مفصول بمسافة.')
                    .setColor(getEmbedColor(client))],
            });
        }

        // De-duplicate input and filter already-known tokens
        const known = new Set([
            ...((store.get('bots')   || []).map(b => b.token)),
            ...((store.get('tokens') || []).map(t => t.token)),
        ].filter(Boolean));

        const duplicateTokens = [];
        const toProcess       = [];

        for (const tv of tokenValues) {
            const masked = `...${String(tv).slice(-6)}`;
            if (known.has(tv)) {
                duplicateTokens.push(masked);
            } else {
                toProcess.push({ value: tv, masked });
                known.add(tv); // prevent duplicates within the input list itself
            }
        }

        const total        = toProcess.length;
        const totalBatches = Math.ceil(total / MADD_BATCH_SIZE);

        // Quick reply if everything was duplicate
        if (total === 0) {
            return message.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Add Bot Tokens')
                    .setDescription(`جميع التوكنات المدخلة (\`${duplicateTokens.length}\`) موجودة بالفعل في الستوك.`)
                    .setColor(getEmbedColor(client))],
            });
        }

        // Resolve profile + assets ONCE (one image download for all bots)
        const profile = getSubBotProfile();
        let assets = { avatarData: null, bannerData: null };
        try { assets = await resolveProfileAssets(profile); } catch {}

        const estMs = Math.ceil(totalBatches * (6000 + MADD_BATCH_DELAY));

        const progressMsg = await message.reply({
            embeds: [new EmbedBuilder()
                .setTitle('Add Bot Tokens — Starting')
                .setDescription('جاري فحص التوكنات وتطبيق الاسم والصورة والبنر.')
                .addFields(
                    { name: 'New Tokens',    value: `\`${total}\``,                  inline: true },
                    { name: 'Duplicates',    value: `\`${duplicateTokens.length}\``, inline: true },
                    { name: 'Batch Size',    value: `\`${MADD_BATCH_SIZE}\``,        inline: true },
                    { name: 'Total Batches', value: `\`${totalBatches}\``,           inline: true },
                    { name: 'Batch Delay',   value: `\`${MADD_BATCH_DELAY}ms\``,    inline: true },
                    { name: 'ETA (est)',     value: `\`${fmtTime(estMs)}\``,         inline: true },
                )
                .setColor(getEmbedColor(client))],
        });

        let validCount  = 0;
        let failedCount = 0;
        let lastEdit    = 0;
        const startMs   = Date.now();
        const failedTokens = [];

        const buildProgressEmbed = (title, batchNum) => {
            const elapsedMs = Date.now() - startMs;
            const processed = validCount + failedCount;
            const remaining = total - processed;
            const speed     = elapsedMs > 0 && processed > 0 ? processed / (elapsedMs / 1000) : 0;
            const etaMs     = speed > 0 ? (remaining / speed) * 1000 : null;

            return new EmbedBuilder()
                .setTitle(title)
                .addFields(
                    { name: 'Progress',  value: buildBar(processed, total),               inline: false },
                    { name: '✅ Added',   value: `\`${validCount}\``,                      inline: true  },
                    { name: '❌ Failed',  value: `\`${failedCount}\``,                     inline: true  },
                    { name: 'Left',      value: `\`${remaining}\``,                       inline: true  },
                    { name: 'Batch',     value: `\`${batchNum}/${totalBatches}\``,        inline: true  },
                    { name: 'Elapsed',   value: `\`${fmtTime(elapsedMs)}\``,              inline: true  },
                    { name: 'Speed',     value: `\`${fmtSpeed(processed, elapsedMs)}\``,  inline: true  },
                    { name: 'ETA',       value: `\`${fmtTime(etaMs)}\``,                  inline: true  },
                )
                .setColor(getEmbedColor(client));
        };

        // ── main loop — true batches with inter-batch delay ──────────────────
        for (let b = 0; b < totalBatches; b++) {
            const batchNum = b + 1;
            const slice    = toProcess.slice(b * MADD_BATCH_SIZE, batchNum * MADD_BATCH_SIZE);

            await Promise.allSettled(slice.map(async ({ value: tv, masked }) => {
                try {
                    await applyProfileToToken(tv, { profile, assets, leaveGuilds: true });
                    // ← save immediately so partial runs aren't lost
                    saveTokenIncremental(tv);
                    validCount++;
                } catch (err) {
                    const isInvalid = /TOKEN_INVALID|invalid token/i.test(err.message);
                    console.error(`[madd-tokens] ${masked}: ${err.message}`);
                    failedTokens.push(masked);
                    failedCount++;
                    if (!isInvalid) {
                        // Not a bad token — e.g. network error; keep it as unknown (don't add)
                        console.warn(`[madd-tokens] ${masked}: non-auth error, skipping add`);
                    }
                }
            }));

            // Progress edit
            const now = Date.now();
            if (b < totalBatches - 1 && now - lastEdit >= MADD_EDIT_DELAY) {
                lastEdit = now;
                await progressMsg.edit({
                    embeds: [buildProgressEmbed('Add Bot Tokens — In Progress', batchNum)],
                }).catch(() => {});
            }

            // Inter-batch delay
            if (b < totalBatches - 1) await sleep(MADD_BATCH_DELAY);
        }

        // ── final summary ────────────────────────────────────────────────────
        const totalMs = Date.now() - startMs;
        const fields  = [
            { name: 'Progress',     value: buildBar(total, total),              inline: false },
            { name: 'Checked',      value: `\`${tokenValues.length}\``,         inline: true  },
            { name: '✅ Added',      value: `\`${validCount}\``,                 inline: true  },
            { name: '❌ Failed',     value: `\`${failedCount}\``,                inline: true  },
            { name: 'Duplicates',   value: `\`${duplicateTokens.length}\``,     inline: true  },
            { name: 'Elapsed',      value: `\`${fmtTime(totalMs)}\``,           inline: true  },
            { name: 'Avg Speed',    value: `\`${fmtSpeed(validCount, totalMs)}\``, inline: true },
        ];
        if (duplicateTokens.length) {
            fields.push({ name: 'Duplicate Tokens', value: duplicateTokens.slice(0, 10).map(t => `\`${t}\``).join('\n'), inline: true });
        }
        if (failedTokens.length) {
            fields.push({ name: 'Failed Tokens', value: failedTokens.slice(0, 10).map(t => `\`${t}\``).join('\n'), inline: true });
        }
        if (duplicateTokens.length > 10 || failedTokens.length > 10) {
            fields.push({ name: 'Hidden Results', value: 'تم إخفاء النتائج الإضافية.', inline: false });
        }

        await progressMsg.edit({
            embeds: [new EmbedBuilder()
                .setTitle('✅ Add Bot Tokens — Complete')
                .setDescription('تم فحص التوكنات وإضافة الصالح منها للستوك، مع تطبيق الاسم والصورة والبنر على البوت والـ App.')
                .addFields(fields)
                .setColor(getEmbedColor(client))],
        }).catch(() => {});

        await message.delete().catch(() => {});
    },
};
