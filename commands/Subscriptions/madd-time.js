const { owners, logChannelId } = require(`${process.cwd()}/settings/config`);
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const ms = require('ms');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');

function formatDuration(msValue) {
  const d = Math.floor(msValue / 86400000);
  const h = Math.floor((msValue % 86400000) / 3600000);
  const m = Math.floor((msValue % 3600000) / 60000);
  const s = Math.floor((msValue % 60000) / 1000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}

module.exports = {
  name: 'musicaddtime',
  aliases: ["madd-time"],
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (!check(message.author.id, 'musicaddtime')) return;

    let timeData = store.get('time') || [];

    const mid = message.id;
    let selectedCode = args[0];

    const showTimeSelection = async (code, interaction = null) => {
      const entry = timeData.find(e => e.code === code);
      if (!entry) {
        const msg = "**لا يوجد اشتراك بهذا الايدي.**";
        return interaction ? interaction.update({ content: msg, components: [] }) : message.reply(msg);
      }

      const embed = new EmbedBuilder()
        .setTitle('⏳ إضافة وقت للاشتراك')
        .setDescription(`اختر الوقت المراد إضافته للاشتراك \`${code}\``)
        .addFields(
          { name: '👤 المستخدم', value: `<@${entry.user}>`, inline: true },
          { name: '📅 ينتهي في', value: `<t:${Math.floor(entry.expirationTime/1000)}:R>`, inline: true }
        )
        .setColor(getEmbedColor(client));

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`addtime_1d_${code}_${mid}`).setLabel('+1d').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`addtime_7d_${code}_${mid}`).setLabel('+7d').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`addtime_30d_${code}_${mid}`).setLabel('+30d').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`addtime_90d_${code}_${mid}`).setLabel('+90d').setStyle(ButtonStyle.Secondary)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`addtime_custom_${code}_${mid}`).setLabel('مخصص ✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`addtime_cancel_${mid}`).setLabel('إلغاء').setStyle(ButtonStyle.Danger)
      );

      const msgData = { embeds: [embed], components: [row1, row2], content: null };
      const prompt = interaction ? await interaction.update(msgData) : await message.reply(msgData);

      const collector = (interaction ? interaction.message : prompt).createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 60000 });

      collector.on('collect', async i => {
        if (i.customId === `addtime_cancel_${mid}`) {
          await i.update({ content: '❌ تم الإلغاء.', embeds: [], components: [] });
          return collector.stop();
        }

        if (i.customId.startsWith('addtime_')) {
          let durationStr = i.customId.split('_')[1];
          let durationMs = 0;

          if (durationStr === 'custom') {
            const modal = new ModalBuilder().setCustomId(`modal_time_${mid}`).setTitle('إضافة وقت مخصص');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('val').setLabel('الوقت (مثال: 1d, 12h)').setStyle(TextInputStyle.Short).setRequired(true)
            ));
            await i.showModal(modal);
            try {
              const mSubmit = await i.awaitModalSubmit({ filter: mi => mi.customId === `modal_time_${mid}`, time: 60000 });
              durationStr = mSubmit.fields.getTextInputValue('val').trim();
              durationMs = ms(durationStr);
              if (!durationMs || durationMs <= 0) return mSubmit.reply({ content: '❌ وقت غير صحيح.', ephemeral: true });
              await mSubmit.deferUpdate();
              await executeAddTime(code, durationMs, durationStr, message, client, prompt);
              collector.stop();
            } catch { }
          } else {
            durationMs = ms(durationStr);
            await i.deferUpdate();
            await executeAddTime(code, durationMs, durationStr, message, client, prompt);
            collector.stop();
          }
        }
      });
    };

    if (!selectedCode) {
      if (timeData.length === 0) return message.reply("**لا توجد اشتراكات.**");
      const select = new StringSelectMenuBuilder().setCustomId(`select_time_${mid}`).setPlaceholder('اختر الاشتراك').addOptions(timeData.slice(0, 25).map(e => ({ label: e.code, value: e.code })));
      const prompt = await message.reply({ content: 'اختر الاشتراك:', components: [new ActionRowBuilder().addComponents(select)] });
      const i = await prompt.awaitMessageComponent({ filter: it => it.user.id === message.author.id, time: 60000 }).catch(() => null);
      if (!i) return;
      await showTimeSelection(i.values[0], i);
    } else {
      await showTimeSelection(selectedCode);
    }
  }
};

async function executeAddTime(code, durationMs, durationStr, message, client, prompt) {
  try {
    let timeArray = store.get('time') || [];
    const entry = timeArray.find(e => e.code === code);
    if (!entry) return;

    const oldExpiry = entry.expirationTime;
    entry.expirationTime += durationMs;
    store.set('time', timeArray);

    const embed = new EmbedBuilder()
      .setTitle('✅ تم إضافة الوقت')
      .addFields(
        { name: '🔖 SuID', value: `\`${code}\``, inline: true },
        { name: '➕ الوقت المضاف', value: `\`${durationStr}\``, inline: true },
        { name: '📅 الانتهاء الجديد', value: `<t:${Math.floor(entry.expirationTime/1000)}:F>`, inline: false }
      )
      .setColor('#2ecc71');

    await prompt.edit({ embeds: [embed], components: [] });
    message.react('✅');

    const logChannel = client.channels.cache.get(logChannelId);
    if (logChannel) {
      logChannel.send({
        embeds: [new EmbedBuilder()
          .setTitle('تحديث وقت الاشتراك ⏳')
          .addFields(
            { name: '👤 المستخدم', value: `<@${entry.user}>`, inline: true },
            { name: '🔖 SuID', value: `\`${code}\``, inline: true },
            { name: '➕ الوقت المضاف', value: `\`${durationStr}\``, inline: true },
            { name: '📅 الانتهاء السابق', value: `<t:${Math.floor(oldExpiry/1000)}:R>`, inline: true },
            { name: '📅 الانتهاء الجديد', value: `<t:${Math.floor(entry.expirationTime/1000)}:R>`, inline: true },
            { name: '🛠️ بواسطة', value: `<@${message.author.id}>`, inline: true }
          )
          .setColor(getEmbedColor(client))]
      });
    }
  } catch (e) { console.error(e); }
}
