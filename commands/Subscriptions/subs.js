const { owners, logChannelId } = require('../../config');

function getSubBotProfile() {
  const AUTO_SETTINGS_FILE = require('path').join(process.cwd(), 'settings', 'automatic.json');
  try {
    const saved = require('fs').existsSync(AUTO_SETTINGS_FILE) ? JSON.parse(require('fs').readFileSync(AUTO_SETTINGS_FILE, 'utf8')) : {};
    return { prefix: saved.subBotPrefix || 'music', avatar: saved.subBotAvatar || null, banner: saved.subBotBanner || null };
  } catch { return { prefix: 'music', avatar: null, banner: null }; }
}
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, AttachmentBuilder, Client, GatewayIntentBits
} = require('discord.js');
const ms = require('ms');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const store = require('../../utils/store');
const { getEmbedColor } = require('../../utils/embedColor');

// ─── Persistent button IDs ────────────────────────────────────────────────────
const BTN = {
  ADD_SUB:     'subs_panel_add',
  REMOVE_SUB:  'subs_panel_remove',
  ADD_TIME:    'subs_panel_addtime',
  ADD_TOKENS:  'subs_panel_tokens',
  ALL_SUBS:    'subs_panel_list',
  STOCK:       'subs_panel_stock',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(msValue) {
  const d = Math.floor(msValue / 86400000);
  const h = Math.floor((msValue % 86400000) / 3600000);
  const m = Math.floor((msValue % 3600000) / 60000);
  const s = Math.floor((msValue % 60000) / 1000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}

function generateCode(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function buildPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BTN.ADD_SUB).setLabel('إضافة اشتراك').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(BTN.REMOVE_SUB).setLabel('حذف اشتراك').setEmoji('➖').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(BTN.ADD_TIME).setLabel('إضافة وقت').setEmoji('⏳').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BTN.ADD_TOKENS).setLabel('إضافة بوتات').setEmoji('🤖').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(BTN.ALL_SUBS).setLabel('الاشتراكات').setEmoji('📊').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(BTN.STOCK).setLabel('الستوك').setEmoji('📦').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Flow: Add Subscription ───────────────────────────────────────────────────
async function handleAddSub(interaction, client) {
  const modal = new ModalBuilder().setCustomId('subs_add_uid').setTitle('إضافة اشتراك — المستخدم');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('uid').setLabel('ايدي المستخدم (Discord ID)').setPlaceholder('مثال: 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(20)
  ));
  await interaction.showModal(modal);

  let sub;
  try { sub = await interaction.awaitModalSubmit({ filter: mi => mi.customId === 'subs_add_uid' && mi.user.id === interaction.user.id, time: 120000 }); }
  catch { return; }

  const userId = sub.fields.getTextInputValue('uid').trim();
  if (!/^\d{17,20}$/.test(userId)) return sub.reply({ content: '❌ ايدي مستخدم غير صحيح.', ephemeral: true });

  let fetchedUser;
  try { fetchedUser = await client.users.fetch(userId); }
  catch { return sub.reply({ content: '❌ لم يتم العثور على المستخدم.', ephemeral: true }); }

  const mid = interaction.id;
  let state = 'COUNT', selectedCount = null, selectedDuration = null, selectedDurationLabel = null, serverId = null;
  const getBots = () => store.get('bots') || [];

  const baseEmbed = () => new EmbedBuilder()
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
    .setThumbnail(fetchedUser.displayAvatarURL({ dynamic: true, size: 512 }))
    .addFields({ name: '👤 المستخدم', value: `<@${userId}>`, inline: true })
    .setColor(getEmbedColor(client));

  const genContent = () => {
    const bots = getBots();
    const max = Math.min(bots.length, 5);
    const embeds = [], components = [];
    if (state === 'COUNT') {
      embeds.push(baseEmbed().setTitle('➕ إضافة اشتراك — عدد البوتات').setDescription(`> اختر عدد البوتات.\n> المتاح: \`${bots.length}\``).addFields({ name: '🤖 المتاح', value: `\`${bots.length}\` بوت`, inline: true }));
      const r1 = new ActionRowBuilder();
      for (let i = 1; i <= max; i++) r1.addComponents(new ButtonBuilder().setCustomId(`sa_c_${i}_${mid}`).setLabel(`${i}`).setStyle(ButtonStyle.Secondary));
      const r2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sa_c_x_${mid}`).setLabel('مخصص').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sa_cancel_${mid}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger)
      );
      if (r1.components.length) components.push(r1);
      components.push(r2);
    } else if (state === 'TIME') {
      embeds.push(baseEmbed().setTitle('➕ إضافة اشتراك — المدة').addFields({ name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true }));
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sa_t_1d_${mid}`).setLabel('يوم').setEmoji('📅').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`sa_t_7d_${mid}`).setLabel('أسبوع').setEmoji('🗓️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`sa_t_30d_${mid}`).setLabel('شهر').setEmoji('📆').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`sa_t_90d_${mid}`).setLabel('3 أشهر').setEmoji('🗃️').setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sa_t_x_${mid}`).setLabel('مخصص').setEmoji('✏️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`sa_back_COUNT_${mid}`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`sa_cancel_${mid}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger)
        )
      );
    } else if (state === 'SERVER') {
      embeds.push(baseEmbed().setTitle('➕ إضافة اشتراك — ايدي السيرفر').addFields(
        { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true },
        { name: '⏳ المدة', value: `\`${formatDuration(selectedDuration)}\``, inline: true }
      ));
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sa_srv_${mid}`).setLabel('أدخل ايدي السيرفر').setEmoji('🖥️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sa_back_TIME_${mid}`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`sa_cancel_${mid}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger)
      ));
    }
    return { embeds, components };
  };

  const prompt = await sub.reply({ ...genContent(), ephemeral: true, fetchReply: true });
  const coll = prompt.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 300000 });

  coll.on('collect', async i => {
    const cid = i.customId;
    if (cid === `sa_cancel_${mid}`) { await i.update({ embeds: [new EmbedBuilder().setDescription('> ✖️ تم الإلغاء.').setColor(getEmbedColor(client))], components: [] }); return coll.stop(); }
    if (cid.startsWith(`sa_back_`)) { state = cid.split('_')[2]; return i.update(genContent()); }

    if (state === 'COUNT') {
      if (cid === `sa_c_x_${mid}`) {
        const m2 = new ModalBuilder().setCustomId(`sa_mc_${mid}`).setTitle('عدد البوتات');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel(`العدد (المتاح: ${getBots().length})`).setStyle(TextInputStyle.Short).setRequired(true)));
        await i.showModal(m2);
        try {
          const s2 = await i.awaitModalSubmit({ filter: mi => mi.customId === `sa_mc_${mid}`, time: 60000 });
          const v = parseInt(s2.fields.getTextInputValue('v').trim(), 10);
          if (isNaN(v) || v <= 0 || v > getBots().length) return s2.reply({ content: `❌ عدد غير صحيح.`, ephemeral: true });
          selectedCount = v; state = 'TIME'; await s2.deferUpdate(); await prompt.edit(genContent());
        } catch {}
      } else {
        selectedCount = parseInt(cid.split('_')[2], 10); state = 'TIME'; return i.update(genContent());
      }
    } else if (state === 'TIME') {
      if (cid === `sa_t_x_${mid}`) {
        const m2 = new ModalBuilder().setCustomId(`sa_mt_${mid}`).setTitle('المدة');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel('المدة').setPlaceholder('مثال: 30d, 1h').setStyle(TextInputStyle.Short).setRequired(true)));
        await i.showModal(m2);
        try {
          const s2 = await i.awaitModalSubmit({ filter: mi => mi.customId === `sa_mt_${mid}`, time: 60000 });
          const raw = s2.fields.getTextInputValue('v').trim(); const dur = ms(raw);
          if (!dur || dur <= 0) return s2.reply({ content: '❌ صيغة غير صحيحة.', ephemeral: true });
          selectedDuration = dur; selectedDurationLabel = raw; state = 'SERVER'; await s2.deferUpdate(); await prompt.edit(genContent());
        } catch {}
      } else {
        const val = cid.split('_')[2]; selectedDuration = ms(val); selectedDurationLabel = val; state = 'SERVER'; return i.update(genContent());
      }
    } else if (state === 'SERVER') {
      if (cid === `sa_srv_${mid}`) {
        const m2 = new ModalBuilder().setCustomId(`sa_ms_${mid}`).setTitle('ايدي السيرفر');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel('ايدي السيرفر').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(20)));
        await i.showModal(m2);
        try {
          const s2 = await i.awaitModalSubmit({ filter: mi => mi.customId === `sa_ms_${mid}`, time: 60000 });
          const val = s2.fields.getTextInputValue('v').trim();
          if (!/^\d{17,20}$/.test(val)) return s2.reply({ content: '❌ ايدي غير صحيح.', ephemeral: true });
          serverId = val; await s2.deferUpdate(); coll.stop('FINISH');
        } catch {}
      }
    }
  });

  coll.on('end', async (_, reason) => {
    if (reason !== 'FINISH') return;
    const bots = getBots();
    if (bots.length < selectedCount) return prompt.edit({ embeds: [new EmbedBuilder().setDescription('> ❌ لا توجد بوتات كافية.').setColor(getEmbedColor(client))], components: [] });

    const code = `#${generateCode(5)}`;
    const expirationTime = Date.now() + selectedDuration;
    const timeArray = store.get('time') || [];
    timeArray.push({ user: userId, server: serverId, botsCount: selectedCount, subscriptionTime: selectedDurationLabel, expirationTime, code });
    store.set('time', timeArray);
    const givenTokens = bots.splice(0, selectedCount);
    const tokens = store.get('tokens') || [];
    givenTokens.forEach(t => tokens.push({ token: t.token, Server: serverId, channel: null, chat: null, status: null, client: userId, code }));
    store.set('tokens', tokens); store.set('bots', bots);

    fetchedUser.send({ content: '```الشراء ناجح. اشتراكك مفعل الآن.```', embeds: [new EmbedBuilder().setTitle('🎵 تم تفعيل اشتراكك!').addFields(
      { name: '🤖 البوتات', value: `\`${selectedCount}\` بوت`, inline: true },
      { name: '⏳ المدة', value: `\`${formatDuration(selectedDuration)}\``, inline: true },
      { name: '🔖 رقم الاشتراك', value: `\`SuID ${code}\``, inline: true }
    ).setColor(getEmbedColor(client))] }).catch(() => {});

    const logCh = client.channels.cache.get(logChannelId);
    if (logCh) logCh.send({ embeds: [new EmbedBuilder().setTitle('إضافة اشتراك! ✅').addFields(
      { name: '👤 المستخدم', value: `<@${userId}>`, inline: true }, { name: '🖥️ السيرفر', value: `\`${serverId}\``, inline: true },
      { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true }, { name: '⏳ المدة', value: `\`${formatDuration(selectedDuration)}\``, inline: true },
      { name: '🔖 SuID', value: `\`${code}\``, inline: true }, { name: '🛠️ بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ).setColor(getEmbedColor(client)).setTimestamp()] });

    await prompt.edit({ embeds: [new EmbedBuilder().setTitle('✅ تمت إضافة الاشتراك!').addFields(
      { name: '👤 المستخدم', value: `<@${userId}>`, inline: true }, { name: '🖥️ السيرفر', value: `\`${serverId}\``, inline: true },
      { name: '🤖 البوتات', value: `\`${selectedCount}\``, inline: true }, { name: '⏳ المدة', value: `\`${formatDuration(selectedDuration)}\``, inline: true },
      { name: '🔖 SuID', value: `\`${code}\``, inline: true }
    ).setColor(getEmbedColor(client)).setTimestamp()], components: [] });
  });
}

// ─── Flow: Remove Subscription ────────────────────────────────────────────────
async function handleRemoveSub(interaction, client) {
  const timeData = store.get('time') || [];
  if (timeData.length === 0) return interaction.reply({ content: '> **لا توجد اشتراكات نشطة.**', ephemeral: true });

  const mid = interaction.id;
  const select = new StringSelectMenuBuilder().setCustomId(`sr_sel_${mid}`).setPlaceholder('اختر الاشتراك المراد حذفه')
    .addOptions(timeData.slice(0, 25).map(e => ({ label: `SuID: ${e.code}`, description: `User: ${e.user} | Bots: ${e.botsCount}`, value: e.code })));

  await interaction.reply({ content: 'اختر الاشتراك:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  const prompt = await interaction.fetchReply();

  const coll = prompt.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 60000 });
  coll.on('collect', async i => {
    if (i.customId !== `sr_sel_${mid}`) return;
    const code = i.values[0];
    const entry = timeData.find(e => e.code === code);
    coll.stop();

    const confirmEmbed = new EmbedBuilder().setTitle('⚠️ تأكيد الحذف')
      .setDescription('هل أنت متأكد من حذف هذا الاشتراك؟')
      .addFields(
        { name: '🔖 SuID', value: `\`${entry.code}\``, inline: true },
        { name: '👤 المستخدم', value: `<@${entry.user}>`, inline: true },
        { name: '🤖 البوتات', value: `\`${entry.botsCount}\``, inline: true },
        { name: '🖥️ السيرفر', value: `\`${entry.server}\``, inline: true }
      ).setColor(getEmbedColor(client));

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sr_confirm_${code}_${mid}`).setLabel('تأكيد الحذف').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`sr_cancel_${mid}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
    );
    await i.update({ embeds: [confirmEmbed], components: [row], content: null });

    const coll2 = prompt.createMessageComponentCollector({ filter: j => j.user.id === interaction.user.id, time: 60000 });
    coll2.on('collect', async j => {
      if (j.customId === `sr_cancel_${mid}`) { await j.update({ content: '❌ تم الإلغاء.', embeds: [], components: [] }); return coll2.stop(); }
      if (j.customId === `sr_confirm_${code}_${mid}`) {
        await j.deferUpdate(); coll2.stop();
        await executeRemoval(code, interaction, client, prompt);
      }
    });
  });
}

async function executeRemoval(code, interaction, client, prompt) {
  try {
    let timeArray = store.get('time') || [];
    const idx = timeArray.findIndex(e => e.code === code);
    if (idx === -1) return prompt.edit({ content: '❌ لم يتم العثور على الاشتراك.', embeds: [], components: [] });
    const sub = timeArray[idx];
    timeArray.splice(idx, 1); store.set('time', timeArray);

    let tokensArray = store.get('tokens') || [];
    const toRemove = tokensArray.filter(t => t.code === code);
    store.set('tokens', tokensArray.filter(t => t.code !== code));
    const bots = store.get('bots') || [];
    toRemove.forEach(t => bots.push({ token: t.token }));
    store.set('bots', bots);

    await prompt.edit({ content: `✅ تم حذف الاشتراك \`${code}\` بنجاح. سيتم تنظيف البوتات.`, embeds: [], components: [] });

    client.users.fetch(sub.user).then(u => u.send({ embeds: [new EmbedBuilder().setTitle('⚠️ تم إنهاء اشتراكك').setDescription(`تم إزالة اشتراكك برقم \`${code}\`.`).setColor(getEmbedColor(client)).setTimestamp()] }).catch(() => {})).catch(() => {});

    const logCh = client.channels.cache.get(logChannelId);
    if (logCh) logCh.send({ embeds: [new EmbedBuilder().setTitle('إزالة اشتراك 🔴').addFields(
      { name: '👤 المستخدم', value: `<@${sub.user}>`, inline: true }, { name: '🔖 SuID', value: `\`${code}\``, inline: true },
      { name: '🤖 البوتات', value: `\`${toRemove.length}\``, inline: true }, { name: '🛠️ بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ).setColor(getEmbedColor(client)).setTimestamp()] });

    for (const t of toRemove) {
      try {
        const bc = new Client({ intents: [GatewayIntentBits.Guilds] });
        await bc.login(t.token);
        for (const [, g] of bc.guilds.cache) { await g.leave().catch(() => {}); }
        const profile = getSubBotProfile();
        if (profile.avatar) await bc.user.setAvatar(profile.avatar).catch(() => {});
        await bc.user.setUsername(`${profile.prefix}-${Math.floor(Math.random() * 9000) + 1000}`).catch(() => {});
        await bc.destroy();
      } catch (e) { console.error(`[Subs] cleanup bot error:`, e.message); }
    }
  } catch (e) { console.error('[Subs] removal error:', e); }
}

// ─── Flow: Add Time ───────────────────────────────────────────────────────────
async function handleAddTime(interaction, client) {
  const timeData = store.get('time') || [];
  if (timeData.length === 0) return interaction.reply({ content: '> **لا توجد اشتراكات.**', ephemeral: true });

  const mid = interaction.id;
  const select = new StringSelectMenuBuilder().setCustomId(`at_sel_${mid}`).setPlaceholder('اختر الاشتراك')
    .addOptions(timeData.slice(0, 25).map(e => ({ label: `${e.code}`, description: `User: ${e.user} | Expires: ${new Date(e.expirationTime).toLocaleDateString()}`, value: e.code })));

  await interaction.reply({ content: 'اختر الاشتراك:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  const prompt = await interaction.fetchReply();

  const coll = prompt.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 60000 });
  coll.on('collect', async i => {
    if (i.customId !== `at_sel_${mid}`) return;
    const code = i.values[0];
    const entry = (store.get('time') || []).find(e => e.code === code);
    coll.stop();

    const embed = new EmbedBuilder().setTitle('⏳ إضافة وقت للاشتراك')
      .setDescription(`اختر الوقت المراد إضافته للاشتراك \`${code}\``)
      .addFields(
        { name: '👤 المستخدم', value: `<@${entry.user}>`, inline: true },
        { name: '📅 ينتهي', value: `<t:${Math.floor(entry.expirationTime / 1000)}:R>`, inline: true }
      ).setColor(getEmbedColor(client));

    const r1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`at_1d_${code}_${mid}`).setLabel('+1d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`at_7d_${code}_${mid}`).setLabel('+7d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`at_30d_${code}_${mid}`).setLabel('+30d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`at_90d_${code}_${mid}`).setLabel('+90d').setStyle(ButtonStyle.Secondary),
    );
    const r2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`at_custom_${code}_${mid}`).setLabel('مخصص ✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`at_cancel_${mid}`).setLabel('إلغاء').setStyle(ButtonStyle.Danger)
    );
    await i.update({ embeds: [embed], components: [r1, r2], content: null });

    const coll2 = prompt.createMessageComponentCollector({ filter: j => j.user.id === interaction.user.id, time: 60000 });
    coll2.on('collect', async j => {
      if (j.customId === `at_cancel_${mid}`) { await j.update({ content: '❌ تم الإلغاء.', embeds: [], components: [] }); return coll2.stop(); }
      if (!j.customId.startsWith('at_')) return;

      let durStr = j.customId.split('_')[1];
      if (durStr === 'custom') {
        const m2 = new ModalBuilder().setCustomId(`at_modal_${mid}`).setTitle('إضافة وقت مخصص');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel('الوقت (مثال: 1d, 12h)').setStyle(TextInputStyle.Short).setRequired(true)));
        await j.showModal(m2);
        try {
          const s2 = await j.awaitModalSubmit({ filter: mi => mi.customId === `at_modal_${mid}`, time: 60000 });
          durStr = s2.fields.getTextInputValue('v').trim();
          const dur = ms(durStr);
          if (!dur || dur <= 0) return s2.reply({ content: '❌ وقت غير صحيح.', ephemeral: true });
          await s2.deferUpdate(); coll2.stop();
          await executeAddTime(code, dur, durStr, interaction, client, prompt);
        } catch {}
      } else {
        const dur = ms(durStr);
        await j.deferUpdate(); coll2.stop();
        await executeAddTime(code, dur, durStr, interaction, client, prompt);
      }
    });
  });
}

async function executeAddTime(code, durationMs, durationStr, interaction, client, prompt) {
  try {
    const timeArray = store.get('time') || [];
    const entry = timeArray.find(e => e.code === code);
    if (!entry) return;
    const oldExpiry = entry.expirationTime;
    entry.expirationTime += durationMs;
    store.set('time', timeArray);

    await prompt.edit({ embeds: [new EmbedBuilder().setTitle('✅ تم إضافة الوقت').addFields(
      { name: '🔖 SuID', value: `\`${code}\``, inline: true },
      { name: '➕ الوقت المضاف', value: `\`${durationStr}\``, inline: true },
      { name: '📅 الانتهاء الجديد', value: `<t:${Math.floor(entry.expirationTime / 1000)}:F>` }
    ).setColor(getEmbedColor(client))], components: [] });

    const logCh = client.channels.cache.get(logChannelId);
    if (logCh) logCh.send({ embeds: [new EmbedBuilder().setTitle('تحديث وقت الاشتراك ⏳').addFields(
      { name: '👤 المستخدم', value: `<@${entry.user}>`, inline: true }, { name: '🔖 SuID', value: `\`${code}\``, inline: true },
      { name: '➕ الوقت المضاف', value: `\`${durationStr}\``, inline: true },
      { name: '📅 الانتهاء السابق', value: `<t:${Math.floor(oldExpiry / 1000)}:R>`, inline: true },
      { name: '📅 الانتهاء الجديد', value: `<t:${Math.floor(entry.expirationTime / 1000)}:R>`, inline: true },
      { name: '🛠️ بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ).setColor(getEmbedColor(client))] });
  } catch (e) { console.error('[Subs] addTime error:', e); }
}

// ─── Flow: Add Tokens ─────────────────────────────────────────────────────────
async function handleAddTokens(interaction, client) {
  const modal = new ModalBuilder().setCustomId('subs_tokens_modal').setTitle('إضافة بوتات');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('tokens').setLabel('التوكنات (كل توكن في سطر)').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('token1\ntoken2\ntoken3')
  ));
  await interaction.showModal(modal);

  let sub;
  try { sub = await interaction.awaitModalSubmit({ filter: mi => mi.customId === 'subs_tokens_modal' && mi.user.id === interaction.user.id, time: 120000 }); }
  catch { return; }

  const rawTokens = sub.fields.getTextInputValue('tokens').trim().split('\n').map(t => t.trim()).filter(Boolean);
  if (rawTokens.length === 0) return sub.reply({ content: '❌ لم يتم إدخال أي توكن.', ephemeral: true });

  await sub.reply({ content: `⏳ جاري التحقق من **${rawTokens.length}** توكن...`, ephemeral: true });

  const botIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  const validTokens = [];
  const clientCheck = new Client({ intents: botIntents });

  for (const token of rawTokens) {
    try {
      await clientCheck.login(token);
      validTokens.push(token);
    } catch {
      await sub.followUp({ content: `\`❌ توكن غير صالح: ${token.slice(0, 20)}...\``, ephemeral: true }).catch(() => {});
    }
  }
  try { await clientCheck.destroy(); } catch {}

  if (validTokens.length === 0) return sub.followUp({ content: '❌ لا توجد توكنات صالحة.', ephemeral: true }).catch(() => {});

  let bots = [...(store.get('bots') || [])];
  for (const token of validTokens) {
    if (!bots.some(b => b.token === token)) bots.push({ token });
  }
  store.set('bots', bots);

  const secs = validTokens.length * 5;
  const timeStr = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
  await sub.followUp({ content: `✅ تم إضافة **${validTokens.length}** بوت. سيستغرق تغيير الاسم والصورة (~${timeStr}) دقيقة.`, ephemeral: true }).catch(() => {});

  setTimeout(async () => {
    const profile = getSubBotProfile();
    for (const token of validTokens) {
      try {
        const bc = new Client({ intents: botIntents });
        await bc.login(token);
        for (const [, g] of bc.guilds.cache) { await g.leave().catch(() => {}); }
        const num = Math.floor(1000 + Math.random() * 9000);
        await bc.user.setUsername(`${profile.prefix}-${num}`).catch(() => {});
        if (profile.avatar) await bc.user.setAvatar(profile.avatar).catch(() => {});
        if (profile.banner) {
          try {
            const resp = await axios.get(profile.banner, { responseType: 'arraybuffer' });
            const b64 = Buffer.from(resp.data).toString('base64');
            await axios.patch('https://discord.com/api/v9/users/@me', { banner: `data:image/png;base64,${b64}` }, { headers: { Authorization: `Bot ${token}` } });
          } catch {}
        }
        await bc.destroy();
      } catch (e) { console.error('[Subs] token setup error:', e.message); }
    }
  }, 5000);
}

// ─── Flow: All Subscriptions ──────────────────────────────────────────────────
async function handleAllSubs(interaction, client) {
  const timeData = store.get('time') || [];
  if (timeData.length === 0) return interaction.reply({ content: '> **لا توجد اشتراكات نشطة.**', ephemeral: true });

  const pages = [];
  const perPage = 5;
  for (let i = 0; i < timeData.length; i += perPage) {
    pages.push(timeData.slice(i, i + perPage));
  }
  let page = 0;

  const buildEmbed = () => {
    const embed = new EmbedBuilder().setTitle(`📊 الاشتراكات النشطة (${timeData.length})`).setColor(getEmbedColor(client)).setFooter({ text: `صفحة ${page + 1} / ${pages.length}` });
    for (const e of pages[page]) {
      embed.addFields({ name: `🔖 ${e.code}`, value: `👤 <@${e.user}> | 🤖 \`${e.botsCount}\` | 📅 <t:${Math.floor(e.expirationTime / 1000)}:R>`, inline: false });
    }
    return embed;
  };

  const buildNav = () => {
    if (pages.length === 1) return [];
    const mid = interaction.id;
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`as_prev_${mid}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`as_next_${mid}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1)
    )];
  };

  await interaction.reply({ embeds: [buildEmbed()], components: buildNav(), ephemeral: true });
  if (pages.length <= 1) return;

  const prompt = await interaction.fetchReply();
  const coll = prompt.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 60000 });
  coll.on('collect', async i => {
    if (i.customId.startsWith('as_prev_')) page--;
    else if (i.customId.startsWith('as_next_')) page++;
    await i.update({ embeds: [buildEmbed()], components: buildNav() });
  });
}

