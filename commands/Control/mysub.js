const { owners, prefix } = require(`${process.cwd()}/settings/config`);
const { EmbedBuilder } = require('discord.js');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');

module.exports = {
  name: 'mysub',
  aliases: ["اشتراك","my-sub"],
  async execute(client, message, args) {
    let userId;

    if (message.mentions.users.size > 0) {
      userId = message.mentions.users.first().id;
    } else if (args[0]) {
      userId = args[0];
    } else {
      userId = message.author.id;
    }

    if (!check(message.author.id, 'mysub')) return;

    try {
      const logsArray = store.get('time') || [];

      const userSubscriptions = logsArray.filter(entry => entry.user === userId);

      if (userSubscriptions.length === 0) {
        return;
      }

      let description = ''; 
      userSubscriptions.forEach((userSubscription, index) => {
        const expirationTime = userSubscription.expirationTime;
        const remainingTime = expirationTime - Date.now();

        const days = Math.floor(remainingTime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((remainingTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);

        const formattedTime = `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds ? `${seconds}s` : ''}`;
        description += `\`${index + 1}\` : \`Music x${userSubscription.botsCount} (SuID ${userSubscription.code})\` : \`${formattedTime}\`\n`;
      });

      const embed = new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setFooter({
          text: `${message.client.user.username} | Timer`,
          iconURL: `${message.client.user.displayAvatarURL({ dynamic: true })}`
        })
        .setDescription(description); 

      message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('❌>', error);
      message.reply('\`\`\`.حدث خطأ، يرجى التواصل مع الدعم الفن\`\`\`');
    }
  }
};
