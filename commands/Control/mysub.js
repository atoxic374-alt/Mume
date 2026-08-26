const { owners, prefix } = require('../../config');
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

      function makeBar(remaining) {
        const BAR = 12;
        const maxMs = remaining > 60 * 24 * 60 * 60 * 1000 ? 90 * 24 * 60 * 60 * 1000
          : remaining > 30 * 24 * 60 * 60 * 1000 ? 60 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;
        const ratio = Math.max(0, Math.min(1, remaining / maxMs));
        const filled = Math.round(ratio * BAR);
        const pct = Math.round(ratio * 100);
        return `\`[${'▓'.repeat(filled)}${'▒'.repeat(BAR - filled)}]\` ${pct}%`;
      }

      let description = '';
      userSubscriptions.forEach((userSubscription, index) => {
        const expirationTime = userSubscription.expirationTime;
        const remainingTime = Math.max(0, expirationTime - Date.now());
        const paused = !!userSubscription.pausedAt;

        const days = Math.floor(remainingTime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((remainingTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);
        const formattedTime = `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds ? `${seconds}s` : ''}`.trim() || '0s';

        const bar = makeBar(remainingTime);
        const statusLabel = paused ? ' — متوقف' : '';
        description += `**\`${index + 1}\`** — \`Music x${userSubscription.botsCount}\` — SuID \`${userSubscription.code}\`${statusLabel}\n`;
        description += `${bar} — \`${formattedTime}\`\n`;
        description += `ينتهي : <t:${Math.floor(expirationTime / 1000)}:R>\n\n`;
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
