const fs = require('fs');
const store = require('../../utils/store');
const path = require('path');
const axios = require('axios');

const { Client, GatewayIntentBits } = require('discord.js');
const { owners, prefix } = require('../../config');

function getSubBotProfile() {
  const AUTO_SETTINGS_FILE = path.join(process.cwd(), 'settings', 'automatic.json');
  try {
    const saved = fs.existsSync(AUTO_SETTINGS_FILE) ? JSON.parse(fs.readFileSync(AUTO_SETTINGS_FILE, 'utf8')) : {};
    return {
      prefix: saved.subBotPrefix || 'music',
      avatar: saved.subBotAvatar || null,
      banner: saved.subBotBanner || null,
    };
  } catch { return { prefix: 'music', avatar: null, banner: null }; }
}

module.exports = {
  name: 'musicaddtokens',
  aliases: ["madd-tokens"],
  async execute(client, message) {
    if (!owners.includes(message.author.id)) return;

    const botIntents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ];

    const clientCheck = new Client({ intents: botIntents });

    if (message.author.bot) return;

    const args = message.content.split(' ');
    const command = args.shift().toLowerCase();
    const tokenValues = args;

    if (tokenValues.length === 0) return message.reply('**يرجى إرفاق التوكن بعد الامر.**');

    const validTokens = [];

    for (const tokenValue of tokenValues) {
      try {
        await clientCheck.login(tokenValue);
        validTokens.push(tokenValue);
      } catch (error) {
        if (error.message === 'TOKEN_INVALID') {
          console.error(`❌ Not work! > ${tokenValue}`);
          message.reply(`\`❌ Not work! > ${tokenValue}\``);
        } else {
          console.error(`❌> ${tokenValue}`, error.message);
          message.reply(`\`**❌ Not work!** ${tokenValue}\``);
        }
      }
    }

    if (validTokens.length > 0) {
      let bots = [...(store.get('bots') || [])];

      for (const tokenValue of validTokens) {
        const tokenExists = bots.some(bot => bot.token === tokenValue);
        if (!tokenExists) {
          bots.push({ token: tokenValue });
        }
      }
      store.set('bots', bots);

      function generateRandomNumber() {
        return Math.floor(1000 + Math.random() * 9000); 
      }

      const expectedTimeSeconds = validTokens.length * 5; 
      const minutes = Math.floor(expectedTimeSeconds / 60);
      const seconds = expectedTimeSeconds % 60;
      const formattedTime = `(\`${minutes}:${seconds.toString().padStart(2, '0')}\`)`;

      message.channel.send(`تم إضافة **${validTokens.length}** بوت. سيستغرق تغير الإسم والصورة ${formattedTime}  دقيقة تقريبًا`);
      await message.delete();
      
      setTimeout(async () => {
        for (const tokenValue of validTokens) {
          try {
            const botClient = new Client({ intents: botIntents });
            await botClient.login(tokenValue);

            if (botClient.guilds.cache.size > 0) {
              botClient.guilds.cache.forEach(async guild => {
                try {
                  await guild.leave();
                } catch (leaveError) {
                  console.error(`❌ Error leaving guild ${guild.name}:`, leaveError.message);
                }
              });
            }

            const profile = getSubBotProfile();
            const randomNumber = generateRandomNumber();
            await botClient.user.setUsername(`${profile.prefix}-${randomNumber}`);

            if (profile.avatar) await botClient.user.setAvatar(profile.avatar);

            if (profile.banner) {
              const bannerResp = await axios.get(profile.banner, { responseType: 'arraybuffer' });
              const base64_banner_image = Buffer.from(bannerResp.data).toString('base64');
              await axios.patch(`https://discord.com/api/v9/users/@me`, {
                banner: `data:image/png;base64,${base64_banner_image}`
              }, { headers: { 'Authorization': `Bot ${tokenValue}` } });
            }

            await botClient.destroy();
          } catch (avatarError) {
            console.error(`❌>`, avatarError.message);
          }
        }
      }, 5000);
    }
  }
};