// ─── Flow: Stock ──────────────────────────────────────────────────────────────
async function handleStock(interaction, client) {
  const bots = store.get('bots') || [];
  const tokens = store.get('tokens') || [];
  const embed = new EmbedBuilder()
    .setTitle('📦 الستوك الحالي')
    .addFields(
      { name: '✅ بوتات متاحة', value: `\`${bots.length}\` بوت`, inline: true },
      { name: '🔗 بوتات مستخدمة', value: `\`${tokens.length}\` بوت`, inline: true },
      { name: '📊 الإجمالي', value: `\`${bots.length + tokens.length}\` بوت`, inline: true }
    )
    .setColor(getEmbedColor(client))
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── Register Global Interaction Handler ─────────────────────────────────────
function installSubsPanelHandler(client) {
  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    if (!Object.values(BTN).includes(interaction.customId)) return;
    if (!owners.includes(interaction.user.id)) {
      return interaction.reply({ content: '> ❌ هذا الزر للأونرات فقط.', ephemeral: true });
    }
    try {
      switch (interaction.customId) {
        case BTN.ADD_SUB:     return await handleAddSub(interaction, client);
        case BTN.REMOVE_SUB:  return await handleRemoveSub(interaction, client);
        case BTN.ADD_TIME:    return await handleAddTime(interaction, client);
        case BTN.ADD_TOKENS:  return await handleAddTokens(interaction, client);
        case BTN.ALL_SUBS:    return await handleAllSubs(interaction, client);
        case BTN.STOCK:       return await handleStock(interaction, client);
      }
    } catch (e) {
      console.error('[Subs Panel] interaction error:', e);
      const reply = { content: '❌ حدث خطأ، حاول مرة أخرى.', ephemeral: true };
      interaction.replied || interaction.deferred ? interaction.followUp(reply).catch(() => {}) : interaction.reply(reply).catch(() => {});
    }
  });
}

