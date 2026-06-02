const { owners, prefix } = require(`${process.cwd()}/settings/config`);
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
      .setColor(getEmbedColor(client))
      .setDescription(`***Tokens Stock,***\n***works:*** ${userTokenCount} \`${userTokenCount === 0 ? '🔴' : '🟢'}\`\n***Available:*** ${botTokenCount} \`🟢\``)
   
    message.reply({ embeds: [embed] });
  }
};
