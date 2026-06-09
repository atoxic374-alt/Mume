const { owners, logChannelId } = require('../../config');
const { applyProfileToToken, getSubBotProfile } = require('../../utils/subBotProfile');
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');
const { buildSubscriptionRemovedDm } = require('../../utils/subscriptionDm');

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
	        const msg = "**Subscription Not Found**\nلا يوجد اشتراك مرتبط بهذا الايدي.";
	        return interaction ? interaction.update({ content: msg, embeds: [], components: [] }) : message.reply(msg);
	      }
	
	      const embed = new EmbedBuilder()
	        .setTitle('Confirm Subscription Removal')
	        .setDescription('راجع بيانات الاشتراك قبل تأكيد الحذف. عند التأكيد سيتم إرجاع البوتات للستوك وتنظيف إعداداتها.')
	        .addFields(
	          { name: 'Subscription ID', value: `\`${entry.code}\``, inline: true },
	          { name: 'User', value: `<@${entry.user}>`, inline: true },
	          { name: 'Bot Count', value: `\`${entry.botsCount}\``, inline: true },
	          { name: 'Server', value: `\`${entry.server}\``, inline: true }
	        )
	        .setColor(getEmbedColor(client));

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_rem_${code}_${mid}`).setLabel('تأكيد الحذف').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`cancel_rem_${mid}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
      );

      const msgData = { embeds: [embed], components: [row], content: null };
      const prompt = interaction ? await interaction.update(msgData) : await message.reply(msgData);

      const collector = (interaction ? interaction.message : prompt).createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 60000 });

	      collector.on('collect', async i => {
	        if (i.customId === `cancel_rem_${mid}`) {
	          await i.update({ content: '**Cancelled**\nتم إلغاء العملية.', embeds: [], components: [] });
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
	      if (timeData.length === 0) return message.reply("**No Active Subscriptions**\nلا توجد اشتراكات نشطة حالياً.");

      const select = new StringSelectMenuBuilder()
        .setCustomId(`rem_select_${mid}`)
	        .setPlaceholder('Select subscription to remove')
        .addOptions(timeData.slice(0, 25).map(e => ({
          label: `SuID: ${e.code}`,
          description: `User: ${e.user} | Bots: ${e.botsCount}`,
          value: e.code
        })));

      const row = new ActionRowBuilder().addComponents(select);
	      const prompt = await message.reply({ content: '**Remove Subscription**\nاختر الاشتراك المراد حذفه:', components: [row] });

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
	    if (subIdx === -1) return message.reply("**Subscription Not Found**\nلم يتم العثور على الاشتراك.");
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

	    message.channel.send(`**Subscription Removed**\nتم حذف الاشتراك \`${code}\` بنجاح. سيتم تنظيف البوتات الآن.`);

    // DM Owner
    client.users.fetch(userId).then(u => {
      u.send({ embeds: [buildSubscriptionRemovedDm(client, {
        code,
        botCount: sub.botsCount || tokensToRemove.length,
        serverId: sub.server,
      })] }).catch(() => {});
    }).catch(() => {});

    // Log
    const logChannel = client.channels.cache.get(logChannelId);
    if (logChannel) {
	      logChannel.send({
	        embeds: [new EmbedBuilder()
	          .setTitle('Subscription Removed')
	          .setDescription('تم حذف الاشتراك وإرجاع بوتاته إلى الستوك.')
	          .addFields(
	            { name: 'User', value: `<@${userId}>`, inline: true },
	            { name: 'Subscription ID', value: `\`${code}\``, inline: true },
	            { name: 'Bot Count', value: `\`${tokensToRemove.length}\``, inline: true },
	            { name: 'Removed By', value: `<@${message.author.id}>`, inline: true }
	          )
	          .setColor(getEmbedColor(client))
	          .setTimestamp()]
      });
    }

    // Clean bots
    for (const t of tokensToRemove) {
      try {
        const profile = getSubBotProfile();
        await applyProfileToToken(t.token, { profile, leaveGuilds: true });
      } catch (e) { console.error(`Error cleaning bot ${t.token.slice(0,10)}...:`, e); }
    }
	  } catch (e) {
	    console.error(e);
	    message.reply("**Removal Failed**\nحدث خطأ أثناء التنفيذ.");
	  }
	}
