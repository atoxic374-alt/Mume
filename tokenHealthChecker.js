const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Colors } = require('./config');
const store = require('./utils/store');

async function validateToken(token) {
    if (!token) return false;
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            client.destroy();
            resolve(false);
        }, 8000);

        client.login(token)
            .then(() => {
                clearTimeout(timeout);
                client.destroy();
                resolve(true);
            })
            .catch(() => {
                clearTimeout(timeout);
                client.destroy();
                resolve(false);
            });
    });
}

async function checkAndReplaceTokens(mainClient) {
    try {
        let tokensArray = store.get('tokens') || [];
        let botsArray = store.get('bots') || [];

        let changed = false;
        const batchSize = 5;

        for (let i = 0; i < tokensArray.length; i += batchSize) {
            const batch = tokensArray.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (entry) => {
                const isValid = await validateToken(entry.token);
                if (!isValid) {
                    // Try to replace
                    if (botsArray.length > 0) {
                        const newBot = botsArray.shift();
                        const oldToken = entry.token;
                        entry.token = newBot.token;
                        changed = true;

                        // Notify owner
                        try {
                            const owner = await mainClient.users.fetch(entry.client);
                            if (owner) {
                                const embed = new EmbedBuilder()
                                    .setTitle('⚠️ تحديث توكن البوت')
                                    .setDescription(`تم استبدال توكن غير صالح في اشتراكك (\`${entry.code}\`) بتوكن جديد من المخزون.`)
                                    .addFields(
                                        { name: 'التوكن القديم', value: `\`${oldToken.substring(0, 10)}...\`` },
                                        { name: 'التوكن الجديد', value: `\`${entry.token.substring(0, 10)}...\`` }
                                    )
                                    .setColor(Colors);
                                await owner.send({ embeds: [embed] });
                            }
                        } catch (e) {
                            console.error(`Failed to notify owner ${entry.client}:`, e);
                        }
                    } else {
                        console.error(`No replacement bots available for invalid token in sub ${entry.code}`);
                    }
                }
                return entry;
            }));
        }

        if (changed) {
            store.set('tokens', tokensArray);
            store.set('bots', botsArray);
        }
    } catch (error) {
        console.error('Error in tokenHealthChecker:', error);
    }
}

module.exports = {
    checkAndReplaceTokens,
    validateToken
};
