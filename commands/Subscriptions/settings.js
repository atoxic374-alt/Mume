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
                setDisplay(selectedCode, { buttons: !cur.buttons });
                return updatePanel(i);
            }
            if (i.customId === `stg_${mid}_toggle_embeds`) {
                const cur = getDisplay(selectedCode);
                setDisplay(selectedCode, { embeds: !cur.embeds });
                return updatePanel(i);
            }

            // Platform
            if (i.customId.startsWith(`stg_${mid}_plat_`)) {
                const plat = i.customId.split('_').pop();
                setDisplay(selectedCode, { platform: plat });
                
                // Update running bots
                const subTokens = tokens.filter(t => t.code === selectedCode);
                subTokens.forEach(entry => {
                    const bot = runningBots.get(entry.token);
                    if (bot && bot.poru) {
                        bot.poru.options.defaultPlatform = plat;
                    }
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

            async function renderVoicePanel(i = null) {
                const start = page * 5;
                const end = start + 5;
                const slice = subTokens.slice(start, end);

                const embed = new EmbedBuilder()
                    .setTitle(`حالة الصوت — ${selectedCode}`)
                    .setDescription(`عرض البوتات من ${start + 1} إلى ${Math.min(end, subTokens.length)} من أصل ${subTokens.length}`)
                    .setColor(Colors);

                slice.forEach((t, idx) => {
                    const bot = runningBots.get(t.token);
                    let statusText = '🚫 غير متصل';
                    if (bot) {
                        const guild = bot.guilds.cache.get(t.Server);
                        const vc = guild?.members.me?.voice?.channel;
                        statusText = vc ? `🔊 <#${vc.id}>` : '💤 لا يوجد في روم';
                    }
                    embed.addFields({ name: `بوت #${start + idx + 1}`, value: `${bot ? `<@${bot.user.id}>` : '`غير معروف`'} | ${statusText}` });
                });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_prev`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_next`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(end >= subTokens.length),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_restart`).setLabel('إعادة تشغيل').setEmoji('🔄').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`stg_vs_${mid}_links`).setLabel('روابط الدعوة').setEmoji('📤').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`stg_${mid}_panel_rooms`).setLabel('رجوع').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
                );

                if (i) await i.update({ embeds: [embed], components: [row] });
                else await mainMsg.edit({ embeds: [embed], components: [row] });
            }

            await renderVoicePanel(interaction);

            const vsCollector = mainMsg.createMessageComponentCollector({
                filter: i => i.user.id === userId && i.customId.startsWith(`stg_vs_${mid}_`),
                time: 60000
            });

            vsCollector.on('collect', async i => {
                if (i.customId === `stg_vs_${mid}_prev`) { page--; await renderVoicePanel(i); }
                if (i.customId === `stg_vs_${mid}_next`) { page++; await renderVoicePanel(i); }
                if (i.customId === `stg_vs_${mid}_restart`) {
                    await i.update({ content: '⏳ جاري تدمير جلسات البوتات لإعادة تشغيلها...', embeds: [], components: [] });
                    subTokens.forEach(t => {
                        const bot = runningBots.get(t.token);
                        if (bot) {
                            bot.destroy().catch(() => {});
                            runningBots.delete(t.token);
                        }
                    });
                    await mainMsg.edit({ content: '✅ تم تدمير الجلسات. سيقوم النظام بإعادة تشغيلها خلال 10 ثوانٍ.' });
                    setTimeout(() => updatePanel(), 5000);
                    vsCollector.stop();
                }
                if (i.customId === `stg_vs_${mid}_links`) {
                    const links = subTokens.map((t, idx) => `Bot #${idx + 1}: https://discord.com/api/oauth2/authorize?client_id=${t.token.split('.')[0]}&permissions=8&scope=bot`).join('\n');
                    await message.author.send({ content: `🔗 روابط دعوة البوتات للاشتراك \`${selectedCode}\`:\n${links.substring(0, 1900)}` }).catch(() => {});
                    await i.reply({ content: '✅ تم إرسال الروابط في الخاص.', ephemeral: true });
                }
            });
        }
    }
};
