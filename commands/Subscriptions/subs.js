const { owners, logChannelId } = require('../../config');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, MessageFlags
} = require('discord.js');
const ms = require('ms');
const store = require('../../utils/store');
const { getEmbedColor } = require('../../utils/embedColor');
const {
  applyProfileToToken,
  getSubBotProfile,
  resolveProfileAssets,
} = require('../../utils/subBotProfile');
const {
  buildSubscriptionActivatedDm,
  buildSubscriptionRemovedDm,
  buildSubscriptionTimeUpdatedDm,
} = require('../../utils/subscriptionDm');

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

function botThumbnail(client) {
  return client.user?.displayAvatarURL({ dynamic: true, size: 256 }) || null;
}

function basePanelEmbed(client, title, description = null) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(getEmbedColor(client))
    .setTimestamp();
  const thumb = botThumbnail(client);
  if (thumb) embed.setThumbnail(thumb);
  if (description) embed.setDescription(description);
  return embed;
}

function statusText(en, ar) {
  return `**${en}**\n${ar}`;
}

        function buildPanelRows() {
          return [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(BTN.ADD_SUB).setLabel('Add Sub | إضافة').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(BTN.REMOVE_SUB).setLabel('Remove Sub | حذف').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId(BTN.ADD_TIME).setLabel('Add Time | وقت').setStyle(ButtonStyle.Primary),
            ),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(BTN.ADD_TOKENS).setLabel('Add Bots | بوتات').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(BTN.ALL_SUBS).setLabel('List | القائمة').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(BTN.STOCK).setLabel('Stock | الستوك').setStyle(ButtonStyle.Secondary),
            ),
          ];
        }

