const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { Colors } = require('./config');
const store = require('./utils/store');

// ── Extract bot ID from token (base64 first segment) ──────────────────────────
function extractBotId(token) {
    try {
        return Buffer.from(token.split('.')[0], 'base64').toString('utf-8');
    } catch {
        return null;
    }
}

// ── Login briefly to get bot info, then destroy ───────────────────────────────
async function fetchBotInfo(token) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            client.destroy();
            resolve(null);
        }, 8000);

        client.once('ready', () => {
            clearTimeout(timeout);
            const info = {
                id:       client.user.id,
                name:     client.user.username,
                avatar:   client.user.displayAvatarURL({ size: 256 }),
                invite:   `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot`,
            };
            client.destroy();
            resolve(info);
        });

        client.login(token).catch(() => {
            clearTimeout(timeout);
            client.destroy();
            resolve(null);
        });
    });
}

// ── Validate token (true = valid) ─────────────────────────────────────────────
async function validateToken(token) {
    if (!token) return false;
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    return new Promise((resolve) => {
        const timeout = setTimeout(() => { client.destroy(); resolve(false); }, 8000);
        client.login(token)
            .then(() => { clearTimeout(timeout); client.destroy(); resolve(true); })
            .catch(() => { clearTimeout(timeout); client.destroy(); resolve(false); });
    });
}

// ── Notify subscription owner with a clean embed ──────────────────────────────
async function notifyOwner(mainClient, entry, oldBotId, oldBotName, newBotInfo) {
    try {
        const owner = await mainClient.users.fetch(entry.client).catch(() => null);
        if (!owner) return;

        const oldDisplay = oldBotName
            ? `**${oldBotName}** (\`${oldBotId}\`)`
            : `\`${oldBotId || 'Unknown'}\``;

        // ── Description ──────────────────────────────────────────────────
        const desc = [
            `> **Your bot token has expired or been changed**`,
            `> التوكن الخاص ببوتك انتهى صلاحيته أو تغيّر`,
            ``,
            `**Subscription** — \`${entry.code}\``,
            `**Old Bot** — ${oldDisplay}`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `**What happened?**`,
            `الجهاز الذي أُنشئ منه التوكن قام بإعادة توليده، مما أبطل التوكن القديم.`,
            ``,
            `**What to do?**`,
            `1 — **Kick the old bot** من جميع سيرفراتك — اسمه ${oldDisplay}`,
            `2 — **Invite the new bot** باستخدام الرابط أدناه`,
            `3 — **Setup the new bot** بنفس الإعدادات السابقة`,
        ].join('\n');

        const embed = new EmbedBuilder()
            .setColor(0xED4245) // Discord red — خطر
            .setTitle('⚠️  Bot Token Replaced')
            .setDescription(desc)
            .setTimestamp();

        if (newBotInfo) {
            embed.addFields({
                name: '🤖  New Bot',
                value: [
                    `**Name** — ${newBotInfo.name}`,
                    `**ID** — \`${newBotInfo.id}\``,
                ].join('\n'),
                inline: false,
            });
            if (newBotInfo.avatar) embed.setThumbnail(newBotInfo.avatar);
        }

        embed.setFooter({ text: 'هذا الإشعار تلقائي — لا تشارك التوكنات مع أحد' });

        // ── Invite button ─────────────────────────────────────────────────
        const components = [];
        if (newBotInfo?.invite) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Invite New Bot')
                    .setStyle(ButtonStyle.Link)
                    .setURL(newBotInfo.invite),
                new ButtonBuilder()
                    .setLabel('Support Server')
                    .setStyle(ButtonStyle.Link)
                    .setURL('https://discord.gg/ens'),
            );
            components.push(row);
        }

        await owner.send({ embeds: [embed], components }).catch(() => {});

    } catch (err) {
        console.error(`[TokenChecker] Failed to notify owner ${entry.client}:`, err);
    }
}

// ── Main checker ──────────────────────────────────────────────────────────────
async function checkAndReplaceTokens(mainClient) {
    try {
        let tokensArray = store.get('tokens') || [];
        let botsArray   = store.get('bots')   || [];

        let changed = false;
        const batchSize = 5;

        // جلب runningBots لمعرفة اسم البوت القديم لو كان شغّالاً
        let runningBots;
        try { runningBots = require('./music').runningBots; } catch { runningBots = null; }

        for (let i = 0; i < tokensArray.length; i += batchSize) {
            const batch = tokensArray.slice(i, i + batchSize);

            await Promise.all(batch.map(async (entry) => {
                const isValid = await validateToken(entry.token);
                if (isValid) return; // ✅ سليم — تجاوز

                console.warn(`[TokenChecker] Invalid token detected — sub ${entry.code} owner ${entry.client}`);

                // ── معلومات البوت القديم ──────────────────────────────────
                const oldBotId   = extractBotId(entry.token);
                const oldBotName = runningBots?.get(entry.token)?.user?.username || null;

                // ── استبدال من المخزون ────────────────────────────────────
                if (botsArray.length === 0) {
                    console.error(`[TokenChecker] No replacement bots — sub ${entry.code}`);

                    // أُبلغ المالك حتى لو ما في استبدال
                    const noStockEmbed = new EmbedBuilder()
                        .setColor(0xED4245)
                        .setTitle('⚠️  Bot Token Expired — No Replacement Available')
                        .setDescription([
                            `> **Your bot token has expired or been changed**`,
                            `> التوكن الخاص ببوتك انتهى ولا يوجد بوت بديل حالياً`,
                            ``,
                            `**Subscription** — \`${entry.code}\``,
                            `**Old Bot** — ${oldBotName ? `**${oldBotName}** (\`${oldBotId}\`)` : `\`${oldBotId || 'Unknown'}\``}`,
                            ``,
                            `━━━━━━━━━━━━━━━━━━━━━━━━`,
                            ``,
                            `تواصل مع الإدارة لتجديد بوتك. سيتم إعادة تفعيل اشتراكك بمجرد توفّر بوت بديل.`,
                        ].join('\n'))
                        .setTimestamp()
                        .setFooter({ text: `اطرد البوت القديم حتى لا يشغل مكاناً — ${oldBotName || oldBotId || ''}` });

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel('Support Server')
                            .setStyle(ButtonStyle.Link)
                            .setURL('https://discord.gg/ens'),
                    );

                    const owner = await mainClient.users.fetch(entry.client).catch(() => null);
                    if (owner) await owner.send({ embeds: [noStockEmbed], components: [row] }).catch(() => {});
                    return;
                }

                const newBot = botsArray.shift();
                const oldToken = entry.token;
                entry.token = newBot.token;
                changed = true;

                // ── جلب معلومات البوت الجديد ──────────────────────────────
                const newBotInfo = await fetchBotInfo(entry.token);

                console.log(`[TokenChecker] Replaced token for sub ${entry.code} → new bot ${newBotInfo?.name || '?'} (${newBotInfo?.id || '?'})`);

                // ── إشعار المالك ──────────────────────────────────────────
                await notifyOwner(mainClient, entry, oldBotId, oldBotName, newBotInfo);
            }));
        }

        if (changed) {
            store.set('tokens', tokensArray);
            store.set('bots',   botsArray);
        }

    } catch (err) {
        console.error('[TokenChecker] Fatal error:', err);
    }
}

module.exports = { checkAndReplaceTokens, validateToken };
