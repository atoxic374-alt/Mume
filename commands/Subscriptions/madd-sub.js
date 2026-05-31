const fs = require('fs');
const { owners, Colors, logChannelId } = require(`${process.cwd()}/settings/config`);
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

module.exports = {
  name: 'musicaddsub',
  aliases: ['madd-sub'],
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (message.author.bot) return;

    const mention = message.mentions.members.first();
    if (!mention) {
      return message.reply({
        embeds: [new EmbedBuilder().setDescription('> يرجى منشن الشخص.\n> مثال: `!madd-sub @user`').setColor('#e74c3c')]
      });
    }

    const userId = mention.id;
    const mid = message.id;

    let bots = [];
    try {
      const data = fs.readFileSync('./settings/bots.json', 'utf8');
      bots = JSON.parse(data);
      if (!Array.isArray(bots)) bots = [];
    } catch {
      return message.reply({ embeds: [new EmbedBuilder().setDescription('> ❌ خطأ أثناء قراءة ملف البوتات.').setColor('#e74c3c')] });
    }

    const baseEmbed = () => new EmbedBuilder()
      .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
      .setThumbnail(mention.user.displayAvatarURL({ dynamic: true, size: 512 }))
      .addFields({ name: '👤 المستخدم', value: `<@${userId}>`, inline: true })
      .setFooter({ text: `${message.guild.name} | إضافة اشتراك`, iconURL: message.guild.iconURL({ dynamic: true }) })
      .setColor(Colors);

    const cancelBtn = () => new ButtonBuilder()
      .setCustomId(`cancel_${mid}`)
      .setLabel('إلغاء')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger);

    // ════════════════════════════════════════════════════════════
    // المرحلة 1 — اختيار عدد البوتات
    // ════════════════════════════════════════════════════════════
    const maxAllowed = Math.min(bots.length, 5);

    const countRow1 = new ActionRowBuilder();
    for (let i = 1; i <= Math.min(maxAllowed, 5); i++) {
      countRow1.addComponents(
        new ButtonBuilder()
          .setCustomId(`count_${i}_${mid}`)
          .setLabel(`${i}`)
          .setStyle(ButtonStyle.Secondary)
      );
    }
    const countRow2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`count_custom_${mid}`).setLabel('مخصص').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      cancelBtn()
    );

    const components1 = maxAllowed > 0 ? [countRow1, countRow2] : [countRow2];

    const prompt = await message.channel.send({
      embeds: [
        baseEmbed()
          .setTitle('➕ إضافة اشتراك — عدد البوتات')
          .setDescription(`> اختر عدد البوتات المراد إضافتها.\n> المتاح حالياً: \`${bots.length}\` بوت`)
          .addFields({ name: '🤖 المتاح', value: `\`${bots.length}\` بوت`, inline: true })
      ],
      components: components1
    });

    const btnFilter = i => i.user.id === message.author.id;
    let selectedCount = null;

    // collector المرحلة 1
    try {
      const i1 = await prompt.awaitMessageComponent({ filter: btnFilter, time: 60000 });

      if (i1.customId === `cancel_${mid}`) {
        await i1.update({ embeds: [new EmbedBuilder().setDescription('> ✖️ تم الإلغاء.').setColor('#e74c3c')], components: [] });
        return;
      }

      if (i1.customId === `count_custom_${mid}`) {
        // مودل للعدد المخصص
        const modal = new ModalBuilder().setCustomId(`count_modal_${mid}`).setTitle('عدد البوتات المخصص');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('custom_count')
              .setLabel(`عدد البوتات (المتاح: ${bots.length})`)
              .setPlaceholder(`أدخل رقماً من 1 إلى ${bots.length}`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(4)
          )
        );
        await i1.showModal(modal);
        let modalSubmit;
        try {
          modalSubmit = await i1.awaitModalSubmit({ filter: i => i.customId === `count_modal_${mid}` && i.user.id === message.author.id, time: 60000 });
        } catch {
          await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ⏰ انتهى الوقت.').setColor('#e74c3c')], components: [] });
          return;
        }
        await modalSubmit.deferUpdate();
        const val = parseInt(modalSubmit.fields.getTextInputValue('custom_count').trim(), 10);
        if (isNaN(val) || val <= 0) {
          await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ❌ أدخل رقماً صحيحاً أكبر من 0.').setColor('#e74c3c')], components: [] });
          return;
        }
        if (bots.length === 0) {
          await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ❌ لا توجد بوتات متاحة.').setColor('#e74c3c')], components: [] });
          return;
        }
        if (val > bots.length) {
          await prompt.edit({ embeds: [new EmbedBuilder().setDescription(`> ❌ المخزون لا يكفي، المتاح \`${bots.length}\`.`).setColor('#e74c3c')], components: [] });
          return;
        }
        selectedCount = val;
      } else {
        await i1.deferUpdate();
        selectedCount = parseInt(i1.customId.split('_')[1], 10);
      }
    } catch {
      await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ⏰ انتهى الوقت.').setColor('#e74c3c')], components: [] });
      return;
    }

    // ════════════════════════════════════════════════════════════
    // المرحلة 2 — اختيار المدة
    // ════════════════════════════════════════════════════════════
    const timeOptions = [
      { label: 'يوم', value: '1d', emoji: '📅' },
      { label: 'أسبوع', value: '7d', emoji: '🗓️' },
      { label: 'شهر', value: '30d', emoji: '📆' },
      { label: '3 أشهر', value: '90d', emoji: '🗃️' },
    ];

    const timeRow1 = new ActionRowBuilder();
    timeOptions.forEach(opt => {
      timeRow1.addComponents(
        new ButtonBuilder()
          .setCustomId(`time_${opt.value}_${mid}`)
          .setLabel(opt.label)
          .setEmoji(opt.emoji)
          .setStyle(ButtonStyle.Secondary)
      );
    });
    const timeRow2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`time_custom_${mid}`).setLabel('مخصص').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      cancelBtn()
    );

    await prompt.edit({
      embeds: [
        baseEmbed()
          .setTitle('➕ إضافة اشتراك — مدة الاشتراك')
          .setDescription('> اختر مدة الاشتراك.')
          .addFields(
            { name: '👤 المستخدم', value: `<@${userId}>`, inline: true },
            { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true }
          )
      ],
      components: [timeRow1, timeRow2]
    });

    let selectedDuration = null;
    let selectedDurationLabel = null;

    try {
      const i2 = await prompt.awaitMessageComponent({ filter: btnFilter, time: 60000 });

      if (i2.customId === `cancel_${mid}`) {
        await i2.update({ embeds: [new EmbedBuilder().setDescription('> ✖️ تم الإلغاء.').setColor('#e74c3c')], components: [] });
        return;
      }

      if (i2.customId === `time_custom_${mid}`) {
        const modal = new ModalBuilder().setCustomId(`time_modal_${mid}`).setTitle('المدة المخصصة');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('custom_time')
              .setLabel('مدة الاشتراك')
              .setPlaceholder('أمثلة: 30d  |  2w  |  12h  |  60m')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(10)
          )
        );
        await i2.showModal(modal);
        let modalSubmit;
        try {
          modalSubmit = await i2.awaitModalSubmit({ filter: i => i.customId === `time_modal_${mid}` && i.user.id === message.author.id, time: 60000 });
        } catch {
          await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ⏰ انتهى الوقت.').setColor('#e74c3c')], components: [] });
          return;
        }
        await modalSubmit.deferUpdate();
        const raw = modalSubmit.fields.getTextInputValue('custom_time').trim();
        const dur = ms(raw);
        if (!dur || dur <= 0) {
          await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ❌ صيغة المدة غير صحيحة.\nأمثلة: `30d` · `2w` · `12h` · `60m`').setColor('#e74c3c')], components: [] });
          return;
        }
        selectedDuration = dur;
        selectedDurationLabel = raw;
      } else {
        await i2.deferUpdate();
        const rawVal = i2.customId.split('_')[1] + 'd';
        // استخراج القيمة الصحيحة من اسم الزر
        const parts = i2.customId.split('_');
        const val = parts[1]; // e.g. "1d", "7d", "30d", "90d"
        selectedDuration = ms(val);
        selectedDurationLabel = val;
      }
    } catch {
      await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ⏰ انتهى الوقت.').setColor('#e74c3c')], components: [] });
      return;
    }

    // ════════════════════════════════════════════════════════════
    // المرحلة 3 — مودل ايدي السيرفر
    // ════════════════════════════════════════════════════════════
    const serverModalBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`open_server_${mid}`).setLabel('أدخل ايدي السيرفر').setEmoji('🖥️').setStyle(ButtonStyle.Primary),
      cancelBtn()
    );

    const formattedDuration = formatDuration(selectedDuration);

    await prompt.edit({
      embeds: [
        baseEmbed()
          .setTitle('➕ إضافة اشتراك — ايدي السيرفر')
          .setDescription('> اضغط الزر لإدخال ايدي السيرفر.')
          .addFields(
            { name: '👤 المستخدم', value: `<@${userId}>`, inline: true },
            { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true },
            { name: '⏳ المدة', value: `\`${formattedDuration}\``, inline: true }
          )
      ],
      components: [serverModalBtn]
    });

    let serverId = null;

    try {
      const i3 = await prompt.awaitMessageComponent({ filter: btnFilter, time: 60000 });

      if (i3.customId === `cancel_${mid}`) {
        await i3.update({ embeds: [new EmbedBuilder().setDescription('> ✖️ تم الإلغاء.').setColor('#e74c3c')], components: [] });
        return;
      }

      const modal = new ModalBuilder().setCustomId(`server_modal_${mid}`).setTitle('ايدي السيرفر');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('server_id')
            .setLabel('ايدي السيرفر')
            .setPlaceholder('مثال: 123456789012345678')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(17)
            .setMaxLength(20)
        )
      );
      await i3.showModal(modal);

      let modalSubmit;
      try {
        modalSubmit = await i3.awaitModalSubmit({ filter: i => i.customId === `server_modal_${mid}` && i.user.id === message.author.id, time: 60000 });
      } catch {
        await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ⏰ انتهى الوقت.').setColor('#e74c3c')], components: [] });
        return;
      }
      await modalSubmit.deferUpdate();

      serverId = modalSubmit.fields.getTextInputValue('server_id').trim();
      if (!/^\d{17,20}$/.test(serverId)) {
        await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ❌ ايدي السيرفر غير صحيح، يجب أن يكون رقماً 17-20 خانة.').setColor('#e74c3c')], components: [] });
        return;
      }
    } catch {
      await prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ⏰ انتهى الوقت.').setColor('#e74c3c')], components: [] });
      return;
    }

    // ════════════════════════════════════════════════════════════
    // تنفيذ الإضافة
    // ════════════════════════════════════════════════════════════
    const randomCode = generateRandomCode(5);
    const expirationTime = Date.now() + selectedDuration;

    try {
      const time = fs.readFileSync('./settings/time.json', 'utf8');
      const timeArray = JSON.parse(time);
      timeArray.push({ user: userId, server: serverId, botsCount: selectedCount, subscriptionTime: selectedDurationLabel, expirationTime, code: `#${randomCode}` });
      fs.writeFileSync('./settings/time.json', JSON.stringify(timeArray, null, 2));
    } catch (e) { console.error('❌> time.json:', e); }

    const givenTokens = bots.splice(0, selectedCount);
    let tokens = [];
    try {
      tokens = JSON.parse(fs.readFileSync('./settings/tokens.json', 'utf8'));
      if (!Array.isArray(tokens)) tokens = [];
    } catch { tokens = []; }

    givenTokens.forEach(t => {
      tokens.push({ token: t.token, Server: serverId, channel: null, chat: null, status: null, client: userId, code: `#${randomCode}` });
    });

    fs.writeFileSync('./settings/tokens.json', JSON.stringify(tokens, null, 2));
    fs.writeFileSync('./settings/bots.json', JSON.stringify(bots, null, 2));

    // DM
    mention.send({
      content: '```الشراء ناجح. اشتراكك مفعل الآن.```',
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: mention.user.username, iconURL: mention.user.displayAvatarURL({ dynamic: true, size: 1024 }) })
          .setTitle('🎵 تم تفعيل اشتراكك!')
          .addFields(
            { name: '🤖 البوتات', value: `\`${selectedCount}\` بوت`, inline: true },
            { name: '⏳ المدة', value: `\`${formattedDuration}\``, inline: true },
            { name: '🔖 رقم الاشتراك', value: `\`SuID #${randomCode}\``, inline: true }
          )
          .setFooter({ text: `${message.guild.name} | Timer`, iconURL: message.guild.iconURL({ dynamic: true }) })
          .setColor(Colors)
      ]
    }).catch(() => {});

    // لوق
    const logChannel = client.channels.cache.get(logChannelId);
    if (logChannel) {
      logChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('إضافة اشتراك! ✅')
            .setThumbnail('https://cdn.discordapp.com/attachments/1091536665912299530/1316233635464220803/512-512-max.png?ex=675a4d99&is=6758fc19&hm=352d005827ec0252e09be31a939f3c2f1abb3c8a0d660f20012ac80a2bc62b12&')
            .addFields(
              { name: '👤 المستخدم', value: `<@${userId}>`, inline: true },
              { name: '🖥️ السيرفر', value: `\`${serverId}\``, inline: true },
              { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true },
              { name: '⏳ المدة', value: `\`${formattedDuration}\``, inline: true },
              { name: '🔖 SuID', value: `\`#${randomCode}\``, inline: true },
              { name: '🛠️ بواسطة', value: `<@${message.author.id}>`, inline: true }
            )
            .setFooter({ text: `${message.guild.name} | Timer`, iconURL: message.guild.iconURL({ dynamic: true }) })
            .setColor(Colors)
        ]
      });
    }

    // نتيجة نهائية
    await prompt.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ تمت إضافة الاشتراك بنجاح!')
          .setThumbnail(mention.user.displayAvatarURL({ dynamic: true, size: 512 }))
          .addFields(
            { name: '👤 المستخدم', value: `<@${userId}>`, inline: true },
            { name: '🖥️ السيرفر', value: `\`${serverId}\``, inline: true },
            { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true },
            { name: '⏳ المدة', value: `\`${formattedDuration}\``, inline: true },
            { name: '🔖 SuID', value: `\`#${randomCode}\``, inline: true }
          )
          .setFooter({ text: `${message.guild.name} | Timer`, iconURL: message.guild.iconURL({ dynamic: true }) })
          .setColor('#2ecc71')
      ],
      components: []
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