// ─── Flow: Add Subscription ───────────────────────────────────────────────────
async function handleAddSub(interaction, client) {
          const modal = new ModalBuilder().setCustomId('subs_add_uid').setTitle('Add Subscription | اشتراك');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('uid').setLabel('User ID | ايدي المستخدم').setPlaceholder('Example: 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(20)
  ));
  await interaction.showModal(modal);

  let sub;
  try { sub = await interaction.awaitModalSubmit({ filter: mi => mi.customId === 'subs_add_uid' && mi.user.id === interaction.user.id, time: 120000 }); }
  catch { return; }

  const userId = sub.fields.getTextInputValue('uid').trim();
  if (!/^\d{17,20}$/.test(userId)) return sub.reply({ content: statusText('Invalid user ID.', 'ايدي المستخدم غير صحيح.'), flags: MessageFlags.Ephemeral });

  let fetchedUser;
  try { fetchedUser = await client.users.fetch(userId); }
  catch { return sub.reply({ content: statusText('User was not found.', 'لم يتم العثور على المستخدم.'), flags: MessageFlags.Ephemeral }); }

  const mid = interaction.id;
  let state = 'COUNT', selectedCount = null, selectedDuration = null, selectedDurationLabel = null, serverId = null;
  const getBots = () => store.get('bots') || [];

  const baseEmbed = () => new EmbedBuilder()
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
    .setThumbnail(fetchedUser.displayAvatarURL({ dynamic: true, size: 512 }))
            .addFields({ name: 'User | المستخدم', value: `<@${userId}>`, inline: true })
            .setColor(getEmbedColor(client));

  const genContent = () => {
    const bots = getBots();
    const max = Math.min(bots.length, 5);
    const embeds = [], components = [];
    if (state === 'COUNT') {
              embeds.push(baseEmbed().setTitle('Add Subscription | إضافة اشتراك').setDescription(`Choose the bot count.\nاختر عدد البوتات.`).addFields({ name: 'Available Bots | البوتات المتاحة', value: `\`${bots.length}\``, inline: true }));
      const r1 = new ActionRowBuilder();
      for (let i = 1; i <= max; i++) r1.addComponents(new ButtonBuilder().setCustomId(`sa_c_${i}_${mid}`).setLabel(`${i}`).setStyle(ButtonStyle.Secondary));
      const r2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`sa_c_x_${mid}`).setLabel('Custom | مخصص').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`sa_cancel_${mid}`).setLabel('Cancel | إلغاء').setStyle(ButtonStyle.Danger)
              );
      if (r1.components.length) components.push(r1);
      components.push(r2);
    } else if (state === 'TIME') {
              embeds.push(baseEmbed().setTitle('Subscription Duration | مدة الاشتراك').addFields({ name: 'Bot Count | عدد البوتات', value: `\`${selectedCount}\``, inline: true }));
              components.push(
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId(`sa_t_1d_${mid}`).setLabel('1 Day | يوم').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId(`sa_t_7d_${mid}`).setLabel('7 Days | أسبوع').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId(`sa_t_30d_${mid}`).setLabel('30 Days | شهر').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId(`sa_t_90d_${mid}`).setLabel('90 Days | 3 أشهر').setStyle(ButtonStyle.Secondary),
                ),
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId(`sa_t_x_${mid}`).setLabel('Custom | مخصص').setStyle(ButtonStyle.Primary),
                  new ButtonBuilder().setCustomId(`sa_back_COUNT_${mid}`).setLabel('Back | رجوع').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId(`sa_cancel_${mid}`).setLabel('Cancel | إلغاء').setStyle(ButtonStyle.Danger)
                )
              );
            } else if (state === 'SERVER') {
              embeds.push(baseEmbed().setTitle('Subscription Server | سيرفر الاشتراك').addFields(
                { name: 'Bot Count | عدد البوتات', value: `\`${selectedCount}\``, inline: true },
                { name: 'Duration | المدة', value: `\`${formatDuration(selectedDuration)}\``, inline: true }
              ));
              components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`sa_srv_${mid}`).setLabel('Set Server | السيرفر').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`sa_back_TIME_${mid}`).setLabel('Back | رجوع').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`sa_cancel_${mid}`).setLabel('Cancel | إلغاء').setStyle(ButtonStyle.Danger)
              ));
    }
    return { embeds, components };
  };

  const prompt = await sub.reply({ ...genContent(), flags: MessageFlags.Ephemeral, fetchReply: true });
  const coll = prompt.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 300000 });

  coll.on('collect', async i => {
    const cid = i.customId;
            if (cid === `sa_cancel_${mid}`) { await i.update({ embeds: [basePanelEmbed(client, 'Cancelled | تم الإلغاء')], components: [] }); return coll.stop(); }
    if (cid.startsWith(`sa_back_`)) { state = cid.split('_')[2]; return i.update(genContent()); }

    if (state === 'COUNT') {
      if (cid === `sa_c_x_${mid}`) {
                const m2 = new ModalBuilder().setCustomId(`sa_mc_${mid}`).setTitle('Bot Count | عدد البوتات');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel(`Count | العدد (${getBots().length})`).setStyle(TextInputStyle.Short).setRequired(true)));
        await i.showModal(m2);
        try {
          const s2 = await i.awaitModalSubmit({ filter: mi => mi.customId === `sa_mc_${mid}`, time: 60000 });
          const v = parseInt(s2.fields.getTextInputValue('v').trim(), 10);
          if (isNaN(v) || v <= 0 || v > getBots().length) return s2.reply({ content: statusText('Invalid bot count.', 'عدد البوتات غير صحيح.'), flags: MessageFlags.Ephemeral });
          selectedCount = v; state = 'TIME'; await s2.update(genContent());
        } catch {}
      } else {
        selectedCount = parseInt(cid.split('_')[2], 10); state = 'TIME'; return i.update(genContent());
      }
    } else if (state === 'TIME') {
      if (cid === `sa_t_x_${mid}`) {
                const m2 = new ModalBuilder().setCustomId(`sa_mt_${mid}`).setTitle('Duration | المدة');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel('Duration | المدة').setPlaceholder('Example: 30d, 1h').setStyle(TextInputStyle.Short).setRequired(true)));
        await i.showModal(m2);
        try {
          const s2 = await i.awaitModalSubmit({ filter: mi => mi.customId === `sa_mt_${mid}`, time: 60000 });
          const raw = s2.fields.getTextInputValue('v').trim(); const dur = ms(raw);
          if (!dur || dur <= 0) return s2.reply({ content: statusText('Invalid duration format.', 'صيغة المدة غير صحيحة.'), flags: MessageFlags.Ephemeral });
          selectedDuration = dur; selectedDurationLabel = raw; state = 'SERVER'; await s2.update(genContent());
        } catch {}
      } else {
        const val = cid.split('_')[2]; selectedDuration = ms(val); selectedDurationLabel = val; state = 'SERVER'; return i.update(genContent());
      }
    } else if (state === 'SERVER') {
      if (cid === `sa_srv_${mid}`) {
                const m2 = new ModalBuilder().setCustomId(`sa_ms_${mid}`).setTitle('Server ID | ايدي السيرفر');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel('Server ID | ايدي السيرفر').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(20)));
        await i.showModal(m2);
        try {
          const s2 = await i.awaitModalSubmit({ filter: mi => mi.customId === `sa_ms_${mid}`, time: 60000 });
          const val = s2.fields.getTextInputValue('v').trim();
          if (!/^\d{17,20}$/.test(val)) return s2.reply({ content: statusText('Invalid server ID.', 'ايدي السيرفر غير صحيح.'), flags: MessageFlags.Ephemeral });
          serverId = val; await s2.update({ content: null, embeds: [baseEmbed().setTitle('Processing... | جاري المعالجة')], components: [] }); coll.stop('FINISH');
        } catch {}
      }
    }
  });

  coll.on('end', async (_, reason) => {
    if (reason !== 'FINISH') return;
    const bots = getBots();
            if (bots.length < selectedCount) return prompt.edit({ embeds: [basePanelEmbed(client, 'Not Enough Bots | لا توجد بوتات كافية')], components: [] });

    const code = `#${generateCode(5)}`;
    const expirationTime = Date.now() + selectedDuration;
    const timeArray = store.get('time') || [];
    timeArray.push({ user: userId, server: serverId, botsCount: selectedCount, subscriptionTime: selectedDurationLabel, expirationTime, code });
    store.set('time', timeArray);
    const givenTokens = bots.splice(0, selectedCount);
    const tokens = store.get('tokens') || [];
    const defaultStatus = getSubBotProfile().status || null;
    givenTokens.forEach(t => tokens.push({ token: t.token, Server: serverId, channel: null, chat: null, status: defaultStatus, client: userId, code }));
    store.set('tokens', tokens); store.set('bots', bots);

    fetchedUser.send({ embeds: [buildSubscriptionActivatedDm(client, {
      code,
      botCount: selectedCount,
      duration: formatDuration(selectedDuration),
      serverId,
      expiresAt: expirationTime,
    })] }).catch(() => {});

    const logCh = client.channels.cache.get(logChannelId);
            if (logCh) logCh.send({ embeds: [basePanelEmbed(client, 'Subscription Added | تمت إضافة اشتراك').addFields(
              { name: 'User | المستخدم', value: `<@${userId}>`, inline: true },
              { name: 'Server | السيرفر', value: `\`${serverId}\``, inline: true },
              { name: 'Bot Count | عدد البوتات', value: `\`${selectedCount}\``, inline: true },
              { name: 'Duration | المدة', value: `\`${formatDuration(selectedDuration)}\``, inline: true },
              { name: 'Subscription ID | رقم الاشتراك', value: `\`${code}\``, inline: true },
              { name: 'By | بواسطة', value: `<@${interaction.user.id}>`, inline: true }
            )] });
        
            await sub.editReply({ embeds: [basePanelEmbed(client, 'Subscription Added | تمت إضافة الاشتراك').addFields(
              { name: 'User | المستخدم', value: `<@${userId}>`, inline: true },
              { name: 'Server | السيرفر', value: `\`${serverId}\``, inline: true },
              { name: 'Bot Count | عدد البوتات', value: `\`${selectedCount}\``, inline: true },
              { name: 'Duration | المدة', value: `\`${formatDuration(selectedDuration)}\``, inline: true },
              { name: 'Subscription ID | رقم الاشتراك', value: `\`${code}\``, inline: true }
            )], components: [], content: null });
  });
}

