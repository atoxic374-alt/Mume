const fs = require('fs');
const store = require('../../utils/store');
const { owners, emco, logChannelId, prefix, Services, price } = require('../../config');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js'); 
const path = require('path');
const axios = require('axios');

function getSubBotProfile() {
  const file = path.join(process.cwd(), 'settings', 'automatic.json');
  try {
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    return { prefix: saved.subBotPrefix || 'music', avatar: saved.subBotAvatar || null, banner: saved.subBotBanner || null };
  } catch { return { prefix: 'music', avatar: null, banner: null }; }
}

module.exports = {
    name: 'musicrestart',
    aliases: ["musicrestart"],
    async execute(client, message, args) {
        if (!owners.includes(message.author.id)) return;

        try {
            const allBots = store.get('bots') || [];
            const activeSubs = new Set((store.get('tokens') || []).map(t => t.token));
            const botsArray = allBots.filter(b => !activeSubs.has(b.token));
            const skipped = allBots.length - botsArray.length;

            if (botsArray.length === 0) {
                return message.reply(`**Restart :** *لا توجد بوتات حرة في الستوك${skipped > 0 ? ` (${skipped} بوت في اشتراكات نشطة لم تُمس)` : ''}.*`);
            }

            let totalBots = botsArray.length;
            let timePerBot = 5000; 
            let estimatedTimeInSeconds = (totalBots * timePerBot) / 1000;
            let estimatedMinutes = Math.floor(estimatedTimeInSeconds / 60);
            let estimatedSeconds = Math.round(estimatedTimeInSeconds % 60);

            message.reply(`**Restart :** *جاري إعادة تهيئة \`${totalBots}\` بوت حر (~\`${estimatedMinutes}:${estimatedSeconds < 10 ? '0' : ''}${estimatedSeconds}\` دقيقة)${skipped > 0 ? ` — تم تخطي \`${skipped}\` بوت في اشتراكات نشطة.` : ''}*`);

            for (const bot of botsArray) {
                const token = bot.token;
                const botClient = new Client({ intents: [GatewayIntentBits.Guilds] });

                try {
                    await botClient.login(token);
                    console.log(`Logged in as ${botClient.user.tag}`);

                    const profile = getSubBotProfile();
                    const randomNumber = generateRandomNumber();
                    await botClient.user.setUsername(`${profile.prefix}-${randomNumber}`);

                    if (profile.avatar) await botClient.user.setAvatar(profile.avatar).catch(() => {});

                    if (profile.banner) {
                      try {
                        const resp = await axios.get(profile.banner, { responseType: 'arraybuffer' });
                        const b64 = Buffer.from(resp.data).toString('base64');
                        await axios.patch('https://discord.com/api/v9/users/@me',
                          { banner: `data:image/png;base64,${b64}` },
                          { headers: { Authorization: `Bot ${token}` } }
                        );
                      } catch {}
                    }

                } catch (error) {
                    console.error(`Error setting avatar or banner for bot with token ${token}:`, error);
                    continue;
                }

                botClient.once('clientReady', async () => {
                    for (const guild of botClient.guilds.cache.values()) {
                        try {
                            await guild.leave();
                            console.log(`Left guild: ${guild.name}`);
                        } catch (error) {
                            console.error(`Error leaving guild ${guild.name}:`, error);
                        }
                    }

                    await botClient.destroy();
                });
            }
        } catch (error) {
            console.error('Error reading bots data:', error);
            message.reply('حدث خطأ أثناء معالجة الأمر.');
        }
    }
};

function generateRandomNumber() {
    return Math.floor(1000 + Math.random() * 9000); 
}
