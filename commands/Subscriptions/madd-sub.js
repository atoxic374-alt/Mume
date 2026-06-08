const { owners, logChannelId } = require('../../config');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const ms = require('ms');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');
const { buildSubscriptionActivatedDm } = require('../../utils/subscriptionDm');

module.exports = {
  name: 'musicaddsub',
  aliases: ['madd-sub'],
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (message.author.bot) return;
    if (!check(message.author.id, 'musicaddsub')) return;

    const mention = message.mentions.members.first();
    if (!mention) {
      return message.reply({
        embeds: [new EmbedBuilder().setDescription('> يرجى منشن الشخص.\n> مثال: `!madd-sub @user`').setColor(getEmbedColor(client))]
      });
    }

    const userId = mention.id;
    const mid = message.id;

    let state = 'COUNT';
    let selectedCount = null;
    let selectedDuration = null;
    let selectedDurationLabel = null;
    let serverId = null;

    const baseEmbed = () => new EmbedBuilder()
      .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
      .setThumbnail(mention.user.displayAvatarURL({ dynamic: true, size: 512 }))
      .addFields({ name: '👤 المستخدم', value: `<@${userId}>`, inline: true })
      .setFooter({ text: `${message.guild.name} | إضافة اشتراك`, iconURL: message.guild.iconURL({ dynamic: true }) })
      .setColor(getEmbedColor(client));

    const getBots = () => {
      return store.get('bots') || [];
    };

    const generateContent = () => {
      const bots = getBots();
      const maxAllowed = Math.min(bots.length, 5);
      const embeds = [];
      const components = [];

      if (state === 'COUNT') {
        const embed = baseEmbed()
          .setTitle('➕ إضافة اشتراك — عدد البوتات')
          .setDescription(`> اختر عدد البوتات المراد إضافتها.\n> المتاح حالياً: \`${bots.length}\` بوت`)
          .addFields({ name: '🤖 المتاح', value: `\`${bots.length}\` بوت`, inline: true });
        embeds.push(embed);

        const countRow1 = new ActionRowBuilder();
        for (let i = 1; i <= maxAllowed; i++) {
          countRow1.addComponents(
            new ButtonBuilder()
              .setCustomId(`st_count_${i}_${mid}`)
              .setLabel(`${i}`)
              .setStyle(ButtonStyle.Secondary)
          );
        }
        const countRow2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`st_count_custom_${mid}`).setLabel('مخصص').setEmoji('✏️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`st_cancel_${mid}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger)
        );
        if (countRow1.components.length > 0) components.push(countRow1);
        components.push(countRow2);
      } else if (state === 'TIME') {
        const embed = baseEmbed()
          .setTitle('➕ إضافة اشتراك — مدة الاشتراك')
          .setDescription('> اختر مدة الاشتراك.')
          .addFields(
            { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true }
          );
        embeds.push(embed);

        const timeRow1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`st_time_1d_${mid}`).setLabel('يوم').setEmoji('📅').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`st_time_7d_${mid}`).setLabel('أسبوع').setEmoji('🗓️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`st_time_30d_${mid}`).setLabel('شهر').setEmoji('📆').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`st_time_90d_${mid}`).setLabel('3 أشهر').setEmoji('🗃️').setStyle(ButtonStyle.Secondary)
        );
        const timeRow2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`st_time_custom_${mid}`).setLabel('مخصص').setEmoji('✏️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`st_back_COUNT_${mid}`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`st_cancel_${mid}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger)
        );
        components.push(timeRow1, timeRow2);
      } else if (state === 'SERVER') {
        const formattedDuration = formatDuration(selectedDuration);
        const embed = baseEmbed()
          .setTitle('➕ إضافة اشتراك — ايدي السيرفر')
          .setDescription('> اضغط الزر لإدخال ايدي السيرفر.')
          .addFields(
            { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true },
            { name: '⏳ المدة', value: `\`${formattedDuration}\``, inline: true }
          );
        embeds.push(embed);

        const serverRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`st_server_modal_${mid}`).setLabel('أدخل ايدي السيرفر').setEmoji('🖥️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`st_back_TIME_${mid}`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`st_cancel_${mid}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger)
        );
        components.push(serverRow);
      }

      return { embeds, components };
    };

    const prompt = await message.channel.send(generateContent());
    const collector = prompt.createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 300000 });

    collector.on('collect', async i => {
      const cid = i.customId;

      if (cid === `st_cancel_${mid}`) {
        await i.update({ embeds: [new EmbedBuilder().setDescription('> ✖️ تم الإلغاء.').setColor(getEmbedColor(client))], components: [] });
        return collector.stop();
      }

      if (cid.startsWith(`st_back_`)) {
        state = cid.split('_')[2];
        return i.update(generateContent());
      }

      if (state === 'COUNT') {
        if (cid.startsWith(`st_count_`)) {
          if (cid === `st_count_custom_${mid}`) {
            const bots = getBots();
            const modal = new ModalBuilder().setCustomId(`st_modal_count_${mid}`).setTitle('عدد البوتات المخصص');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('val').setLabel(`العدد (المتاح: ${bots.length})`).setPlaceholder(`1-${bots.length}`).setStyle(TextInputStyle.Short).setRequired(true)
            ));
            await i.showModal(modal);
            try {
              const mSubmit = await i.awaitModalSubmit({ filter: mi => mi.customId === `st_modal_count_${mid}`, time: 60000 });
              const val = parseInt(mSubmit.fields.getTextInputValue('val').trim(), 10);
              if (isNaN(val) || val <= 0 || val > bots.length) {
                return mSubmit.reply({ content: `❌ عدد غير صحيح. المتاح: ${bots.length}`, ephemeral: true });
              }
              selectedCount = val;
              state = 'TIME';
              await mSubmit.deferUpdate();
              await prompt.edit(generateContent());
            } catch { /* ignore timeout */ }
          } else {
            selectedCount = parseInt(cid.split('_')[2], 10);
            state = 'TIME';
            return i.update(generateContent());
          }
        }
      } else if (state === 'TIME') {
        if (cid.startsWith(`st_time_`)) {
          if (cid === `st_time_custom_${mid}`) {
            const modal = new ModalBuilder().setCustomId(`st_modal_time_${mid}`).setTitle('المدة المخصصة');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('val').setLabel('المدة').setPlaceholder('مثال: 30d, 1h').setStyle(TextInputStyle.Short).setRequired(true)
            ));
            await i.showModal(modal);
            try {
              const mSubmit = await i.awaitModalSubmit({ filter: mi => mi.customId === `st_modal_time_${mid}`, time: 60000 });
              const raw = mSubmit.fields.getTextInputValue('val').trim();
              const dur = ms(raw);
              if (!dur || dur <= 0) return mSubmit.reply({ content: '❌ صيغة مدة غير صحيحة.', ephemeral: true });
              selectedDuration = dur;
              selectedDurationLabel = raw;
              state = 'SERVER';
              await mSubmit.deferUpdate();
              await prompt.edit(generateContent());
            } catch { /* ignore timeout */ }
          } else {
            const val = cid.split('_')[2];
            selectedDuration = ms(val);
            selectedDurationLabel = val;
            state = 'SERVER';
            return i.update(generateContent());
          }
        }
      } else if (state === 'SERVER') {
        if (cid === `st_server_modal_${mid}`) {
          const modal = new ModalBuilder().setCustomId(`st_modal_server_${mid}`).setTitle('ايدي السيرفر');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('val').setLabel('ايدي السيرفر').setPlaceholder('17-20 خانة').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(20)
          ));
          await i.showModal(modal);
          try {
            const mSubmit = await i.awaitModalSubmit({ filter: mi => mi.customId === `st_modal_server_${mid}`, time: 60000 });
            const val = mSubmit.fields.getTextInputValue('val').trim();
            if (!/^\d{17,20}$/.test(val)) return mSubmit.reply({ content: '❌ ايدي غير صحيح.', ephemeral: true });
            serverId = val;
            await mSubmit.deferUpdate();
            collector.stop('FINISH');
          } catch { /* ignore timeout */ }
        }
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason !== 'FINISH') return;

      const bots = getBots();
      if (bots.length < selectedCount) {
        return prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ❌ عذراً، لم يعد هناك بوتات كافية.').setColor(getEmbedColor(client))], components: [] });
      }

      const randomCode = generateRandomCode(5);
      const expirationTime = Date.now() + selectedDuration;

      // Update time.json
      const timeArray = store.get('time') || [];
      timeArray.push({ user: userId, server: serverId, botsCount: selectedCount, subscriptionTime: selectedDurationLabel, expirationTime, code: `#${randomCode}` });
      store.set('time', timeArray);

      // Update tokens and bots
      const givenTokens = bots.splice(0, selectedCount);
      let tokens = store.get('tokens') || [];
      givenTokens.forEach(t => tokens.push({ token: t.token, Server: serverId, channel: null, chat: null, status: null, client: userId, code: `#${randomCode}` }));
      store.set('tokens', tokens);
      store.set('bots', bots);

      const formattedDuration = formatDuration(selectedDuration);

      // DM
      mention.send({
        embeds: [buildSubscriptionActivatedDm(client, {
          code: `#${randomCode}`,
          botCount: selectedCount,
          duration: formattedDuration,
          serverId,
          expiresAt: expirationTime,
        })]
      }).catch(() => {});

      // Log
      const logChannel = client.channels.cache.get(logChannelId);
      if (logChannel) {
        logChannel.send({
          embeds: [new EmbedBuilder().setTitle('إضافة اشتراك! ✅').addFields({ name: '👤 المستخدم', value: `<@${userId}>`, inline: true }, { name: '🖥️ السيرفر', value: `\`${serverId}\``, inline: true }, { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true }, { name: '⏳ المدة', value: `\`${formattedDuration}\``, inline: true }, { name: '🔖 SuID', value: `\`#${randomCode}\``, inline: true }, { name: '🛠️ بواسطة', value: `<@${message.author.id}>`, inline: true }).setColor(getEmbedColor(client)).setFooter({ text: `${message.guild.name} | Timer`, iconURL: message.guild.iconURL({ dynamic: true }) })]
        });
      }

      // Success
      await prompt.edit({
        embeds: [new EmbedBuilder().setTitle('✅ تمت إضافة الاشتراك بنجاح!').addFields({ name: '👤 المستخدم', value: `<@${userId}>`, inline: true }, { name: '🖥️ السيرفر', value: `\`${serverId}\``, inline: true }, { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true }, { name: '⏳ المدة', value: `\`${formattedDuration}\``, inline: true }, { name: '🔖 SuID', value: `\`#${randomCode}\``, inline: true }).setColor(getEmbedColor(client)).setFooter({ text: `${message.guild.name} | Timer`, iconURL: message.guild.iconURL({ dynamic: true }) })],
        components: []
      });
    });
  }
};

function generateRandomCode(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatDuration(msValue) {
  const d = Math.floor(msValue / 86400000);
  const h = Math.floor((msValue % 86400000) / 3600000);
  const m = Math.floor((msValue % 3600000) / 60000);
  const s = Math.floor((msValue % 60000) / 1000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}
