const path = require('path');
const fs = require('fs');
const { owners, logChannelId } = require(`${process.cwd()}/settings/config`);

function getSubBotProfile() {
  const file = path.join(process.cwd(), 'settings', 'automatic.json');
  try {
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    return { prefix: saved.subBotPrefix || 'music', avatar: saved.subBotAvatar || null };
  } catch { return { prefix: 'music', avatar: null }; }
}
const { EmbedBuilder, Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');

module.exports = {
  name: 'musicremovesub',
  aliases: ["mremove-sub"],
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (message.author.bot) return;
    if (!check(message.author.id, 'musicremovesub')) return;

    const mid = message.id;
    let timeData = store.get('time') || [];

    let selectedCode = args[0];

    const confirmRemoval = async (code, interaction = null) => {
      const entry = timeData.find(e => e.code === code);
      if (!entry) {
        const msg = "**لا يوجد اشتراك مرتبط بهذا الايدي.**";
        return interaction ? interaction.update({ content: msg, embeds: [], components: [] }) : message.reply(msg);
      }

      const embed = new EmbedBuilder()
        .setTitle('⚠️ تأكيد الحذف')
        .setDescription(`هل أنت متأكد من رغبتك في حذف الاشتراك التالي؟`)
        .addFields(
          { name: '🔖 SuID', value: `\`${entry.code}\``, inline: true },
          { name: '👤 المستخدم', value: `<@${entry.user}>`, inline: true },
          { name: '🤖 البوتات', value: `\`${entry.botsCount}\``, inline: true },
          { name: '🖥️ السيرفر', value: `\`${entry.server}\``, inline: true }
        )
        .setColor('#f1c40f');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_rem_${code}_${mid}`).setLabel('تأكيد الحذف').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cancel_rem_${mid}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
      );

      const msgData = { embeds: [embed], components: [row], content: null };
      const prompt = interaction ? await interaction.update(msgData) : await message.reply(msgData);

      const collector = (interaction ? interaction.message : prompt).createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 60000 });

      collector.on('collect', async i => {
        if (i.customId === `cancel_rem_${mid}`) {
          await i.update({ content: '❌ تم إلغاء العملية.', embeds: [], components: [] });
          return collector.stop();
        }

        if (i.customId === `confirm_rem_${code}_${mid}`) {
          await i.deferUpdate();
          collector.stop();
          await executeRemoval(code, message, client);
        }
      });
    };

    if (!selectedCode) {
      if (timeData.length === 0) return message.reply("**لا توجد اشتراكات نشطة حالياً.**");

      const select = new StringSelectMenuBuilder()
        .setCustomId(`rem_select_${mid}`)
        .setPlaceholder('اختر الاشتراك المراد حذفه')
        .addOptions(timeData.slice(0, 25).map(e => ({
          label: `SuID: ${e.code}`,
          description: `User: ${e.user} | Bots: ${e.botsCount}`,
          value: e.code
        })));

      const row = new ActionRowBuilder().addComponents(select);
      const prompt = await message.reply({ content: 'اختر الاشتراك:', components: [row] });

      const collector = prompt.createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 60000 });
      collector.on('collect', async i => {
        if (i.customId === `rem_select_${mid}`) {
          selectedCode = i.values[0];
          await confirmRemoval(selectedCode, i);
          collector.stop();
        }
      });
    } else {
      await confirmRemoval(selectedCode);
    }
  }
};

async function executeRemoval(code, message, client) {
  try {
    let timeArray = store.get('time') || [];
    const subIdx = timeArray.findIndex(e => e.code === code);
    if (subIdx === -1) return message.reply("خطأ: لم يتم العثور على الاشتراك.");
    const sub = timeArray[subIdx];
    const userId = sub.user;
    timeArray.splice(subIdx, 1);
    store.set('time', timeArray);

    let tokensArray = store.get('tokens') || [];
    const tokensToRemove = tokensArray.filter(t => t.code === code);
    tokensArray = tokensArray.filter(t => t.code !== code);
    store.set('tokens', tokensArray);

    let botsArray = store.get('bots') || [];
    tokensToRemove.forEach(t => botsArray.push({ token: t.token }));
    store.set('bots', botsArray);

    message.channel.send(`✅ تم حذف الاشتراك \`${code}\` بنجاح. سيتم تنظيف البوتات الآن.`);

    // DM Owner
    client.users.fetch(userId).then(u => {
      u.send({ embeds: [new EmbedBuilder().setTitle('⚠️ تم إنهاء اشتراكك').setDescription(`تم إزالة اشتراكك برقم \`${code}\`.`).setColor('#e74c3c').setTimestamp()] }).catch(() => {});
    }).catch(() => {});

    // Log
    const logChannel = client.channels.cache.get(logChannelId);
    if (logChannel) {
      logChannel.send({
        embeds: [new EmbedBuilder()
          .setTitle('إزالة اشتراك 🔴')
          .addFields(
            { name: '👤 المستخدم', value: `<@${userId}>`, inline: true },
            { name: '🔖 SuID', value: `\`${code}\``, inline: true },
            { name: '🤖 البوتات', value: `\`${tokensToRemove.length}\``, inline: true },
            { name: '🛠️ بواسطة', value: `<@${message.author.id}>`, inline: true }
          )
          .setColor('#e74c3c')
          .setTimestamp()]
      });
    }

    // Clean bots
    for (const t of tokensToRemove) {
      try {
        const botClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        await botClient.login(t.token);
        for (const [id, guild] of botClient.guilds.cache) { await guild.leave(); }
        const profile = getSubBotProfile();
        if (profile.avatar) await botClient.user.setAvatar(profile.avatar).catch(() => {});
        const randomName = `${profile.prefix}-${Math.floor(Math.random() * 9000) + 1000}`;
        await botClient.user.setUsername(randomName);
        await botClient.destroy();
      } catch (e) { console.error(`Error cleaning bot ${t.token.slice(0,10)}...:`, e); }
    }
  } catch (e) {
    console.error(e);
    message.reply("حدث خطأ أثناء التنفيذ.");
  }
}