// ─── Flow: Remove Subscription ────────────────────────────────────────────────
async function handleRemoveSub(interaction, client) {
  const timeData = store.get('time') || [];
  if (timeData.length === 0) return interaction.reply({ content: statusText('No active subscriptions.', 'لا توجد اشتراكات نشطة.'), flags: MessageFlags.Ephemeral });

  const mid = interaction.id;
  const select = new StringSelectMenuBuilder().setCustomId(`sr_sel_${mid}`).setPlaceholder('Select subscription | اختر الاشتراك')
    .addOptions(timeData.slice(0, 25).map(e => ({ label: `SuID: ${e.code}`, description: `User: ${e.user} | Bots: ${e.botsCount}`, value: e.code })));

  await interaction.reply({ content: statusText('Select the subscription to remove.', 'اختر الاشتراك المراد حذفه.'), components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
  const prompt = await interaction.fetchReply();

  const coll = prompt.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 60000 });
  coll.on('collect', async i => {
    if (i.customId !== `sr_sel_${mid}`) return;
    const code = i.values[0];
    const entry = timeData.find(e => e.code === code);
    coll.stop();

    const confirmEmbed = basePanelEmbed(client, 'Confirm Removal | تأكيد الحذف', 'Are you sure you want to remove this subscription?\nهل أنت متأكد من حذف هذا الاشتراك؟')
      .addFields(
        { name: 'Subscription ID | رقم الاشتراك', value: `\`${entry.code}\``, inline: true },
        { name: 'User | المستخدم', value: `<@${entry.user}>`, inline: true },
        { name: 'Bot Count | عدد البوتات', value: `\`${entry.botsCount}\``, inline: true },
        { name: 'Server | السيرفر', value: `\`${entry.server}\``, inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sr_confirm_${code}_${mid}`).setLabel('Confirm | تأكيد').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`sr_cancel_${mid}`).setLabel('Cancel | إلغاء').setStyle(ButtonStyle.Secondary)
    );
    await i.update({ embeds: [confirmEmbed], components: [row], content: null });

    const coll2 = prompt.createMessageComponentCollector({ filter: j => j.user.id === interaction.user.id, time: 60000 });
    coll2.on('collect', async j => {
      if (j.customId === `sr_cancel_${mid}`) { await j.update({ content: statusText('Cancelled.', 'تم الإلغاء.'), embeds: [], components: [] }); return coll2.stop(); }
      if (j.customId === `sr_confirm_${code}_${mid}`) {
        await j.update({ content: null, embeds: [basePanelEmbed(client, 'Removing... | جاري الحذف')], components: [] }); coll2.stop();
        await executeRemoval(code, j, client);
      }
    });
  });
}

async function executeRemoval(code, interaction, client) {
  try {
    let timeArray = store.get('time') || [];
    const idx = timeArray.findIndex(e => e.code === code);
    if (idx === -1) return interaction.editReply({ content: statusText('Subscription was not found.', 'لم يتم العثور على الاشتراك.'), embeds: [], components: [] });
    const sub = timeArray[idx];
    timeArray.splice(idx, 1); store.set('time', timeArray);

    let tokensArray = store.get('tokens') || [];
    const toRemove = tokensArray.filter(t => t.code === code);
    store.set('tokens', tokensArray.filter(t => t.code !== code));
    const bots = store.get('bots') || [];
    toRemove.forEach(t => bots.push({ token: t.token }));
    store.set('bots', bots);

    await interaction.editReply({ content: `**Subscription Removed**\nتم حذف الاشتراك \`${code}\` بنجاح. سيتم تنظيف البوتات.`, embeds: [], components: [] });

    client.users.fetch(sub.user)
      .then(u => u.send({ embeds: [buildSubscriptionRemovedDm(client, {
        code,
        botCount: sub.botsCount || toRemove.length,
        serverId: sub.server,
      })] }).catch(() => {}))
      .catch(() => {});

    const logCh = client.channels.cache.get(logChannelId);
    if (logCh) logCh.send({ embeds: [basePanelEmbed(client, 'Subscription Removed | تم حذف اشتراك').addFields(
      { name: 'User | المستخدم', value: `<@${sub.user}>`, inline: true },
      { name: 'Subscription ID | رقم الاشتراك', value: `\`${code}\``, inline: true },
      { name: 'Bot Count | عدد البوتات', value: `\`${toRemove.length}\``, inline: true },
      { name: 'By | بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    )] });

    for (const t of toRemove) {
      try {
        const profile = getSubBotProfile();
        await applyProfileToToken(t.token, { profile, leaveGuilds: true });
      } catch (e) { console.error(`[Subs] cleanup bot error:`, e.message); }
    }
  } catch (e) { console.error('[Subs] removal error:', e); }
}

// ─── Flow: Add Time ───────────────────────────────────────────────────────────
async function handleAddTime(interaction, client) {
  const timeData = store.get('time') || [];
  if (timeData.length === 0) return interaction.reply({ content: statusText('No subscriptions found.', 'لا توجد اشتراكات.'), flags: MessageFlags.Ephemeral });

  const mid = interaction.id;
  const select = new StringSelectMenuBuilder().setCustomId(`at_sel_${mid}`).setPlaceholder('Select subscription | اختر الاشتراك')
    .addOptions(timeData.slice(0, 25).map(e => ({ label: `${e.code}`, description: `User: ${e.user} | Expires: ${new Date(e.expirationTime).toLocaleDateString()}`, value: e.code })));

  await interaction.reply({ content: statusText('Select the subscription to update.', 'اختر الاشتراك المراد تحديثه.'), components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
  const prompt = await interaction.fetchReply();

  const coll = prompt.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 60000 });
  coll.on('collect', async i => {
    if (i.customId !== `at_sel_${mid}`) return;
    const code = i.values[0];
    const entry = (store.get('time') || []).find(e => e.code === code);
    coll.stop();

    const embed = basePanelEmbed(client, 'Add Subscription Time | إضافة وقت للاشتراك', `Choose the time to add to \`${code}\`.\nاختر الوقت المراد إضافته للاشتراك \`${code}\`.`)
      .addFields(
        { name: 'User | المستخدم', value: `<@${entry.user}>`, inline: true },
        { name: 'Expires | ينتهي', value: `<t:${Math.floor(entry.expirationTime / 1000)}:R>`, inline: true }
      );

    const r1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`at_1d_${code}_${mid}`).setLabel('+1d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`at_7d_${code}_${mid}`).setLabel('+7d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`at_30d_${code}_${mid}`).setLabel('+30d').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`at_90d_${code}_${mid}`).setLabel('+90d').setStyle(ButtonStyle.Secondary),
    );
    const r2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`at_custom_${code}_${mid}`).setLabel('Custom | مخصص').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`at_cancel_${mid}`).setLabel('Cancel | إلغاء').setStyle(ButtonStyle.Danger)
    );
    await i.update({ embeds: [embed], components: [r1, r2], content: null });

    const coll2 = prompt.createMessageComponentCollector({ filter: j => j.user.id === interaction.user.id, time: 60000 });
    coll2.on('collect', async j => {
      if (j.customId === `at_cancel_${mid}`) { await j.update({ content: statusText('Cancelled.', 'تم الإلغاء.'), embeds: [], components: [] }); return coll2.stop(); }
      if (!j.customId.startsWith('at_')) return;

      let durStr = j.customId.split('_')[1];
      if (durStr === 'custom') {
        const m2 = new ModalBuilder().setCustomId(`at_modal_${mid}`).setTitle('Custom Time | وقت مخصص');
        m2.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v').setLabel('Time | الوقت').setPlaceholder('Example: 1d, 12h').setStyle(TextInputStyle.Short).setRequired(true)));
        await j.showModal(m2);
        try {
          const s2 = await j.awaitModalSubmit({ filter: mi => mi.customId === `at_modal_${mid}`, time: 60000 });
          durStr = s2.fields.getTextInputValue('v').trim();
          const dur = ms(durStr);
          if (!dur || dur <= 0) return s2.reply({ content: statusText('Invalid time.', 'الوقت غير صحيح.'), flags: MessageFlags.Ephemeral });
          await s2.update({ content: null, embeds: [basePanelEmbed(client, 'Processing... | جاري المعالجة')], components: [] }); coll2.stop();
          await executeAddTime(code, dur, durStr, s2, client);
        } catch {}
      } else {
        const dur = ms(durStr);
        await j.update({ content: null, embeds: [basePanelEmbed(client, 'Processing... | جاري المعالجة')], components: [] }); coll2.stop();
        await executeAddTime(code, dur, durStr, j, client);
      }
    });
  });
}

