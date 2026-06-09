const { owners } = require('../../config');
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
	        return message.reply({
	          embeds: [new EmbedBuilder()
	            .setTitle('All Subscriptions')
	            .setDescription('لا توجد اشتراكات مسجلة حالياً.')
	            .setColor(getEmbedColor(client))]
	        });
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
	          .setTitle('All Subscriptions')
	          .setDescription('قائمة الاشتراكات الحالية مرتبة حسب تاريخ الانتهاء.')
	          .setColor(getEmbedColor(client))
	          .setFooter({ text: `Page ${page}/${totalPages} | Total: ${logsArray.length}`, iconURL: client.user.displayAvatarURL() });
	
	        let description = '';
	        subs.forEach((sub, i) => {
	          const remaining = sub.expirationTime - Date.now();
	          let status = 'Active';
	          if (remaining <= 0) status = 'Expired';
	          else if (remaining < 86400000) status = 'Ending Soon';
	          else if (remaining < 604800000) status = 'This Week';
	
	          const timeStr = formatDuration(remaining);
	          description += `**${start + i + 1}.** \`SuID: ${sub.code}\` | ${status}\n`;
	          description += `المستخدم: <@${sub.user}> | البوتات: \`${sub.botsCount}\` | المتبقي: \`${timeStr}\`\n\n`;
	        });
	
	        embed.setDescription(description || 'لا يوجد');
	        return embed;
	      };

	      const generateButtons = () => {
	        return new ActionRowBuilder().addComponents(
	          new ButtonBuilder().setCustomId('prev').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 1),
	          new ButtonBuilder().setCustomId('del').setLabel('Close').setStyle(ButtonStyle.Danger),
	          new ButtonBuilder().setCustomId('next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === totalPages)
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
	      message.reply('**All Subscriptions Failed**\nحدث خطأ أثناء جلب الاشتراكات.');
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
