const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const store = require('./utils/store');
const { getEmbedColor } = require('./utils/embedColor');

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

        client.once('clientReady', () => {
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

async function resolveBotName(mainClient, botId, runningName) {
    if (runningName) return runningName;
    if (!botId) return null;

    const user = await mainClient.users.fetch(botId).catch(() => null);
    return user?.username || null;
}

function shouldSendNoStockNotice(entry, oldBotId) {
    const sameInvalidBot = entry.invalidBotId === oldBotId;
    const lastNotice = Number(entry.invalidTokenNotifiedAt || 0);
    return !sameInvalidBot || !lastNotice;
}

// ── Notify subscription owner with a clean embed ──────────────────────────────
async function notifyOwner(mainClient, entry, oldBotName, newBotInfo) {
    try {
        const owner = await mainClient.users.fetch(entry.client).catch(() => null);
        if (!owner) return;

        const oldDisplay = oldBotName ? `**${oldBotName}**` : '**Previous bot**';
        const newDisplay = newBotInfo?.name ? `**${newBotInfo.name}**` : '**New bot**';

        const desc = [
            `> **Bot replaced automatically**`,
            `> تم استبدال البوت تلقائياً بنفس إعدادات اشتراكك.`,
            ``,
            `**Subscription:** \`${entry.code}\``,
            `**Old Bot:** ${oldDisplay}`,
            `**New Bot:** ${newDisplay}`,
            ``,
            `ادعُ البوت الجديد فقط. القنوات، الحالة، المنصة، والأزرار بقيت كما هي.`,
        ].join('\n');

        const embed = new EmbedBuilder()
            .setColor(getEmbedColor(newBotInfo?.avatar || mainClient))
            .setTitle('Bot Ready')
            .setDescription(desc)
            .setTimestamp();

        if (newBotInfo?.avatar) embed.setThumbnail(newBotInfo.avatar);
        embed.setFooter({ text: 'لا تشارك توكنات البوت مع أي شخص.' });

        const components = [];
        if (newBotInfo?.invite) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Invite Bot')
                    .setStyle(ButtonStyle.Link)
                    .setURL(newBotInfo.invite),
                new ButtonBuilder()
                    .setLabel('Support')
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

async function notifyNoStock(mainClient, entry, oldBotName) {
    const noStockEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('Bot Waiting For Replacement')
        .setDescription([
            `> **Your bot is paused temporarily.**`,
            `> البوت متوقف مؤقتاً ولا يوجد بديل متاح الآن.`,
            ``,
            `**Subscription:** \`${entry.code}\``,
            `**Bot:** ${oldBotName ? `**${oldBotName}**` : '**Previous bot**'}`,
            ``,
            `سيتم استبداله تلقائياً بنفس الإعدادات عند توفر بوت بديل.`,
        ].join('\n'))
        .setTimestamp()
        .setFooter({ text: 'لا تشارك توكنات البوت مع أي شخص.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.gg/ens'),
    );

    const owner = await mainClient.users.fetch(entry.client).catch(() => null);
    if (owner) await owner.send({ embeds: [noStockEmbed], components: [row] }).catch(() => {});
}

// ── Main checker ──────────────────────────────────────────────────────────────
async function checkAndReplaceTokens(mainClient) {
    try {
        let tokensArray = store.get('tokens') || [];
        let botsArray   = store.get('bots')   || [];

        let changed = false;
        const replacementsToStart = [];
        const invalidTokensToRemove = new Set();
        const batchSize = 5;

        // جلب runningBots لمعرفة اسم البوت القديم لو كان شغّالاً
        let runningBots;
        try { runningBots = require('./music').runningBots; } catch { runningBots = null; }

        for (let i = 0; i < tokensArray.length; i += batchSize) {
            const batch = tokensArray.slice(i, i + batchSize);

            await Promise.all(batch.map(async (entry) => {
                if (entry?.paused) return;
                const runningClient = runningBots?.get(entry.token);
                if (runningClient?.isReady?.()) return;

                const isValid = await validateToken(entry.token);
                if (isValid) return; // ✅ سليم — تجاوز

                console.log(`[TokenChecker] Invalid token detected — sub ${entry.code} owner ${entry.client}`);

                // ── معلومات البوت القديم ──────────────────────────────────
                const oldBotId = extractBotId(entry.token);
                const oldBotName = await resolveBotName(
                    mainClient,
                    oldBotId,
                    runningBots?.get(entry.token)?.user?.username || null
                );

                const stopInvalidClient = async () => {
                    const oldClient = runningBots?.get(entry.token);
                    if (oldClient) {
                        await oldClient.destroy().catch(() => {});
                        runningBots.delete(entry.token);
                    }
                };

                // ── استبدال من المخزون ────────────────────────────────────
                if (botsArray.length === 0) {
                    console.log(`[TokenChecker] Removed invalid token for sub ${entry.code} — no replacement stock`);
                    await stopInvalidClient();
                    invalidTokensToRemove.add(entry.token);
                    changed = true;
                    return;
                }

                const oldToken = entry.token;
                let newBot = null;
                let newBotInfo = null;

                while (botsArray.length > 0 && !newBotInfo) {
                    newBot = botsArray.shift();
                    newBotInfo = await fetchBotInfo(newBot.token);
                    if (!newBotInfo) {
                        changed = true;
                        console.warn(`[TokenChecker] Skipped invalid replacement token from stock — sub ${entry.code}`);
                    }
                }

                if (!newBotInfo) {
                    console.log(`[TokenChecker] Removed invalid token for sub ${entry.code} — no valid replacement token`);
                    await stopInvalidClient();
                    invalidTokensToRemove.add(oldToken);
                    changed = true;
                    return;
                }

                entry.token = newBot.token;
                delete entry.invalidBotId;
                delete entry.invalidBotName;
                delete entry.invalidTokenNotifiedAt;
                delete entry.awaitingReplacement;
                changed = true;

                console.log(`[TokenChecker] Replaced token for sub ${entry.code} → new bot ${newBotInfo?.name || '?'} (${newBotInfo?.id || '?'})`);

                // ── إشعار المالك ──────────────────────────────────────────
                const oldClient = runningBots?.get(oldToken);
                if (oldClient) {
                    await oldClient.destroy().catch(() => {});
                    runningBots.delete(oldToken);
                }

                replacementsToStart.push({ token: entry.token, Server: entry.Server });

                await notifyOwner(mainClient, entry, oldBotName, newBotInfo);
            }));
        }

        if (invalidTokensToRemove.size > 0) {
            tokensArray = tokensArray.filter(entry => !invalidTokensToRemove.has(entry.token));
        }

        if (changed) {
            store.set('tokens', tokensArray);
            store.set('bots',   botsArray);
            store.flushSync();
        }

        if (replacementsToStart.length > 0) {
            const music = require('./music');
            for (const botData of replacementsToStart) {
                setImmediate(() => {
                    music.runsys(botData.token, botData.Server).catch((err) => {
                        console.error(`[TokenChecker] Failed to start replacement for ${botData.Server}:`, err?.message || err);
                    });
                });
            }
        }

    } catch (err) {
        console.error('[TokenChecker] Fatal error:', err);
    }
}

module.exports = { checkAndReplaceTokens, validateToken };