async function executeAddTime(code, durationMs, durationStr, interaction, client) {
  try {
    const timeArray = store.get('time') || [];
    const entry = timeArray.find(e => e.code === code);
    if (!entry) return;
    const oldExpiry = entry.expirationTime;
    entry.expirationTime += durationMs;
    store.set('time', timeArray);

    await interaction.editReply({ embeds: [basePanelEmbed(client, 'Subscription Time Updated | تم تحديث وقت الاشتراك').addFields(
      { name: 'Subscription ID | رقم الاشتراك', value: `\`${code}\``, inline: true },
      { name: 'Added Time | الوقت المضاف', value: `\`${durationStr}\``, inline: true },
      { name: 'New Expiry | الانتهاء الجديد', value: `<t:${Math.floor(entry.expirationTime / 1000)}:F>` }
    )], components: [], content: null });

    const logCh = client.channels.cache.get(logChannelId);
    if (logCh) logCh.send({ embeds: [basePanelEmbed(client, 'Subscription Time Updated | تم تحديث وقت الاشتراك').addFields(
      { name: 'User | المستخدم', value: `<@${entry.user}>`, inline: true },
      { name: 'Subscription ID | رقم الاشتراك', value: `\`${code}\``, inline: true },
      { name: 'Added Time | الوقت المضاف', value: `\`${durationStr}\``, inline: true },
      { name: 'Previous Expiry | الانتهاء السابق', value: `<t:${Math.floor(oldExpiry / 1000)}:R>`, inline: true },
      { name: 'New Expiry | الانتهاء الجديد', value: `<t:${Math.floor(entry.expirationTime / 1000)}:R>`, inline: true },
      { name: 'By | بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    )] });

    client.users.fetch(entry.user)
      .then(u => u.send({ embeds: [buildSubscriptionTimeUpdatedDm(client, {
        code,
        addedTime: durationStr,
        previousExpiry: oldExpiry,
        newExpiry: entry.expirationTime,
      })] }).catch(() => {}))
      .catch(() => {});
  } catch (e) { console.error('[Subs] addTime error:', e); }
}

// ─── Flow: Add Tokens ─────────────────────────────────────────────────────────
async function handleAddTokens(interaction, client) {
  const modal = new ModalBuilder().setCustomId('subs_tokens_modal').setTitle('Add Bot Tokens | توكنات');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('tokens').setLabel('Tokens | التوكنات').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('One token per line\nكل توكن في سطر')
  ));
  await interaction.showModal(modal);

  let sub;
  try { sub = await interaction.awaitModalSubmit({ filter: mi => mi.customId === 'subs_tokens_modal' && mi.user.id === interaction.user.id, time: 120000 }); }
  catch { return; }

  const rawTokens = sub.fields.getTextInputValue('tokens').trim().split('\n').map(t => t.trim()).filter(Boolean);
  if (rawTokens.length === 0) return sub.reply({ content: statusText('No tokens were provided.', 'لم يتم إدخال أي توكن.'), flags: MessageFlags.Ephemeral });

  await sub.reply({ content: `**Checking Tokens**\nجاري التحقق من **${rawTokens.length}** توكن...`, flags: MessageFlags.Ephemeral });

  try {
    const validTokens = [];
    let duplicateCount = 0;
    const known = new Set([
      ...((store.get('bots') || []).map(b => b.token)),
      ...((store.get('tokens') || []).map(t => t.token)),
    ].filter(Boolean));
    const profile = getSubBotProfile();
    let assets = null;
    try {
      assets = await resolveProfileAssets(profile);
    } catch {
      assets = { avatarData: null, bannerData: null };
    }

    for (const token of rawTokens) {
      try {
        if (known.has(token)) { duplicateCount++; continue; }
        await applyProfileToToken(token, { profile, assets, leaveGuilds: true });
        validTokens.push(token);
        known.add(token);
      } catch {
        await sub.followUp({ content: `**Invalid Token**\nتوكن غير صالح: \`${token.slice(0, 20)}...\``, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    if (duplicateCount > 0 && validTokens.length === 0) {
      return sub.followUp({ content: statusText(`All tokens already exist (${duplicateCount}).`, `جميع التوكنات موجودة مسبقاً (${duplicateCount}).`), flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    if (validTokens.length === 0) return sub.followUp({ content: statusText('No valid tokens found.', 'لا توجد توكنات صالحة.'), flags: MessageFlags.Ephemeral }).catch(() => {});

    let bots = [...(store.get('bots') || [])];
    for (const token of validTokens) {
      if (!bots.some(b => b.token === token)) bots.push({ token });
    }
    store.set('bots', bots);

    const dupNote = duplicateCount > 0 ? ` (${duplicateCount} مكرر تم تجاهله)` : '';
    await sub.followUp({ content: `**Bots Added**\nتم إضافة **${validTokens.length}** بوت وتطبيق الاسم والصورة والبنر على البوت والـ App.${dupNote}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  } catch (e) {
    console.error('[Subs] addTokens error:', e);
    await sub.followUp({ content: statusText('An error occurred while processing tokens.', 'حدث خطأ أثناء معالجة التوكنات.'), flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

// ─── Flow: All Subscriptions ──────────────────────────────────────────────────
async function handleAllSubs(interaction, client) {
  const timeData = store.get('time') || [];
  if (timeData.length === 0) return interaction.reply({ content: statusText('No active subscriptions.', 'لا توجد اشتراكات نشطة.'), flags: MessageFlags.Ephemeral });

  const pages = [];
  const perPage = 5;
  for (let i = 0; i < timeData.length; i += perPage) {
    pages.push(timeData.slice(i, i + perPage));
  }
  let page = 0;

  const buildEmbed = () => {
    const embed = basePanelEmbed(client, `Active Subscriptions | الاشتراكات النشطة (${timeData.length})`).setFooter({ text: `Page ${page + 1} / ${pages.length}` });
    for (const e of pages[page]) {
      embed.addFields({ name: `${e.code}`, value: `User: <@${e.user}> | Bots: \`${e.botsCount}\` | Expires: <t:${Math.floor(e.expirationTime / 1000)}:R>`, inline: false });
    }
    return embed;
  };

  const buildNav = () => {
    if (pages.length === 1) return [];
    const mid = interaction.id;
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`as_prev_${mid}`).setLabel('Previous | السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`as_next_${mid}`).setLabel('Next | التالي').setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1)
    )];
  };

  await interaction.reply({ embeds: [buildEmbed()], components: buildNav(), flags: MessageFlags.Ephemeral });
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
  const embed = basePanelEmbed(client, 'Current Stock | الستوك الحالي')
    .addFields(
      { name: 'Available Bots | بوتات متاحة', value: `\`${bots.length}\``, inline: true },
      { name: 'Used Bots | بوتات مستخدمة', value: `\`${tokens.length}\``, inline: true },
      { name: 'Total | الإجمالي', value: `\`${bots.length + tokens.length}\``, inline: true }
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── Register Global Interaction Handler ─────────────────────────────────────
function installSubsPanelHandler(client) {
  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    if (!Object.values(BTN).includes(interaction.customId)) return;
    if (!owners.includes(interaction.user.id)) {
      return interaction.reply({ content: statusText('This button is for owners only.', 'هذا الزر للأونرات فقط.'), flags: MessageFlags.Ephemeral });
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
      const reply = { content: statusText('An error occurred. Try again.', 'حدث خطأ، حاول مرة أخرى.'), flags: MessageFlags.Ephemeral };
      interaction.replied || interaction.deferred ? interaction.followUp(reply).catch(() => {}) : interaction.reply(reply).catch(() => {});
    }
  });
}

// ─── Command Export ───────────────────────────────────────────────────────────
module.exports = {
  name: 'subs',
  aliases: ['subscribe', 'subscriptions', 'اشتراكات', 'الاشتراكات'],
  installSubsPanelHandler,
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (message.author.bot) return;

    const channel = message.mentions.channels.first();
    if (!channel) {
      return message.reply({ embeds: [basePanelEmbed(client, 'Missing Channel | الروم غير محدد', 'Mention the target channel.\nمنشن الروم المطلوب.\n\nExample | مثال: `!subs #channel`')] });
    }

    const attachment = message.attachments.first();
    if (!attachment) {
      return message.reply({ embeds: [basePanelEmbed(client, 'Missing Image | الصورة غير مرفقة', 'Attach the panel image with the command.\nارفق صورة اللوحة مع الأمر.')] });
    }

    const embed = basePanelEmbed(client, 'Subscriptions Panel | لوحة الاشتراكات', 'Use the buttons below to manage subscriptions.\nاستخدم الأزرار بالأسفل لإدارة الاشتراكات.')
      .setImage(attachment.url)
      .setFooter({ text: `${client.user?.username || 'Music'} | Subscriptions` });

    try {
      await channel.send({ embeds: [embed], components: buildPanelRows() });
      await message.reply({ embeds: [basePanelEmbed(client, 'Panel Sent | تم إرسال اللوحة', `Subscription panel was sent to <#${channel.id}>.\nتم إرسال لوحة الاشتراكات إلى <#${channel.id}>.`)] });
    } catch (e) {
      message.reply({ embeds: [basePanelEmbed(client, 'Send Failed | فشل الإرسال', `Send failed: \`${e.message}\`\nفشل الإرسال: \`${e.message}\``)] });
    }
  }
};