// ─── Command Export ───────────────────────────────────────────────────────────
module.exports = {
  name: 'subs',
  aliases: ['subscribe'],
  installSubsPanelHandler,
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (message.author.bot) return;

    const channel = message.mentions.channels.first();
    if (!channel) {
      return message.reply({ embeds: [new EmbedBuilder().setDescription('> يرجى منشن الروم.\n> مثال: `!subs #channel`').setColor(getEmbedColor(client))] });
    }

    const attachment = message.attachments.first();
    if (!attachment) {
      return message.reply({ embeds: [new EmbedBuilder().setDescription('> يرجى إرفاق صورة مع الأمر.').setColor(getEmbedColor(client))] });
    }

    const embed = new EmbedBuilder()
      .setImage(attachment.url)
      .setColor(getEmbedColor(client));

    try {
      await channel.send({ embeds: [embed], components: buildPanelRows() });
      await message.reply({ embeds: [new EmbedBuilder().setDescription(`> ✅ تم إرسال لوحة الاشتراكات إلى <#${channel.id}>.`).setColor(getEmbedColor(client))] });
    } catch (e) {
      message.reply({ embeds: [new EmbedBuilder().setDescription(`> ❌ فشل الإرسال: \`${e.message}\``).setColor(getEmbedColor(client))] });
    }
  }
};
