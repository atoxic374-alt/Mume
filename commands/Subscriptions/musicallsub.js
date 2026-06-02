const { owners } = require(`${process.cwd()}/settings/config`);
const { ActionRowBuilder, ButtonBuilder, EmbedBuilder, ButtonStyle } = require('discord.js');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');

module.exports = {
  name: 'musicallsub',
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (!check(message.author.id, 'musicallsub')) return;

    try {
      const logsArray = store.get('time') || [];

      if (logsArray.length === 0) {
        return message.reply('**لا توجد اشتراكات مسجلة حاليًا.**');
      }

      logsArray.sort((a, b) => b.expirationTime - a.expirationTime);

      const subscriptionsPerPage = 10;
      const totalPages = Math.ceil(logsArray.length / subscriptionsPerPage);
      let currentPage = 1;

      const generateEmbed = (page) => {
        const start = (page - 1) * subscriptionsPerPage;
        const end = start + subscriptionsPerPage;
        const subs = logsArray.slice(start, end);

        const embed = new EmbedBuilder()
          .setTitle('📋 جميع الاشتراكات')
          .setColor(getEmbedColor(client))
          .setFooter({ text: `الصفحة ${page}/${totalPages} | الإجمالي: ${logsArray.length}`, iconURL: client.user.displayAvatarURL() });

        let description = '';
        subs.forEach((sub, i) => {
          const remaining = sub.expirationTime - Date.now();
          let statusEmoji = '🟢';
          if (remaining < 86400000) statusEmoji = '🔴';
          else if (remaining < 604800000) statusEmoji = '🟡';

          const timeStr = formatDuration(remaining);
          description += `**${start + i + 1}.** ${statusEmoji} \`SuID: ${sub.code}\` | <@${sub.user}>\n`;
          description += `┕ 🤖 \`${sub.botsCount}\` بوتات | ⏳ \`${timeStr}\` متبقي\n\n`;
        });

        embed.setDescription(description || 'لا يوجد');
        return embed;
      };

      const generateButtons = () => {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 1),
          new ButtonBuilder().setCustomId('del').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === totalPages)
        );
      };

      const msg = await message.reply({ embeds: [generateEmbed(currentPage)], components: [generateButtons()] });
      const collector = msg.createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 120000 });

      collector.on('collect', async i => {
        if (i.customId === 'del') {
          await msg.delete().catch(() => {});
          return collector.stop();
        }
        currentPage = i.customId === 'next' ? Math.min(totalPages, currentPage + 1) : Math.max(1, currentPage - 1);
        await i.update({ embeds: [generateEmbed(currentPage)], components: [generateButtons()] });
      });

      collector.on('end', (_, r) => { if (r !== 'messageDelete') msg.edit({ components: [] }).catch(() => {}); });

    } catch (error) {
      console.error(error);
      message.reply('حدث خطأ أثناء جلب الاشتراكات.');
    }
  }
};

function formatDuration(msValue) {
  if (msValue <= 0) return 'منتهي';
  const d = Math.floor(msValue / 86400000);
  const h = Math.floor((msValue % 86400000) / 3600000);
  const m = Math.floor((msValue % 3600000) / 60000);
  return `${d}d ${h}h ${m}m`;
}
