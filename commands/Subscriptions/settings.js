const fs = require('fs');
const axios = require('axios');
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { owners, Colors } = require('../../settings/config');
const { runningBots } = require('../../music');
const { getDisplay, setDisplay } = require('../../utils/display');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');

module.exports = {
    name: 'settings',
    aliases: ['إعدادات', 'اعدادات'],
    async execute(client, message, args) {
        const userId = message.author.id;
        const isAdmin = owners.includes(userId);
        const mid = message.id;

        if (!check(userId, 'settings')) return;

        // 1. Find user's subscriptions
        let tokens = store.get('tokens') || [];

        // Get unique subscription codes owned by user (or all if admin)
        const mySubs = tokens.filter(t => isAdmin || t.client === userId);
        const uniqueCodes = [...new Set(mySubs.map(t => t.code))];

        if (uniqueCodes.length === 0) {
            return message.reply('❌ لا يوجد لديك اشتراكات نشطة.');
        }

        let selectedCode = uniqueCodes.length === 1 ? uniqueCodes[0] : null;

        const mainMsg = await message.reply({ content: 'جاري التحميل...', components: [] });

        const collector = mainMsg.createMessageComponentCollector({
            filter: i => i.user.id === userId,
            time: 300000
        });

        // Current panel state
        let currentPanel = 'SELECT'; 
        if (selectedCode) currentPanel = 'MAIN';

        async function updatePanel(interaction = null) {
            try {
                let embeds = [];
                let components = [];
                let content = '';

                if (currentPanel === 'SELECT') {
                    content = '📋 اختر الاشتراك الذي تريد التحكم به:';
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`stg_${mid}_select_sub`)
                        .setPlaceholder('اختر اشتراكاً...')
                        .addOptions(uniqueCodes.map(code => ({
                            label: `اشتراك ${code}`,
                            value: code
                        })));
                    components.push(new ActionRowBuilder().addComponents(selectMenu));
                } 
                else if (currentPanel === 'MAIN') {
                    const subTokens = tokens.filter(t => t.code === selectedCode);
                    const timeData = store.get('time') || [];
                    const subInfo = timeData.find(t => t.code === selectedCode);

                    const embed = new EmbedBuilder()
                        .setTitle(`إعدادات الاشتراك — ${selectedCode}`)
                        .addFields(
                            { name: '👤 المالك', value: `<@${subInfo?.user || subTokens[0]?.client}>`, inline: true },
                            { name: '🤖 عدد البوتات', value: `\`${subTokens.length}\``, inline: true },
                            { name: '🖥️ السيرفر', value: `\`${subTokens[0]?.Server || 'غير محدد'}\``, inline: true },
                            { name: '⏳ ينتهي في', value: subInfo?.expirationTime ? `<t:${Math.floor(subInfo.expirationTime / 1000)}:R>` : 'غير معروف', inline: true }
                        )
                        .setColor(Colors);
                    
                    embeds.push(embed);

                    const row1 = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_${mid}_panel_appearance`).setLabel('المظهر').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_panel_rooms`).setLabel('الغرف').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_panel_display`).setLabel('العرض').setEmoji('📋').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_panel_platform`).setLabel('المنصة').setEmoji('🎵').setStyle(ButtonStyle.Secondary)
                    );
                    const row2 = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_${mid}_close`).setLabel('إغلاق').setStyle(ButtonStyle.Danger)
                    );
                    if (uniqueCodes.length > 1) {
                        row2.addComponents(new ButtonBuilder().setCustomId(`stg_${mid}_back_to_select`).setLabel('تغيير الاشتراك').setStyle(ButtonStyle.Secondary));
                    }
                    components.push(row1, row2);
                }
                else if (currentPanel === 'APPEARANCE') {
                    const embed = new EmbedBuilder()
                        .setTitle(`إعدادات المظهر — ${selectedCode}`)
                        .setDescription('تحكم في مظهر جميع بوتات هذا الاشتراك.')
                        .setColor(Colors);
                    embeds.push(embed);

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_${mid}_set_avatar`).setLabel('تغيير الصورة').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_set_banner`).setLabel('تغيير البانر').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_set_status`).setLabel('تغيير الحالة').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
                    );
                    components.push(row);
                }
                else if (currentPanel === 'DISPLAY') {
                    const display = getDisplay(selectedCode);
                    const embed = new EmbedBuilder()
                        .setTitle(`إعدادات العرض — ${selectedCode}`)
                        .setDescription('تحكم في ظهور الأزرار والرسائل (Embeds) لبوتات هذا الاشتراك.')
                        .setColor(Colors);
                    embeds.push(embed);

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`stg_${mid}_toggle_buttons`)
                            .setLabel(`الأزرار: ${display.buttons ? 'ON' : 'OFF'}`)
                            .setStyle(display.buttons ? ButtonStyle.Success : ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`stg_${mid}_toggle_embeds`)
                            .setLabel(`الرسائل: ${display.embeds ? 'ON' : 'OFF'}`)
                            .setStyle(display.embeds ? ButtonStyle.Success : ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
                    );
                    components.push(row);
                }
                else if (currentPanel === 'PLATFORM') {
                    const display = getDisplay(selectedCode);
                    const embed = new EmbedBuilder()
                        .setTitle(`إعدادات المنصة — ${selectedCode}`)
                        .setDescription(`المنصة الحالية: \`${display.platform}\``)
                        .setColor(Colors);
                    embeds.push(embed);

                    const platBtn = (id, lbl) => new ButtonBuilder()
                        .setCustomId(`stg_${mid}_plat_${id}`)
                        .setLabel(lbl)
                        .setStyle(display.platform === id ? ButtonStyle.Primary : ButtonStyle.Secondary);
                    const row1 = new ActionRowBuilder().addComponents(
                        platBtn('ytsearch',  'YouTube'),
                        platBtn('ytmsearch', 'YT Music'),
                        platBtn('scsearch',  'SoundCloud')
                    );
                    const row2 = new ActionRowBuilder().addComponents(
                        platBtn('spsearch',  'Spotify'),
                        platBtn('amsearch',  'Apple Music'),
                        platBtn('dzsearch',  'Deezer'),
                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
                    );
                    components.push(row1, row2);
                }
                else if (currentPanel === 'ROOMS') {
                    const embed = new EmbedBuilder()
                        .setTitle(`إعدادات الغرف — ${selectedCode}`)
                        .setDescription('تحكم في توزيع البوتات وحالتها الصوتية.')
                        .setColor(Colors);
                    embeds.push(embed);

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_${mid}_voice_status`).setLabel('حالة الصوت').setEmoji('📊').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_distribute`).setLabel('توزيع تلقائي').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`stg_${mid}_back_to_main`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
                    );
                    components.push(row);
                }

                const options = { content, embeds, components };
                if (interaction && !interaction.replied && !interaction.deferred) {
                    await interaction.update(options);
                } else {
                    await mainMsg.edit(options);
                }
            } catch (err) {
                console.error(err);
            }
        }

        await updatePanel();

        collector.on('collect', async i => {
            if (i.customId === `stg_${mid}_select_sub`) {
                selectedCode = i.values[0];
                currentPanel = 'MAIN';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_close`) {
                collector.stop();
                return i.update({ content: '✅ تم إغلاق القائمة.', embeds: [], components: [] });
            }

            if (i.customId === `stg_${mid}_back_to_select`) {
                currentPanel = 'SELECT';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_back_to_main`) {
                currentPanel = 'MAIN';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_appearance`) {
                currentPanel = 'APPEARANCE';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_display`) {
                currentPanel = 'DISPLAY';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_platform`) {
                currentPanel = 'PLATFORM';
                return updatePanel(i);
            }

            if (i.customId === `stg_${mid}_panel_rooms`) {
                currentPanel = 'ROOMS';
                return updatePanel(i);
            }

            // Toggles
            if (i.customId === `stg_${mid}_toggle_buttons`) {
                const cur = getDisplay(selectedCode);
                const newVal = !cur.buttons;
                setDisplay(selectedCode, { buttons: newVal });
                // Apply to tokens so music.js reads the correct value
                tokens = store.get('tokens') || [];
                tokens.forEach(t => { if (t.code === selectedCode) t.buttons = newVal ? 'on' : 'off'; });
                store.set('tokens', tokens);
                return updatePanel(i);
            }
            if (i.customId === `stg_${mid}_toggle_embeds`) {
                const cur = getDisplay(selectedCode);
                const newVal = !cur.embeds;
                setDisplay(selectedCode, { embeds: newVal });
                // Apply to tokens for consistency
                tokens = store.get('tokens') || [];
                tokens.forEach(t => { if (t.code === selectedCode) t.embeds = newVal ? 'on' : 'off'; });
                store.set('tokens', tokens);
                return updatePanel(i);
            }

            // Platform
            if (i.customId.startsWith(`stg_${mid}_plat_`)) {
                const plat = i.customId.split('_').pop();
                setDisplay(selectedCode, { platform: plat });

                // Write to tokens.source so music.js picks it up
                tokens = store.get('tokens') || [];
                tokens.forEach(t => { if (t.code === selectedCode) t.source = plat; });
                store.set('tokens', tokens);

                // Apply live to running bots immediately
                tokens.filter(t => t.code === selectedCode).forEach(entry => {
                    const bot = runningBots.get(entry.token);
                    if (bot?.poru) bot.poru.options.defaultPlatform = plat;
                });

                return updatePanel(i);
            }

            // Modals: Avatar, Banner, Status, Distribute
            if (i.customId === `stg_${mid}_set_avatar`) {
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_avatar`).setTitle('تغيير صورة البوتات');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('رابط الصورة').setRequired(true).setStyle(TextInputStyle.Short)));
                await i.showModal(modal);
            }

            if (i.customId === `stg_${mid}_set_status`) {
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_status`).setTitle('تغيير حالة البوتات');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('نص الحالة').setRequired(true).setStyle(TextInputStyle.Short)));
                await i.showModal(modal);
            }
            
            if (i.customId === `stg_${mid}_set_banner`) {
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_banner`).setTitle('تغيير بانر البوتات');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('رابط الصورة').setRequired(true).setStyle(TextInputStyle.Short)));
                await i.showModal(modal);
            }

            if (i.customId === `stg_${mid}_distribute`) {
                const modal = new ModalBuilder().setCustomId(`stg_mod_${mid}_dist`).setTitle('توزيع البوتات على الرومات');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('first').setLabel('ايدي أول روم صوتي').setRequired(true).setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('last').setLabel('ايدي آخر روم صوتي').setRequired(true).setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('الوضع (N للترقيم / S لاسم البوت)').setMaxLength(1).setRequired(true).setStyle(TextInputStyle.Short))
                );
                await i.showModal(modal);
            }

            if (i.customId === `stg_${mid}_voice_status`) {
                // Voice status sub-panel logic
                await handleVoiceStatus(i);
            }
        });

        // Handle Modal Submits
        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isModalSubmit()) return;
            if (!interaction.customId.startsWith(`stg_mod_${mid}_`)) return;

            const subTokens = tokens.filter(t => t.code === selectedCode);
            await interaction.deferUpdate();

            if (interaction.customId === `stg_mod_${mid}_avatar`) {
                const url = interaction.fields.getTextInputValue('url');
                await mainMsg.edit({ content: '⏳ جاري تغيير الصور...', embeds: [], components: [] });
                
                const results = await Promise.allSettled(subTokens.map(async t => {
                    const bot = runningBots.get(t.token);
                    if (bot) await bot.user.setAvatar(url);
                }));

                const success = results.filter(r => r.status === 'fulfilled').length;
                await mainMsg.edit({ content: `✅ تم تحديث ${success}/${subTokens.length} بوت بنجاح.` });
                setTimeout(() => updatePanel(), 3000);
            }

            if (interaction.customId === `stg_mod_${mid}_status`) {
                const text = interaction.fields.getTextInputValue('text');
                await mainMsg.edit({ content: '⏳ جاري تغيير الحالة...', embeds: [], components: [] });
                
                // Update tokens.json
                tokens.forEach(t => { if (t.code === selectedCode) t.status = text; });
                store.set('tokens', tokens);

                const results = await Promise.allSettled(subTokens.map(async t => {
                    const bot = runningBots.get(t.token);
                    if (bot) {
                        bot.user.setPresence({
                            activities: [{ name: text, type: 3 }], // WATCHING
                            status: 'online'
                        });
                    }
                }));

                await mainMsg.edit({ content: `✅ تم تحديث حالة ${results.length} بوت بنجاح.` });
                setTimeout(() => updatePanel(), 3000);
            }

            if (interaction.customId === `stg_mod_${mid}_banner`) {
                const url = interaction.fields.getTextInputValue('url');
                await mainMsg.edit({ content: '⏳ جاري تغيير البانر...', embeds: [], components: [] });
                
                try {
                    const response = await axios.get(url, { responseType: 'arraybuffer' });
                    const base64 = Buffer.from(response.data, 'binary').toString('base64');
                    const data = `data:${response.headers['content-type']};base64,${base64}`;

                    const results = await Promise.allSettled(subTokens.map(async t => {
                        await axios.patch('https://discord.com/api/v9/users/@me', { banner: data }, {
                            headers: { Authorization: `Bot ${t.token}`, 'Content-Type': 'application/json' }
                        });
                    }));
                    
                    const success = results.filter(r => r.status === 'fulfilled').length;
                    await mainMsg.edit({ content: `✅ تم تحديث بانر ${success}/${subTokens.length} بوت بنجاح.` });
                } catch (e) {
                    await mainMsg.edit({ content: `❌ فشل تحديث البانر: ${e.message}` });
                }
                setTimeout(() => updatePanel(), 3000);
            }

            if (interaction.customId === `stg_mod_${mid}_dist`) {
                const firstId = interaction.fields.getTextInputValue('first');
                const lastId = interaction.fields.getTextInputValue('last');
                const mode = interaction.fields.getTextInputValue('mode').toUpperCase();

                await mainMsg.edit({ content: '⏳ جاري توزيع البوتات...', embeds: [], components: [] });

                try {
                    const sampleBot = runningBots.get(subTokens[0].token);
                    if (!sampleBot) throw new Error('لا يوجد بوتات نشطة حالياً لتنفيذ العملية.');

                    const guild = sampleBot.guilds.cache.get(subTokens[0].Server);
                    if (!guild) throw new Error('تعذر الوصول للسيرفر.');

                    const channels = await guild.channels.fetch();
                    const voiceChannels = channels
                        .filter(c => c.type === 2) // GuildVoice
                        .sort((a, b) => a.position - b.position);

                    const firstChan = voiceChannels.get(firstId);
                    const lastChan = voiceChannels.get(lastId);

                    if (!firstChan || !lastChan) throw new Error('تعذر العثور على الرومات المحددة.');

                    const targetChannels = voiceChannels.filter(c => c.position >= firstChan.position && c.position <= lastChan.position).toJSON();
                    
                    if (targetChannels.length === 0) throw new Error('لا توجد رومات صوتية في المدى المحدد.');

                    for (let i = 0; i < subTokens.length; i++) {
                        const t = subTokens[i];
                        const chan = targetChannels[i % targetChannels.length];
                        t.channel = chan.id;
                        
                        // Apply to running bot
                        const bot = runningBots.get(t.token);
                        if (bot && mode === 'S') {
                            await bot.user.setUsername(chan.name).catch(() => {});
                        } else if (bot && mode === 'N') {
                            await bot.user.setUsername(`${chan.name} ${i + 1}`).catch(() => {});
                        }
                    }

                    store.set('tokens', tokens);
                    await mainMsg.edit({ content: `✅ تم توزيع ${subTokens.length} بوت على ${targetChannels.length} روم.` });
                } catch (e) {
                    await mainMsg.edit({ content: `❌ خطأ: ${e.message}` });
                }
                setTimeout(() => updatePanel(), 3000);
            }
        });

        async function handleVoiceStatus(interaction) {
            let page = 0;
            const subTokens = tokens.filter(t => t.code === selectedCode);

            // Helper: decode bot client_id from token
            function getClientId(token) {
                try { return Buffer.from(token.split('.')[0], 'base64').toString('utf8'); } catch { return ''; }
            }

            // Helper: get bot voice state info
            function getBotVoiceInfo(t) {
                const bot = runningBots.get(t.token);
                if (!bot) return { bot: null, statusText: '🚫 غير متصل', inRoom: false, inServer: false };
                const guild = bot.guilds.cache.get(t.Server);
                if (!guild) return { bot, statusText: '🌐 خارج السيرفر', inRoom: false, inServer: false };
                const vc = guild.members.me?.voice?.channel;
                return {
                    bot,
                    statusText: vc ? `🔊 <#${vc.id}>` : '💤 لا يوجد في روم',
                    inRoom: !!vc,
                    inServer: true
                };
            }

            async function renderVoicePanel(i = null) {
                const start = page * 10;
                const end = Math.min(start + 10, subTokens.length);
                const slice = subTokens.slice(start, end);

                const lines = slice.map((t, idx) => {
                    const { bot, statusText } = getBotVoiceInfo(t);
                    const mention = bot ? `<@${bot.user.id}>` : '`غير معروف`';
                    const num = String(start + idx + 1).padStart(3, ' ');
                    return `\`${num}\` ${mention}  ${statusText}`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`📊 حالة الصوت — ${selectedCode}`)
                    .setDescription(
                        `> البوتات **${start + 1}–${end}** من أصل **${subTokens.length}**\n` +
                        `> 🔊 بروم  |  💤 بدون روم  |  🌐 خارج سيرفر  |  🚫 غير متصل\n` +
                        `\u200b\n` +
                        lines.join('\n')
                    )
                    .setColor(Colors)
                    .setFooter({ text: `صفحة ${page + 1} / ${Math.ceil(subTokens.length / 10)}` });

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_prev`).setLabel('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_next`).setLabel('▶️').setStyle(ButtonStyle.Secondary).setDisabled(end >= subTokens.length),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_restart`).setLabel('🔄 Restart').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_moveidle`).setLabel('📥 إدخال الخاملين').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`stg_${mid}_panel_rooms`).setLabel('⬅️ رجوع').setStyle(ButtonStyle.Secondary)
                );
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_links_all`).setLabel('📤 روابط الكل').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_links_out`).setLabel('🌐 خارج السيرفر').setStyle(ButtonStyle.Secondary)
                );

                const payload = { embeds: [embed], components: [row1, row2], content: '' };
                if (i) await i.update(payload);
                else await mainMsg.edit(payload);
            }

            await renderVoicePanel(interaction);

            const vsCollector = mainMsg.createMessageComponentCollector({
                filter: i => i.user.id === userId && (
                    i.customId.startsWith(`stg_vs_${mid}_`) || i.customId.startsWith(`stg_vsc_${mid}_`)
                ),
                time: 120000
            });

            vsCollector.on('collect', async i => {
                // ── Pagination ─────────────────────────────────────────────
                if (i.customId === `stg_vs_${mid}_prev`) { page--; return renderVoicePanel(i); }
                if (i.customId === `stg_vs_${mid}_next`) { page++; return renderVoicePanel(i); }

                // ── Restart → اسأل: الكل أم اللي بالرومات فقط ─────────────
                if (i.customId === `stg_vs_${mid}_restart`) {
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`stg_vsc_${mid}_rst_all`).setLabel('🔄 الكل').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`stg_vsc_${mid}_rst_rooms`).setLabel('🔊 اللي بالرومات فقط').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`stg_vsc_${mid}_rst_cancel`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
                    );
                    return i.update({ content: '⚠️ اختر نوع إعادة التشغيل:', embeds: [], components: [row] });
                }

                if (i.customId === `stg_vsc_${mid}_rst_cancel`) {
                    return renderVoicePanel(i);
                }

                if (i.customId === `stg_vsc_${mid}_rst_all` || i.customId === `stg_vsc_${mid}_rst_rooms`) {
                    const roomsOnly = i.customId === `stg_vsc_${mid}_rst_rooms`;
                    const targets = roomsOnly
                        ? subTokens.filter(t => getBotVoiceInfo(t).inRoom)
                        : subTokens;

                    await i.update({ content: `⏳ جاري إعادة تشغيل **${targets.length}** بوت...`, embeds: [], components: [] });

                    targets.forEach(t => {
                        const bot = runningBots.get(t.token);
                        if (bot) { bot.destroy().catch(() => {}); runningBots.delete(t.token); }
                    });

                    await mainMsg.edit({ content: `✅ تم إعادة تشغيل **${targets.length}** بوت. سيُعاد تشغيلها خلال 10 ثوانٍ.` });
                    vsCollector.stop();
                    setTimeout(() => updatePanel(), 10000);
                    return;
                }

                // ── لوحة الروابط (الكل أو خارج السيرفر) ──────────────────
                if (i.customId === `stg_vs_${mid}_links_all` || i.customId === `stg_vs_${mid}_links_out`) {
                    const initFilter = i.customId === `stg_vs_${mid}_links_out` ? 'outside' : 'all';
                    vsCollector.stop('open_links');
                    return showLinksPanel(i, subTokens, selectedCode, initFilter);
                }

                // ── إدخال الخاملين إلى روم ───────────────────────────────
                if (i.customId === `stg_vs_${mid}_moveidle`) {
                    const idleBots = subTokens.filter(t => {
                        const info = getBotVoiceInfo(t);
                        return info.inServer && !info.inRoom;
                    });

                    if (idleBots.length === 0) {
                        return i.reply({ content: '✅ لا يوجد بوتات خاملة — كلها في رومات.', ephemeral: true });
                    }

                    const modal = new ModalBuilder()
                        .setCustomId(`stg_mod_${mid}_moveidle`)
                        .setTitle(`إدخال ${idleBots.length} بوت خامل`);
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('channelId')
                                .setLabel('ID الروم الصوتي (أو عدة IDs مفصولة بفاصلة للتوزيع)')
                                .setPlaceholder('مثال: 123456789  أو  111,222,333')
                                .setRequired(true)
                                .setStyle(TextInputStyle.Short)
                        )
                    );
                    return i.showModal(modal);
                }
            });

            // Modal: إدخال الخاملين
            client.on('interactionCreate', async (interaction) => {
                if (!interaction.isModalSubmit()) return;
                if (interaction.customId !== `stg_mod_${mid}_moveidle`) return;

                const input = interaction.fields.getTextInputValue('channelId');
                const channelIds = input.split(',').map(s => s.trim()).filter(Boolean);
                const idleBots = subTokens.filter(t => {
                    const info = getBotVoiceInfo(t);
                    return info.inServer && !info.inRoom;
                });

                await interaction.deferUpdate();
                await mainMsg.edit({ content: `⏳ جاري إدخال **${idleBots.length}** بوت خامل...`, embeds: [], components: [] });

                let success = 0;
                const results = await Promise.allSettled(idleBots.map(async (t, idx) => {
                    const targetChannelId = channelIds[idx % channelIds.length];
                    t.channel = targetChannelId;
                    success++;
                }));

                store.set('tokens', tokens);

                const failed = results.filter(r => r.status === 'rejected').length;
                await mainMsg.edit({
                    content: `✅ تم تحديث روم **${success}** بوت خامل.${failed ? ` (${failed} فشلت)` : ''}\nسيدخل البوتات عند إعادة الاتصال.`
                });
                setTimeout(() => updatePanel(), 3000);
            });
        }

        // ════════════════════════════════════════════════════════════════
        //  showLinksPanel — لوحة روابط البوتات بإيمبد + فلتر + صفحات
        // ════════════════════════════════════════════════════════════════
        async function showLinksPanel(triggerInteraction, allBots, code, initFilter = 'all') {
            let lpPage   = 0;
            let lpFilter = initFilter;   // 'all' | 'in_room' | 'idle' | 'outside' | 'offline'

            const PAGE_SIZE = 10;

            // تسميات الفلاتر
            const FILTER_LABELS = {
                all:     '📋 الكل',
                in_room: '🔊 بالرومات',
                idle:    '💤 خاملة (بالسيرفر)',
                outside: '🌐 خارج السيرفر',
                offline: '🚫 غير متصلة',
            };

            // فلترة البوتات حسب الاختيار
            function applyFilter(bots, filter) {
                return bots.filter((t, globalIdx) => {
                    const info = getBotVoiceInfo(t);
                    if (filter === 'all')     return true;
                    if (filter === 'in_room') return info.inRoom;
                    if (filter === 'idle')    return info.inServer && !info.inRoom;
                    if (filter === 'outside') return !info.inServer && info.bot;
                    if (filter === 'offline') return !info.bot;
                    return true;
                });
            }

            function buildEmbed(filtered) {
                const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
                const start = lpPage * PAGE_SIZE;
                const end   = Math.min(start + PAGE_SIZE, filtered.length);
                const slice = filtered.slice(start, end);

                // نرسم كل بوت: رقمه الأصلي | منشن | حالة | رابط
                const lines = slice.map(({ t, globalIdx }) => {
                    const info     = getBotVoiceInfo(t);
                    const clientId = getClientId(t.token);
                    const mention  = info.bot ? `<@${info.bot.user.id}>` : '`—`';
                    const link     = clientId
                        ? `[دعوة](https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot)`
                        : '`لا يوجد ID`';

                    // مؤشر السيرفر
                    const serverBadge = info.inServer
                        ? '`✅ سيرفر`'
                        : (info.bot ? '`🌐 خارج`' : '`🚫 أوفلاين`');

                    const num = String(globalIdx + 1).padStart(3, ' ');
                    return `\`${num}\` ${mention}  ${info.statusText}  ${serverBadge}  ${link}`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`🔗 روابط البوتات — ${code}`)
                    .setDescription(
                        `> **الفلتر:** ${FILTER_LABELS[lpFilter]}  |  **النتائج:** ${filtered.length} بوت\n` +
                        `\u200b\n` +
                        (lines.length ? lines.join('\n') : '*لا توجد بوتات في هذه الفئة.*')
                    )
                    .setColor(Colors)
                    .setFooter({ text: `صفحة ${lpPage + 1} / ${totalPages}  •  ${code}` });

                return { embed, totalPages, start, end };
            }

            function buildComponents(filtered, totalPages) {
                const end = Math.min((lpPage + 1) * PAGE_SIZE, filtered.length);

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`lp_${mid}_prev`)
                        .setLabel('◀️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(lpPage === 0),
                    new ButtonBuilder()
                        .setCustomId(`lp_${mid}_next`)
                        .setLabel('▶️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(end >= filtered.length),
                    new ButtonBuilder()
                        .setCustomId(`lp_${mid}_back`)
                        .setLabel('⬅️ رجوع')
                        .setStyle(ButtonStyle.Secondary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`lp_${mid}_filter`)
                        .setPlaceholder('🔽 فلتر البوتات')
                        .addOptions(
                            Object.entries(FILTER_LABELS).map(([val, lbl]) => ({
                                label: lbl,
                                value: val,
                                default: val === lpFilter
                            }))
                        )
                );

                return [row1, row2];
            }

            async function renderLinks(i = null) {
                // أعد فلترة وحساب الصفحة في كل رسم
                const filtered = applyFilter(allBots, lpFilter)
                    .map((t) => ({ t, globalIdx: allBots.indexOf(t) }));

                const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
                // تصحيح الصفحة إذا خرجت عن الحدود
                if (lpPage >= totalPages) lpPage = totalPages - 1;
                if (lpPage < 0) lpPage = 0;

                const { embed } = buildEmbed(filtered);
                const components = buildComponents(filtered, totalPages);

                const payload = { embeds: [embed], components, content: '' };
                if (i) await i.update(payload);
                else    await mainMsg.edit(payload);
            }

            // أول عرض
            await renderLinks(triggerInteraction);

            const lpCollector = mainMsg.createMessageComponentCollector({
                filter: i => i.user.id === userId && i.customId.startsWith(`lp_${mid}_`),
                time: 180000
            });

            lpCollector.on('collect', async i => {
                if (i.customId === `lp_${mid}_prev`) { lpPage--; return renderLinks(i); }
                if (i.customId === `lp_${mid}_next`) { lpPage++; return renderLinks(i); }
                if (i.customId === `lp_${mid}_back`) {
                    lpCollector.stop();
                    return handleVoiceStatus(i);
                }
                if (i.customId === `lp_${mid}_filter`) {
                    lpFilter = i.values[0];
                    lpPage   = 0;
                    return renderLinks(i);
                }
            });

            lpCollector.on('end', (_, reason) => {
                if (reason === 'time') mainMsg.edit({ components: [] }).catch(() => {});
            });
        }
    }
};
