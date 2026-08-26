const { owners, prefix } = require('../../config');
const { EmbedBuilder } = require('discord.js');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');

module.exports = {
  name: 'musicstock',
  aliases: ["musicstock"],
  async execute(client, message, args) {

    if (!owners.includes(message.author.id)) return;
    if (message.author.bot) return;
    if (!check(message.author.id, 'musicstock')) return;

    const bots = store.get('bots') || [];
    const botTokenCount = bots.length;
    
    const tokens = store.get('tokens') || [];
	    const userTokenCount = tokens.length;
	    
	    const embed = new EmbedBuilder()
	      .setTitle('Token Stock')
	      .setColor(getEmbedColor(client))
	      .setDescription('ملخص البوتات المتاحة في الستوك والبوتات المستخدمة حالياً في الاشتراكات.')
	      .addFields(
	        { name: 'Used Bots', value: `\`${userTokenCount}\``, inline: true },
	        { name: 'Available Bots', value: `\`${botTokenCount}\``, inline: true },
	        { name: 'Total Bots', value: `\`${userTokenCount + botTokenCount}\``, inline: true }
	      );
	   
	    message.reply({ embeds: [embed] });
  }
};
