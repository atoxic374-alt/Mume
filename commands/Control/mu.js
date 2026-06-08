const fs = require('fs');
const store = require('../../utils/store');
const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { owners, prefix } = require('../../config');
const { getEmbedColor } = require('../../utils/embedColor');
const axios = require("axios");
const db = require('../../utils/db');
const Discord = require('discord.js');
const path = require('path');
const {
    buildOwnershipTransferredDm,
    buildServerUpdatedDm,
} = require('../../utils/subscriptionDm');

function formatDuration(msValue) {
    const value = Math.max(0, Number(msValue || 0));
    const d = Math.floor(value / 86400000);
    const h = Math.floor((value % 86400000) / 3600000);
    const m = Math.floor((value % 3600000) / 60000);
    const s = Math.floor((value % 60000) / 1000);
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && !h && s && `${s}s`].filter(Boolean).join(' ') || '0m';
}

function parseUserId(raw) {
    const value = String(raw || '').trim();
    const mention = value.match(/^<@!?(\d{15,20})>$/);
    if (mention) return mention[1];
    return /^\d{15,20}$/.test(value) ? value : null;
}

function chunkArray(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

module.exports = {
    name: 'music',
    aliases: ["mu", "vip"],
    async execute(client, message, args) {


        let targetUser = message.mentions.users.first();

        if (targetUser && !owners.includes(message.author.id)) {
            return;
        }

        if (!targetUser) {
            targetUser = message.author;
        }

        const subscriptions = store.get('time') || [];
        const userId = targetUser.id;
        const userSubscriptions = subscriptions.filter(sub => sub.user === targetUser.id);

        if (userSubscriptions.length === 0) {
            return;
        }

        const emojiData = store.get('emojis') || { emojis: [] };
        const emojis = emojiData.emojis;

        const selectMenu = new Discord.StringSelectMenuBuilder()
            .setCustomId('subscriptionCodes')
            .setPlaceholder('يرجى الاختيار ..')
            .setMinValues(1)
            .addOptions(userSubscriptions.map((sub, index) => {
                return {
                    label: `Music x${sub.botsCount} `,
                    emoji: emojis[index],
                    description: `(SuID ${sub.code})`,
                    value: sub.code
                };
            }));

        const cancelButton = new ButtonBuilder()
            .setCustomId('cancel')
            .setLabel('إلغاء')
            .setStyle('Danger');

        const row = new ActionRowBuilder().addComponents(selectMenu);
        const row2 = new ActionRowBuilder().addComponents(cancelButton);

        const panelMsg = await message.reply({
            content: '**أختر الأشتراك.**',
            components: [row, row2]
        });


        // مهم جداً: اجمع التفاعلات على نفس الرسالة فقط (مو على الروم كامل)
        // لأن جمعها على الروم يسبب وجود أكثر من Collector يلتقط نفس التفاعل
        // وبالتالي تحصل أخطاء 40060 / 10062.
        const filter = (i) => i.user.id === message.author.id;
        const collector = panelMsg.createMessageComponentCollector({ filter, time: 60000 });


        collector.on('collect', async (interaction) => {
            // زر الإلغاء
            if (interaction.isButton() && interaction.customId === 'cancel') {
                await interaction.deferUpdate().catch(() => {});
                await interaction.message.delete().catch(() => {});
                collector.stop('cancel');
                return;
            }

            // نتأكد أن هذا الاختيار هو الخاص بالقائمة الأولى فقط
            if (!interaction.isStringSelectMenu() || interaction.customId !== 'subscriptionCodes') return;

            // وقف الـ collector قبل أي تحديث لتجنب تكرار الاعتراف بالتفاعل
            collector.stop('selected');

            const selectedCodes = interaction.values;
            const selectedSubscriptions = userSubscriptions.filter(sub => selectedCodes.includes(sub.code));

            if (selectedSubscriptions.length > 0) {
                const tokens = store.get('tokens') || [];

                const userTokens = tokens.filter(token => selectedCodes.includes(token.code) && token.client === targetUser.id);

                const totalBots = userTokens.length;

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('vipOptions')
                    .setPlaceholder('اختر العملية المطلوبة')
                    .addOptions([
                        {
                            label: 'عرض الاشتراك',
                            emoji: '1265309996292378756',
                            description: 'عرض المدة، العدد، السيرفر، ومعلومات الاشتراك',
                            value: 'musictime',
                        }, {
                            label: 'إعادة تشغيل',
                            emoji: '1356528848237367326',
                            description: 'إعادة تشغيل البوتات المملوكة لك جميعًا',
                            value: 'restart',
                        }, {
                            label: 'نقل السيرفر',
                            emoji: '1256869694967644231',
                            description: 'نقل سيرفر البوتات إلي سيرفر جديد',
                            value: 'updateServerId',
                        },
                        {
                            label: 'نقل ملكية البوتات',
                            emoji: '1344186014448615435',
                            description: 'نقل ملكية البوتات إلى مستخدم آخر',
                            value: 'transferOwnership',
                        }, {
                            label: 'روابط البوتات',
                            emoji: '1256869691004162068',
                            description: 'إرسال روابط بوتاتك في الخاص بإيمبد منظم',
                            value: 'mylinks',
                        }
                    ]);

                const cancelButton = new ButtonBuilder()
                    .setCustomId('cancel')
                    .setLabel('إلغاء')
                    .setStyle('Danger');

                const selectedServer = userTokens[0]?.Server || selectedSubscriptions[0]?.server || 'غير محدد';
                const controlEmbed = new EmbedBuilder()
                    .setColor(getEmbedColor(client))
                    .setTitle('Music Control')
                    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
                    .setDescription([
                        `**User :** *<@${targetUser.id}>*`,
                        '',
                        `**Subscriptions :** *\`${selectedCodes.length}\` اشتراك محدد*`,
                        '',
                        `**Bot Count :** *\`${totalBots}\` بوت*`,
                        '',
                        `**Server :** *\`${selectedServer}\`*`,
                        '',
                        '**Options :** *اختر العملية المطلوبة من القائمة بالأسفل.*',
                    ].join('\n'))
                    .setFooter({ text: `${client.user.username} | MU`, iconURL: client.user.displayAvatarURL({ dynamic: true }) });

                const replyMessage = await interaction.update({
                    content: '',
                    embeds: [controlEmbed],
                    components: [
                        new ActionRowBuilder().addComponents(selectMenu),
                        new ActionRowBuilder().addComponents(cancelButton)
                    ]
                });

                const filter = (i) => i.user.id === message.author.id;
                const collector = replyMessage.createMessageComponentCollector({ filter, time: 60000 });

                function disabledRowsFrom(rows = []) {
                    return rows.map(row => new ActionRowBuilder().addComponents(
                        row.components.map(component => {
                            if (component.type === ComponentType.Button) return ButtonBuilder.from(component).setDisabled(true);
                            if (component.type === ComponentType.StringSelect) return StringSelectMenuBuilder.from(component).setDisabled(true);
                            return component;
                        })
                    ));
                }

                function clientIdFromToken(token) {
                    try {
                        return Buffer.from(String(token || '').split('.')[0], 'base64').toString('utf8');
                    } catch {
                        return null;
                    }
                }

                function inviteUrlFromToken(token) {
                    const clientId = clientIdFromToken(token);
                    return clientId ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=0&scope=bot` : null;
                }

                function botRuntimeInfo(tokenData) {
                    let bot = null;
                    try { bot = require('../../music').runningBots?.get(tokenData.token); } catch {}
                    const inServer = !!(bot && tokenData.Server && bot.guilds.cache.has(tokenData.Server));
                    return {
                        bot,
                        name: bot?.user?.username || tokenData.invalidBotName || 'Music Bot',
                        inServer,
                        status: bot ? (inServer ? 'داخل السيرفر' : 'خارج السيرفر') : 'غير متصل',
                    };
                }

                async function sendLinksAsEmbeds(interaction, mode = 'all') {
                    const key = mode === 'outside' ? `Off-serverlinks-${message.author.id}` : `linktime_${message.author.id}`;
                    const lastClaimTime = await db.get(key) || 0;
                    const currentTime = Date.now();
                    const timeDifference = currentTime - lastClaimTime;

                    if (timeDifference < 240000) {
                        const remainingTime = 240000 - timeDifference;
                        const minutes = Math.floor(remainingTime / 60000);
                        const seconds = Math.ceil((remainingTime % 60000) / 1000);
                        const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
                        return interaction.reply({ content: `**Cooldown :** *انتظر \`${formattedTime}\` قبل استخدام هذا الخيار مرة أخرى.*`, ephemeral: true }).catch(() => {});
                    }

                    await interaction.deferUpdate().catch(() => {});
                    const entries = userTokens
                        .map((token, index) => {
                            const runtime = botRuntimeInfo(token);
                            const url = inviteUrlFromToken(token.token);
                            return { token, index, runtime, url };
                        })
                        .filter(entry => entry.url && (mode === 'all' || !entry.runtime.inServer));

                    if (!entries.length) {
                        await interaction.followUp({
                            content: mode === 'outside'
                                ? '**Bot Links :** *كل البوتات موجودة داخل السيرفر بالفعل.*'
                                : '**Bot Links :** *لا توجد روابط جاهزة للإرسال.*',
                            ephemeral: true,
                        }).catch(() => {});
                        return interaction.message.edit({ components: disabledRowsFrom(interaction.message.components) }).catch(() => {});
                    }

                    for (const [chunkIndex, chunk] of chunkArray(entries, 10).entries()) {
                        const embed = new EmbedBuilder()
                            .setColor(getEmbedColor(client))
                            .setTitle(mode === 'outside' ? 'Outside Server Bot Links' : 'Bot Links')
                            .setDescription(chunk.map(entry => [
                                `**${entry.index + 1}. ${entry.runtime.name} :**`,
                                `*${entry.url}*`,
                                `**Status :** *${entry.runtime.status}*`,
                            ].join('\n')).join('\n\n'))
                            .setFooter({ text: `Page ${chunkIndex + 1} | ${selectedCodes.join(', ')}` });
                        await interaction.user.send({ embeds: [embed] }).catch(() => {});
                    }

                    db.set(key, currentTime);
                    await interaction.followUp({
                        embeds: [new EmbedBuilder()
                            .setColor(getEmbedColor(client))
                            .setTitle('Links Sent')
                            .setDescription([
                                `**User :** *<@${interaction.user.id}>*`,
                                '',
                                `**Mode :** *${mode === 'outside' ? 'Outside Server' : 'All Links'}*`,
                                '',
                                `**Sent :** *\`${entries.length}\` رابط*`,
                                '',
                                `**Subscriptions :** *${selectedCodes.map(code => `\`${code}\``).join(', ')}*`,
                            ].join('\n'))],
                    }).catch(() => {});
                    return interaction.message.edit({ components: disabledRowsFrom(interaction.message.components) }).catch(() => {});
                }

                async function showLinksMenu(interaction) {
                    const linksMenu = new StringSelectMenuBuilder()
                        .setCustomId('muLinksOptions')
                        .setPlaceholder('اختر نوع الروابط')
                        .addOptions([
                            {
                                label: 'كل الروابط',
                                description: 'إرسال روابط كل بوتات الاشتراك في الخاص',
                                value: 'all',
                            },
                            {
                                label: 'خارج السيرفر فقط',
                                description: 'إرسال روابط البوتات غير الموجودة في السيرفر',
                                value: 'outside',
                            },
                        ]);

                    const cancel = new ButtonBuilder().setCustomId('cancel').setLabel('إلغاء').setStyle(ButtonStyle.Danger);
                    const embed = new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Bot Links')
                        .setDescription([
                            `**Bot Count :** *\`${userTokens.length}\` بوت*`,
                            '',
                            '**All Links :** *يرسل كل روابط البوتات في الخاص بإيمبدات منظمة.*',
                            '',
                            '**Outside Server :** *يرسل فقط روابط البوتات غير الموجودة داخل السيرفر المحدد.*',
                        ].join('\n'));

                    await interaction.update({
                        content: '',
                        embeds: [embed],
                        components: [
                            new ActionRowBuilder().addComponents(linksMenu),
                            new ActionRowBuilder().addComponents(cancel),
                        ],
                    });

                    const linkCollector = interaction.message.createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 60000 });
                    linkCollector.on('collect', async i => {
                        if (i.isButton() && i.customId === 'cancel') {
                            await i.deferUpdate().catch(() => {});
                            await i.message.delete().catch(() => {});
                            linkCollector.stop('cancel');
                            return;
                        }
                        if (!i.isStringSelectMenu() || i.customId !== 'muLinksOptions') return;
                        linkCollector.stop('selected');
                        return sendLinksAsEmbeds(i, i.values[0]);
                    });
                }

                async function showSubscriptionInfo(interaction) {
                    const logsArray = store.get('time') || [];
                    const entries = logsArray.filter(entry => selectedCodes.includes(entry.code) && entry.user === targetUser.id);
                    const selectedTokenCount = userTokens.length;
                    const lines = entries.map((entry, index) => {
                        const remainingTime = entry.expirationTime - Date.now();
                        const serverId = entry.server || userTokens.find(token => token.code === entry.code)?.Server || 'غير محدد';
                        return [
                            `**${index + 1}. Subscription :** *\`${entry.code}\`*`,
                            `**Bots :** *\`${entry.botsCount}\` بوت*`,
                            `**Server :** *\`${serverId}\`*`,
                            `**Remaining :** *\`${formatDuration(remainingTime)}\`*`,
                            `**Expires :** *<t:${Math.floor(entry.expirationTime / 1000)}:R>*`,
                        ].join('\n');
                    });

                    const embed = new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Subscription Overview')
                        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
                        .setDescription([
                            `**User :** *<@${targetUser.id}>*`,
                            '',
                            `**Selected Subscriptions :** *\`${entries.length}\`*`,
                            '',
                            `**Active Bots :** *\`${selectedTokenCount}\` بوت*`,
                            '',
                            lines.join('\n\n') || '*لا توجد بيانات اشتراك متاحة.*',
                        ].join('\n'))
                        .setFooter({ text: `${client.user.username} | Subscription`, iconURL: client.user.displayAvatarURL({ dynamic: true }) });

                    return interaction.update({ content: '', embeds: [embed], components: [] }).catch(() => {});
                }

                async function transferOwnershipWithModal(interaction) {
                    const modal = new ModalBuilder()
                        .setCustomId(`mu_transfer_owner_${message.id}`)
                        .setTitle('Transfer Ownership');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('newOwner')
                            .setLabel('New Owner ID')
                            .setPlaceholder('User ID or mention')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true),
                    ));
                    await interaction.showModal(modal);
                    const submit = await interaction.awaitModalSubmit({
                        filter: i => i.customId === `mu_transfer_owner_${message.id}` && i.user.id === interaction.user.id,
                        time: 60000,
                    }).catch(() => null);
                    if (!submit) return;

                    const newUserId = parseUserId(submit.fields.getTextInputValue('newOwner'));
                    if (!newUserId) return submit.reply({ content: '**Transfer Ownership :** *ارسل منشن أو ايدي مستخدم صحيح.*', ephemeral: true });
                    const newOwner = await client.users.fetch(newUserId).catch(() => null);
                    if (!newOwner) return submit.reply({ content: '**Transfer Ownership :** *لم أستطع العثور على المستخدم الجديد.*', ephemeral: true });

                    const timeArray = store.get('time') || [];
                    let movedBots = 0;
                    timeArray.forEach(sub => {
                        if (selectedCodes.includes(sub.code) && sub.user === targetUser.id) {
                            sub.user = newUserId;
                            movedBots += Number(sub.botsCount || 0);
                        }
                    });
                    store.set('time', timeArray);

                    const allTokens = store.get('tokens') || [];
                    allTokens.forEach(token => {
                        if (selectedCodes.includes(token.code) && token.client === targetUser.id) {
                            token.client = newUserId;
                        }
                    });
                    store.set('tokens', allTokens);

                    const successEmbed = buildOwnershipTransferredDm(client, {
                        oldOwnerId: targetUser.id,
                        newOwnerId: newUserId,
                        codes: selectedCodes,
                        botCount: movedBots,
                    });

                    await submit.reply({ embeds: [successEmbed], ephemeral: true }).catch(() => {});
                    await newOwner.send({ embeds: [successEmbed] }).catch(() => {});
                    await targetUser.send({ embeds: [successEmbed] }).catch(() => {});
                }

                async function moveServerWithModal(interaction) {
                    const modal = new ModalBuilder()
                        .setCustomId(`mu_move_server_${message.id}`)
                        .setTitle('Move Server');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('serverId')
                            .setLabel('New Server ID')
                            .setPlaceholder('Example: 123456789012345678')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true),
                    ));
                    await interaction.showModal(modal);
                    const submit = await interaction.awaitModalSubmit({
                        filter: i => i.customId === `mu_move_server_${message.id}` && i.user.id === interaction.user.id,
                        time: 60000,
                    }).catch(() => null);
                    if (!submit) return;

                    const newServerId = submit.fields.getTextInputValue('serverId').trim();
                    if (!/^\d{15,20}$/.test(newServerId)) return submit.reply({ content: '**Move Server :** *اكتب ايدي سيرفر صحيح.*', ephemeral: true });

                    const timeArray = store.get('time') || [];
                    timeArray.forEach(sub => {
                        if (selectedCodes.includes(sub.code) && sub.user === targetUser.id) sub.server = newServerId;
                    });
                    store.set('time', timeArray);

                    const allTokens = store.get('tokens') || [];
                    let movedBots = 0;
                    allTokens.forEach(token => {
                        if (selectedCodes.includes(token.code) && token.client === targetUser.id) {
                            token.Server = newServerId;
                            token.channel = null;
                            token.chat = null;
                            movedBots++;
                        }
                    });
                    store.set('tokens', allTokens);

                    const linkEntries = userTokens
                        .map((token, index) => ({ index, runtime: botRuntimeInfo(token), url: inviteUrlFromToken(token.token) }))
                        .filter(entry => entry.url);
                    for (const [chunkIndex, chunk] of chunkArray(linkEntries, 10).entries()) {
                        const embed = new EmbedBuilder()
                            .setColor(getEmbedColor(client))
                            .setTitle('Move Server Links')
                            .setDescription(chunk.map(entry => [
                                `**${entry.index + 1}. ${entry.runtime.name} :**`,
                                `*${entry.url}*`,
                            ].join('\n')).join('\n\n'))
                            .setFooter({ text: `Page ${chunkIndex + 1} | New server ${newServerId}` });
                        await interaction.user.send({ embeds: [embed] }).catch(() => {});
                    }

                    const successEmbed = buildServerUpdatedDm(client, {
                        serverId: newServerId,
                        codes: selectedCodes,
                        movedBots,
                        linksSent: true,
                    });

                    await submit.reply({ embeds: [successEmbed], ephemeral: true }).catch(() => {});
                    await targetUser.send({ embeds: [successEmbed] }).catch(() => {});
                }

                collector.on('collect', async (interaction) => {
                    // زر الإلغاء
                    if (interaction.isButton() && interaction.customId === 'cancel') {
                        await interaction.deferUpdate().catch(() => {});
                        await interaction.message.delete().catch(() => {});
                        collector.stop('cancel');
                        return;
                    }

                    // نتأكد أن هذه القائمة هي قائمة الخيارات
                    if (!interaction.isStringSelectMenu() || interaction.customId !== 'vipOptions') return;

                    collector.stop('selected');
                    const selectedOption = interaction.values[0];

                    if (selectedOption === 'musictime') return showSubscriptionInfo(interaction);
                    if (selectedOption === 'mylinks') return showLinksMenu(interaction);
                    if (selectedOption === 'updateServerId') return moveServerWithModal(interaction);
                    if (selectedOption === 'transferOwnership') return transferOwnershipWithModal(interaction);

                    if (selectedOption === 'mylinks') {


                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('vipOptions')
                            .setPlaceholder('يرجى الاختيار ..')
                            .addOptions([
                                {
                                    label: 'روابط',
                                    emoji: '1264908026679136360',
                                    description: 'إرسال جميع روابط البوتات التي تمتكلها',
                                    value: 'allBotsLinks',
                                }, {
                                    label: 'روابط خارج السيرفر',
                                    emoji: '1264908028369702935',
                                    description: 'إرسال جميع روابط البوتات خارج سيرفرك',
                                    value: 'Off-serverlinks',
                                }
                            ]);

                        const cancelButton = new ButtonBuilder()
                            .setCustomId('cancel')
                            .setLabel('إلغاء')
                            .setStyle('Danger');

                        const replyMessage = await interaction.update({
                            content: `**أخـتـر الأمـر.**`,
                            components: [
                                new ActionRowBuilder().addComponents(selectMenu),
                                new ActionRowBuilder().addComponents(cancelButton)
                            ]
                        });

                                                const filter = (i) => i.user.id === message.author.id;
                                                const collector = replyMessage.createMessageComponentCollector({ filter, time: 60000 });

                                                collector.on('collect', async (interaction) => {
                                                        // زر الإلغاء
                                                        if (interaction.isButton() && interaction.customId === 'cancel') {
                                                                await interaction.deferUpdate().catch(() => {});
                                                                await interaction.message.delete().catch(() => {});
                                                                collector.stop('cancel');
                                                                return;
                                                        }

                                                        if (!interaction.isStringSelectMenu() || interaction.customId !== 'vipOptions') return;
                                                        const selectedOption = interaction.values[0];
                            if (selectedOption === 'allBotsLinks') {
                                const lastClaimTime = await db.get(`linktime_${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete();
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                await interaction.deferUpdate();

                                let totalBots = userTokens.length;

                                let botInfoPromises = [];
                                for (let [index, token] of userTokens.entries()) {
                                    const botIntents = [
                                        GatewayIntentBits.Guilds,
                                        GatewayIntentBits.GuildVoiceStates,
                                        GatewayIntentBits.GuildMessages,
                                        GatewayIntentBits.MessageContent,
                                    ];
                                    const bot = new Client({ intents: botIntents });

                                    botInfoPromises.push(new Promise(async (resolve, reject) => {
                                        try {
                                            await bot.login(token.token);
                                            const botInfo = `\`${bot.user?.username || "غير معروف"}\` https://discord.com/api/oauth2/authorize?client_id=${bot.user?.id}&permissions=0&scope=bot`;
                                            resolve(botInfo);
                                        } catch (err) {
                                            reject(err);
                                        }
                                    }));
                                }

                                const disabledComponentsLinks = interaction.message.components.map(row => {
                                    return new ActionRowBuilder().addComponents(
                                        row.components.map(component => {
                                            if (component.type === ComponentType.Button) {
                                                return ButtonBuilder.from(component).setDisabled(true);
                                            } else if (component.type === ComponentType.StringSelect) {
                                                return StringSelectMenuBuilder.from(component).setDisabled(true);
                                            } else {
                                                return component;
                                            }
                                        })
                                    );
                                });

                                Promise.all(botInfoPromises)
                                    .then(botInfos => {
                                        botInfos.forEach((botInfo, index) => {
                                            interaction.user.send(`**🔗 : رابط بوت الميوزك رقم ${index + 1} :**\n${botInfo}`)
                                                .catch((sendErr) => {
                                                    console.error("حدث خطأ أثناء إرسال الرابط:", sendErr);
                                                });
                                        });

                                        db.set(`linktime_${message.author.id}`, currentTime);

                                        interaction.followUp({ content: `تم إرسال **${totalBots}** من الروابط إلى الخاص.` });
                                        interaction.editReply({ components: disabledComponentsLinks });
                                    })
                                    .catch(err => {
                                        console.error("حدث خطأ أثناء جمع روابط البوتات:", err);
                                        interaction.followUp({ content: `\`\`\`.حدث خطأ، يرجى التواصل مع الدعم الفني\`\`\`` });
                                        interaction.editReply({ components: disabledComponentsLinks });
                                    });
                            } else if (selectedOption === 'Off-serverlinks') {

                                const lastClaimTime = await db.get(`Off-serverlinks-${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete();
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                await interaction.deferUpdate();


                                let totalBots = userTokens.length;
                                let totalSentBots = 0;
                                let botInfoPromises = [];

                                for (let [index, token] of userTokens.entries()) {
                                    const botIntents = [
                                        GatewayIntentBits.Guilds,
                                        GatewayIntentBits.GuildVoiceStates,
                                        GatewayIntentBits.GuildMessages,
                                        GatewayIntentBits.MessageContent,
                                    ];
                                    const bot = new Client({ intents: botIntents });

                                    botInfoPromises.push(new Promise(async (resolve, reject) => {
                                        try {
                                            await bot.login(token.token);
                                            const serverId = token.Server;
                                            const guild = bot.guilds.cache.get(serverId);

                                            if (!guild) {
                                                const botInfo = `\`${bot.user?.username || "غير معروف"}\` https://discord.com/api/oauth2/authorize?client_id=${bot.user?.id}&permissions=0&scope=bot`;
                                                resolve(botInfo);
                                            } else {
                                                resolve(null);
                                            }
                                        } catch (err) {
                                            reject(err);
                                        }
                                    }));
                                }

                                const disabledComponentsOff = interaction.message.components.map(row => {
                                    return new ActionRowBuilder().addComponents(
                                        row.components.map(component => {
                                            if (component.type === ComponentType.Button) {
                                                return ButtonBuilder.from(component).setDisabled(true);
                                            } else if (component.type === ComponentType.StringSelect) {
                                                return StringSelectMenuBuilder.from(component).setDisabled(true);
                                            } else {
                                                return component;
                                            }
                                        })
                                    );
                                });

                                Promise.all(botInfoPromises)
                                    .then(botInfos => {
                                        botInfos.forEach((botInfo, index) => {
                                            if (botInfo) {
                                                interaction.user.send(`**🔗 : رابط بوت الميوزك رقم ${index + 1} :**\n${botInfo}`)
                                                    .catch((sendErr) => {
                                                        console.error("حدث خطأ أثناء إرسال الرابط:", sendErr);
                                                    });
                                                totalSentBots++;
                                            }
                                        });

                                        db.set(`Off-serverlinks-${message.author.id}`, currentTime);

                                        if (totalSentBots > 0) {
                                            interaction.followUp({ content: `تم إرسال **${totalSentBots}** من الروابط إلى الخاص.` });
                                        } else {
                                            interaction.followUp({ content: `جميع البوتات موجودة بالسيرفر بالفعل.` });
                                        }
                                        interaction.editReply({ components: disabledComponentsOff });
                                    })
                                    .catch(err => {
                                        console.error("حدث خطأ أثناء جمع روابط البوتات:", err);
                                        interaction.followUp({ content: `\`\`\`.حدث خطأ، يرجى التواصل مع الدعم الفني\`\`\`` });
                                        interaction.editReply({ components: disabledComponentsOff });
                                    });
                            }


                        });


                        collector.on('end', (collected, reason) => {
                            if (reason === 'time') {
                            }
                        });


                    }
                    else if (selectedOption === 'appearance') {

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('vipOptions')
                            .setPlaceholder('يرجى الاختيار ..')
                            .addOptions([
                                {
                                    label: 'تبديل الأزرار',
                                    emoji: '1264914466852700211',
                                    description: 'تعطيل او تفعيل الأزرار',
                                    value: 'editbuttons',
                                }, {

                                    label: 'تغير الحالة',
                                    emoji: '1344209274951438398',
                                    description: 'تغير حالة جميع بوتاتك',
                                    value: 'condition',
                                },
                                {
                                    label: 'تغير صور',
                                    emoji: '1251777625509068871',
                                    description: 'تغير صور جميع بوتاتك',
                                    value: 'editavatar',
                                }, {
                                    label: 'تغير بنر',
                                    emoji: '1258322362550718575',
                                    description: 'تغير بنر جميع بوتاتك',
                                    value: 'editbanners',
                                }, {
                                    label: 'تغير أسم',
                                    emoji: '1251797972082229268',
                                    description: 'تغير اسم جميع بوتاتك',
                                    value: 'editname',
                                }
                            ]);

                        const cancelButton = new ButtonBuilder()
                            .setCustomId('cancel')
                            .setLabel('إلغاء')
                            .setStyle('Danger');

                        const replyMessage = await interaction.update({
                            content: `**أخـتـر الأشـتـراك**`,
                            components: [
                                new ActionRowBuilder().addComponents(selectMenu),
                                new ActionRowBuilder().addComponents(cancelButton)
                            ]
                        });

                                                const filter = (i) => i.user.id === message.author.id;
                                                const collector = replyMessage.createMessageComponentCollector({ filter, time: 60000 });

                                                collector.on('collect', async (interaction) => {
                                                        // زر الإلغاء
                                                        if (interaction.isButton() && interaction.customId === 'cancel') {
                                                                await interaction.deferUpdate().catch(() => {});
                                                                await interaction.message.delete().catch(() => {});
                                                                collector.stop('cancel');
                                                                return;
                                                        }

                                                        if (!interaction.isStringSelectMenu() || interaction.customId !== 'vipOptions') return;
                                                        const selectedOption = interaction.values[0];

                            if (selectedOption === 'editbuttons') {

                                const lastClaimTime = await db.get(`editbuttons_${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete();
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                await interaction.deferUpdate();

                                const currentTokenData = tokens.filter(token => token.client === userId);

                                const newButtonState = currentTokenData[0].buttons === 'on' ? 'off' : 'on';
                                currentTokenData.forEach(tokenData => {
                                    tokenData.buttons = newButtonState;
                                });


                                const disabledComponents = interaction.message.components.map(row => {
                                    return new ActionRowBuilder().addComponents(
                                        row.components.map(component => {
                                            if (component.type === ComponentType.Button) {
                                                return ButtonBuilder.from(component).setDisabled(true);
                                            } else if (component.type === ComponentType.StringSelect) {
                                                return StringSelectMenuBuilder.from(component).setDisabled(true);
                                            } else {
                                                return component;
                                            }
                                        })
                                    );
                                });

                                try {
                                    store.set('tokens', tokens);
                                    const botCount = currentTokenData.length;
                                    db.set(`editbuttons_${message.author.id}`, currentTime);
                                    await interaction.followUp({ content: `تم ${newButtonState === 'on' ? 'تفعيل' : 'إيقاف'} جميع الازرار لبوتات الميوزك بنجاح، البوتات المتأثرة : **${botCount}**` });
                                    interaction.editReply({ components: disabledComponents });

                                } catch (error) {
                                    console.error('حدث خطأ أثناء تحديث ملف التوكنات:', error);
                                    await interaction.followUp({ content: '```.حدث خطأ أثناء تحديث الأزرار، يرجى التواصل مع الدعم الفني```' });
                                    interaction.editReply({ components: disabledComponents });
                                }



                            }



                            if (selectedOption === 'editavatar') {

                                const lastClaimTime = await db.get(`editavatar_${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete();
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                const avatarsend = `<@${interaction.user.id}> - يرجى إرفاق الصورة الجديدة، ملاحظة: يجب أن تكون الصورة مرفقة كـ صورة وليس رابط وأن يكون حجم الصورة أقل من 10 ميغابايت`;

                                const cancelButton = new ButtonBuilder()
                                    .setCustomId('cancel')
                                    .setLabel('إلغاء')
                                    .setStyle('Danger');

                                const actionRow = new ActionRowBuilder().addComponents(cancelButton);

                                await interaction.update({ content: avatarsend, components: [actionRow] });

                                const filter = (message) => message.author.id === interaction.user.id && message.attachments.size > 0;
                                const messageCollector = interaction.channel.createMessageCollector({ filter, time: 60000 });

                                let changedBotCount = 0;

                                messageCollector.on('collect', async (message) => {
                                    const imageUrl = message.attachments.first().url;

                                    for (const tokenData of userTokens) {
                                        const botIntents = [
                                            GatewayIntentBits.Guilds,
                                            GatewayIntentBits.GuildVoiceStates,
                                            GatewayIntentBits.GuildMessages,
                                            GatewayIntentBits.MessageContent,
                                        ];
                                        const bot = new Client({ intents: botIntents });

                                        try {
                                            await bot.login(tokenData.token);
                                            await bot.user.setAvatar(imageUrl);
                                            changedBotCount++;
                                            await bot.destroy();
                                        } catch (err) {
                                            console.error(`حدث خطأ أثناء تغيير صورة البوت: ${bot.user?.username || "غير معروف"} - ${err.message}`);
                                        }
                                    }

                                    try {
                                        await interaction.editReply({ content: `تم تغيير صور جميع البوتات بنجاح، البوتات المتأثرة: **${changedBotCount}**`, components: [] });
                                    } catch (error) {
                                        console.error('Error editing reply:', error);
                                    }
                                    db.set(`editavatar_${message.author.id}`, currentTime);
                                    await message.delete();
                                    messageCollector.stop();
                                });


                                messageCollector.on('end', async (collected) => {
                                    if (collected.size === 0) {
                                        await interaction.editReply({ content: "**أنـتـهى وقـت الأرسـال ⏳.**", components: [] });
                                    }
                                });

                            } else if (selectedOption === 'editname') {

                                const lastClaimTime = await db.get(`nametime_${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete();
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                const nameChangePrompt = `<@${interaction.user.id}> - يرجى إدخال الاسم الجديد الذي تريده للبوتات`;

                                const cancelButton = new ButtonBuilder()
                                    .setCustomId('cancel')
                                    .setLabel('إلغاء')
                                    .setStyle('Danger');

                                const actionRow = new ActionRowBuilder().addComponents(cancelButton);

                                await interaction.update({ content: nameChangePrompt, components: [actionRow] });

                                const filter = (message) => message.author.id === interaction.user.id;
                                const messageCollector = interaction.channel.createMessageCollector({ filter, time: 60000 });

                                let changedBotCount = 0;
                                let failedBotCount = 0;

                                messageCollector.on('collect', async (message) => {
                                    const newName = message.content.trim();

                                    for (const tokenData of userTokens) {
                                        const botIntents = [
                                            GatewayIntentBits.Guilds,
                                            GatewayIntentBits.GuildVoiceStates,
                                            GatewayIntentBits.GuildMessages,
                                            GatewayIntentBits.MessageContent,
                                        ];
                                        const bot = new Client({ intents: botIntents });

                                        try {
                                            await bot.login(tokenData.token);
                                            await bot.user.setUsername(newName);
                                            changedBotCount++;
                                            await bot.destroy();
                                        } catch (err) {
                                            console.error(`حدث خطأ أثناء تغيير اسم البوت: ${bot.user?.username || "غير معروف"} - ${err.message}`);

                                            if (err.message.includes('USERNAME_RATE_LIMIT')) {
                                                failedBotCount++;
                                            }
                                        }
                                    }

                                    if (changedBotCount === 0) {
                                        await interaction.editReply({ content: 'حدث خطأ، لا يمكنك تغيير أسماء بعض البوتات في الوقت الحالي حاول لاحقًا.', components: [] });
                                    } else {
                                        if (changedBotCount > 0 && failedBotCount > 0) {
                                            await interaction.editReply({
                                                content: `تم تغيير أسماء بعض البوتات بنجاح، البوتات المتأثرة: **${changedBotCount}** من أصل **${userTokens.length}**.`,
                                                components: []
                                            });
                                        }
                                        else if (changedBotCount === userTokens.length) {
                                            await interaction.editReply({
                                                content: `تم تغيير أسماء جميع البوتات بنجاح، البوتات المتأثرة: **${changedBotCount}**.`,
                                                components: []
                                            });
                                        }
                                    }

                                    db.set(`editname_${message.author.id}`, currentTime);
                                    await message.delete();
                                    messageCollector.stop();
                                });


                                messageCollector.on('end', async (collected) => {
                                    if (collected.size === 0) {
                                        await interaction.editReply({ content: "**أنـتـهى وقـت الأرسـال ⏳.**", components: [] });
                                    }
                                });


                            }

                            if (selectedOption === 'editbanners') {

                                const lastClaimTime = await db.get(`bannerstime_${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete()
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                const bannersend = `<@${interaction.user.id}> - يرجى إرفاق الصورة الجديدة للبنر، ملاحظة: يجب أن تكون الصورة مرفقة كـ صورة وليس رابط وأن يكون حجم الصورة أقل من 10 ميغابايت`;

                                const cancelButton = new ButtonBuilder()
                                    .setCustomId('cancel')
                                    .setLabel('إلغاء')
                                    .setStyle('Danger');

                                const actionRow = new ActionRowBuilder().addComponents(cancelButton);

                                await interaction.update({ content: bannersend, components: [actionRow] });

                                const messageCollectorFilter = (message) => message.author.id === interaction.user.id && message.attachments.size > 0;
                                const messageCollector = interaction.channel.createMessageCollector({ filter: messageCollectorFilter, time: 60000 });

                                let changedBotCount = 0;

                                const changeBanner = async (imageUrl) => {
                                    for (const tokenData of userTokens) {
                                        try {
                                            const base64_banner_image = await axios.get(imageUrl, { responseType: 'arraybuffer' })
                                                .then((res) => Buffer.from(res.data, 'binary').toString('base64'));

                                            await axios.patch(`https://discord.com/api/v9/users/@me`, {
                                                banner: `data:image/jpeg;base64,${base64_banner_image}`
                                            }, {
                                                headers: {
                                                    'Authorization': `Bot ${tokenData.token}`
                                                }
                                            });

                                            changedBotCount++;
                                        } catch (err) {
                                            console.error(`حدث خطأ أثناء تغيير بنر البوت: ${err.message}`);
                                        }
                                    }
                                };

                                messageCollector.on('collect', async (message) => {
                                    const imageUrl = message.attachments.first()?.url;
                                    if (!imageUrl) {
                                        return;
                                    }

                                    await changeBanner(imageUrl);

                                    try {
                                        await interaction.editReply({ content: `تم تغيير بنر جميع البوتات بنجاح، البوتات المتأثرة : **${changedBotCount}**`, components: [] });
                                    } catch (error) {
                                        console.error('Error editing reply:', error);
                                    }
                                    db.set(`bannerstime_${message.author.id}`, currentTime);
                                    try {
                                        await message.delete();
                                    } catch (error) {
                                        console.error('Error deleting message:', error);
                                    }
                                    messageCollector.stop();
                                });


                                messageCollector.on('end', async (collected) => {
                                    if (collected.size === 0) {
                                        await interaction.editReply({ content: "**أنـتـهى وقـت الأرسـال ⏳.**", components: [] });
                                    }
                                });
                            }
                            if (selectedOption === 'condition') {


                                const last = await db.get(`statustime_${userId}`) || 0, now = Date.now();
                                if (now - last < 240000)
                                    return interaction.followUp({ content: `⌛`, ephemeral: true });
                                const sentMsg = await interaction.update({ content: `يَرجى أرفاق إسم الحالة الجديدة.`, ephemeral: false, components: [] });
                                const msgCollector = message.channel.createMessageCollector({ filter: m => m.author.id === message.author.id, time: 60000 });
                                msgCollector.on('collect', async (msg) => {
                                    const status = msg.content.trim();
                                    userTokens.forEach(t => t.status = status);
                                    store.set('tokens', tokens);
                                    db.set(`statustime_${userId}`, now);
                                    msgCollector.stop();
                                    await sentMsg.edit({ content: `تم تغيير الحالة لـ **${userTokens.length}** بوت.` });
                                    await msg.react('✅');
                                });
                                msgCollector.on('end', c => { if (!c.size) sentMsg.edit({ content: "**أنـتـهى وقـت الأرسـال ⏳.**" }); });





                            }

                        });



                    } else if (selectedOption === 'changeBotNames') {

                        const lastClaimTime = await db.get(`nametime_${message.author.id}`) || 0;
                        const currentTime = Date.now();
                        const timeDifference = currentTime - lastClaimTime;

                        if (timeDifference < 240000) {
                            const remainingTime = 240000 - timeDifference;
                            const minutes = Math.floor(remainingTime / (1000 * 60));
                            const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                            const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                            if (!interaction.replied && !interaction.deferred) {
                                interaction.message.delete()
                                return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                            }
                            return;
                        }
                        const nameChangePrompt = `<@${interaction.user.id}> - يرجى إدخال الاسم الجديد الذي تريده للبوتات`;

                        const cancelButton = new ButtonBuilder()
                            .setCustomId('cancel')
                            .setLabel('إلغاء')
                            .setStyle('Danger');

                        const actionRow = new ActionRowBuilder().addComponents(cancelButton);

                        await interaction.update({ content: nameChangePrompt, components: [actionRow] });

                        const filter = (message) => message.author.id === interaction.user.id;
                        const messageCollector = interaction.channel.createMessageCollector({ filter, time: 70000 });

                        let changedBotCount = 0;

                        messageCollector.on('collect', async (message) => {
                            const newName = message.content.trim();

                            for (const tokenData of userTokens) {
                                const botGatewayIntentBits = new GatewayIntentBits([
                                    GatewayIntentBits.FLAGS.GUILDS,
                                    GatewayIntentBits.FLAGS.GUILD_MESSAGES,
                                    GatewayIntentBits.FLAGS.GUILD_MESSAGE_REACTIONS
                                ]);
                                const bot = new Client({ intents: botGatewayIntentBits });

                                try {
                                    await bot.login(tokenData.token);
                                    await bot.user.setUsername(newName);
                                    changedBotCount++;
                                    await bot.destroy();
                                } catch (err) {
                                    console.error(`حدث خطأ أثناء تغيير اسم البوت: ${bot.user?.username || "غير معروف"} - ${err.message}`);
                                }
                            }

                            try {
                                await interaction.editReply({ content: `تم تغيير أسماء جميع البوتات بنجاح، البوتات المتأثرة: **${changedBotCount}**`, components: [] });
                            } catch (error) {
                                console.error('Error editing reply:', error);
                            }
                            db.set(`nametime_${message.author.id}`, currentTime);
                            await message.delete();
                            messageCollector.stop();
                        });


                    }
                    else if (selectedOption === 'installBot') {
                        collector.stop();

                        const lastClaimTime = await db.get(`installBottime_${message.author.id}`) || 0;
                        const currentTime = Date.now();
                        const timeDifference = currentTime - lastClaimTime;

                        if (timeDifference < 240000) {
                            const remainingTime = 240000 - timeDifference;
                            const minutes = Math.floor(remainingTime / (1000 * 60));
                            const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                            const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                            if (!interaction.replied && !interaction.deferred) {
                                if (interaction.message) {
                                    interaction.message.delete()
                                        .then(() => {
                                            message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل استخدام هذا الأمر مرة أخرى` });
                                        })
                                        .catch(error => {
                                            console.error('Failed to delete message:', error);
                                        });
                                } else {
                                    console.error('Interaction message does not exist.');
                                }
                            }
                            return;
                        }

                        const cancelButton = new ButtonBuilder()
                            .setCustomId('cancel')
                            .setLabel('إلغاء')
                            .setStyle('Danger');

                        const actionRow = new ActionRowBuilder().addComponents(cancelButton);

                        const installBot = `<@${interaction.user.id}> - يرجى إرفاق ايدي الفويس المرغوب تثبيت البوتات به`;
                        await interaction.update({ content: installBot, components: [actionRow] });

                        const voiceIdFilter = (response) => {
                            return response.author.id === interaction.user.id && response.content.trim().length > 0;
                        };

                        const voiceIdCollector = interaction.channel.createMessageCollector({ filter: voiceIdFilter, time: 60000 });

                        let transferredBotCount = 0;

                        voiceIdCollector.on('collect', async (response) => {
                            const voiceId = response.content.trim();
                            for (const tokenData of userTokens) {
                                tokenData.channel = voiceId;
                                transferredBotCount++;
                            }
                            store.set('tokens', tokens);

                            db.set(`installBottime_${message.author.id}`, currentTime);
                            await interaction.editReply({ content: `تم تحديث قناة الصوت لِـ **${transferredBotCount}** بوت بنجاح.`, components: [] });
                            response.delete();

                            voiceIdCollector.stop();
                        });

                        voiceIdCollector.on('end', async (collected) => {
                            if (collected.size === 0) {
                                await interaction.editReply({ content: "**أنـتـهى وقـت الأرسـال ⏳.**", components: [] });
                            }
                        });



                    } else if (selectedOption === 'updateServerId') {


                        const lastClaimTime = await db.get(`updateServerIdtime_${message.author.id}`) || 0;
                        const currentTime = Date.now();
                        const timeDifference = currentTime - lastClaimTime;

                        if (timeDifference < 240000) {
                            const remainingTime = 240000 - timeDifference;
                            const minutes = Math.floor(remainingTime / (1000 * 60));
                            const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                            const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                            if (!interaction.replied && !interaction.deferred) {
                                if (interaction.message) {
                                    interaction.message.delete()
                                        .then(() => {
                                            message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل استخدام هذا الأمر مرة أخرى` });
                                        })
                                        .catch(error => {
                                            console.error('Failed to delete message:', error);
                                        });
                                } else {
                                    console.error('Interaction message does not exist.');
                                }
                            }
                            return;
                        }



                        const cancelButton = new ButtonBuilder()
                            .setCustomId('cancel')
                            .setLabel('إلغاء')
                            .setStyle('Danger');


                        const acttionRow = new ActionRowBuilder().addComponents(cancelButton);
                        const serversend = `<@${interaction.user.id}> - يرجى إرفاق ايدي السيرفر المبغّى نقل البوتات به`;
                        await interaction.update({ content: serversend, components: [acttionRow] });

                        const serverIdFilter = (response) => {
                            return response.author.id === message.author.id && response.content.trim().length > 0;
                        };

                        const serverIdCollector = message.channel.createMessageCollector({ filter: serverIdFilter, time: 10000 });

                        serverIdCollector.on('collect', async (response) => {
                            const newServerId = response.content.trim();

                            if (!/^\d+$/.test(newServerId) || newServerId.length < 15) {
                                await interaction.editReply({ content: `\`\`\`يرجى إضافه ايدي سيرفر صحيح.\`\`\``, components: [] });
                                serverIdCollector.stop();
                                return;

                            }

                            for (const token of userTokens) {
                                token.Server = newServerId;
                            }
                            store.set('tokens', tokens);

                            let botInfoPromises = [];
                            for (let [index, token] of userTokens.entries()) {
                                const botGatewayIntentBits = [
                                    GatewayIntentBits.Guilds,
                                    GatewayIntentBits.GuildMessages,
                                    GatewayIntentBits.GuildMessageReactions
                                ];

                                const bot = new Client({ intents: botGatewayIntentBits });

                                botInfoPromises.push(new Promise(async (resolve, reject) => {
                                    try {
                                        await bot.login(token.token);
                                        for (const guild of bot.guilds.cache.values()) {
                                            if (guild.id === newServerId) continue;
                                            if (guild.ownerId === bot.user.id) continue;

                                            try {
                                                await guild.leave();
                                            } catch (error) {
                                                console.error(`❌ > ${guild.id}:`, error.message);
                                            }
                                        }

                                        const botInviteLink = `https://discord.com/api/oauth2/authorize?client_id=${bot.user?.id}&permissions=0&scope=bot`;
                                        resolve(botInviteLink);
                                    } catch (err) {
                                        reject(err);
                                    }
                                }));
                            }

                            Promise.all(botInfoPromises)
                                .then(botInviteLinks => {
                                    const averageTimePerBot = 2000;
                                    const totalBots = botInviteLinks.length;
                                    const expectedTimeInSeconds = averageTimePerBot * totalBots / 1000;
                                    const expectedMinutes = Math.floor(expectedTimeInSeconds / 60);
                                    const expectedSeconds = Math.round(expectedTimeInSeconds % 60);

                                    botInviteLinks.forEach((botInviteLink, index) => {
                                        message.author.send(`**🔗 : رابط بوت الميوزك رقم ${index + 1}:**\n${botInviteLink}`)
                                            .catch((sendErr) => {
                                                console.error("حدث خطأ أثناء إرسال رابط البوت:", sendErr);
                                            });
                                    });

                                    db.set(`updateServerIdtime_${message.author.id}`, currentTime);
                                    interaction.editReply({ content: `تم نقل **${totalBots}** بوت بنجاح. الوقت المتوقع لإرسال الروابط (\`${expectedMinutes}:${expectedSeconds < 10 ? '0' : ''}${expectedSeconds}\`) دقيقة تقريبًا`, components: [] });

                                })
                                .catch(err => {
                                    console.error("حدث خطأ أثناء تسجيل الدخول:", err);
                                    interaction.update({ content: `\`\`\`.حدث خطأ، يرجى التواصل مع الدعم الفني\`\`\``, components: [] });

                                });

                            await response.delete();
                            serverIdCollector.stop();
                        });



                    } else if (selectedOption === 'musictime') {
                        let userId;

                        if (message.mentions.users.size > 0) {
                            userId = message.mentions.users.first().id;
                        } else if (args[0]) {
                            userId = args[0];
                        } else {
                            userId = message.author.id;
                        }

                        try {
                            const logsArray = store.get('time') || [];

                            const userSubscriptions = logsArray.filter(entry => entry.user === userId);

                            if (userSubscriptions.length === 0) {
                                return;
                            }

                            const embed = new EmbedBuilder()
                                .setColor(getEmbedColor(client))
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

                            embed.setDescription(description)
                                .setFooter({ text: `${message.client.user.username} | Timer`, iconURL: client.user.displayAvatarURL({ dynamic: true }) });

                            await interaction.update({ embeds: [embed], components: [], content: `\n\u200b` });

                        } catch (error) {
                            console.error('❌>', error);
                        }


                    } else if (selectedOption === 'transferOwnership') {




                        const cancelButton = new ButtonBuilder()
                            .setCustomId('cancel')
                            .setLabel('إلغاء')
                            .setStyle('Danger');


                        const acttionRow = new ActionRowBuilder().addComponents(cancelButton);

                        await interaction.update({
                            content: `<@${interaction.user.id}> - يرجى إرفاق ايدي الشخص الجديد لتحويل ملكية البوتات إليه`,
                            components: [acttionRow]
                        });

                        const messageFilter = (msg) => msg.author.id === interaction.user.id;
                        const response = await message.channel.awaitMessages({ filter: messageFilter, max: 1, time: 60000 });

                        if (response.size === 0) {
                            return interaction.editReply({
                                content: '**أنـتـهى وقـت الأرسـال ⏳.**',
                                components: []
                            });
                        }

                        const newUser = response.first().content;

                        let newUserId;
                        if (newUser.startsWith('<@') && newUser.endsWith('>')) {
                            newUserId = newUser.slice(2, -1);
                        } else if (/^\d+$/.test(newUser)) {
                            newUserId = newUser;
                        } else {
                            await response.first().delete();
                            return interaction.editReply({ content: 'إستخدام خطأ، يرجى إرفاق منشن شخص صحيح.', components: [] });
                        }

                        let transferredBotsCount = 0;
                        try {
                            let subscriptions = [...(store.get('time') || [])];

                            subscriptions.forEach(sub => {
                                if (selectedCodes.includes(sub.code)) {
                                    sub.user = newUserId;
                                    transferredBotsCount += sub.botsCount;
                                }
                            });

                            store.set('time', subscriptions);

                            await interaction.editReply({
                                content: `تم نقل ملكية جميع البوتات بنجاح، البوتات المتأثرة: **${transferredBotsCount}**`,
                                components: []
                            });

                            await response.first().delete();

                            try {
                                let tokens = store.get('tokens') || [];

                                tokens.forEach(token => {
                                    if (selectedCodes.includes(token.code)) {
                                        token.client = newUserId;
                                    }
                                });

                                store.set('tokens', tokens);
                            } catch (error) {
                                return;
                            }

                        } catch (error) {
                            return interaction.update({ content: `\`\`\`.حدث خطأ، يرجى التواصل مع الدعم الفني\`\`\``, components: [] });
                        }



                    } else if (selectedOption === 'restart') {


                        const lastClaimTime = await db.get(`restart-${message.author.id}`) || 0;
                        const currentTime = Date.now();
                        const timeDifference = currentTime - lastClaimTime;

                        if (timeDifference < 300000) {
                            const remainingTime = 300000 - timeDifference;
                            const minutes = Math.floor(remainingTime / (1000 * 60));
                            const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                            const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                            if (!interaction.replied && !interaction.deferred) {
                                interaction.message.delete();
                                return message.channel.send({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                            }
                            return;
                        }


                        const userId = message.author.id;
                        let tokens = store.get('tokens') || [];

                        const userTokens = tokens.filter(token => token.client === userId);
                        const remainingTokens = tokens.filter(token => token.client !== userId);

                        if (userTokens.length === 0) {
                            return;
                        }

                        await interaction.deferUpdate();
                        db.set(`restart-${message.author.id}`, currentTime);

                        const date = new Date();
                        const formattedDate = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}-${date.getMinutes().toString().padStart(2, '0')}-${date.getSeconds().toString().padStart(2, '0')}`;
                        const backupFile = `./settings/backup/tokensbackup-${formattedDate}.json`;

                        fs.mkdirSync('./settings/backup', { recursive: true });
                        fs.copyFileSync('./settings/tokens.json', backupFile);


                        const reply = await interaction.followUp({
                            content: ` جاري إعادة تشغيل **${userTokens.length}** بوتات، الوقت المُقدر لتشغيلها (\`0:20\`) ثانيا تقريبًا`,
                            ephemeral: false
                        });

                        const disabledComponents = interaction.message.components.map(row => {
                            return new ActionRowBuilder().addComponents(
                                row.components.map(component => {
                                    if (component.type === ComponentType.Button) {
                                        return ButtonBuilder.from(component).setDisabled(true);
                                    } else if (component.type === ComponentType.StringSelect) {
                                        return StringSelectMenuBuilder.from(component).setDisabled(true);
                                    } else {
                                        return component;
                                    }
                                })
                            );
                        });

                        await interaction.message.edit({ components: disabledComponents });

                        store.set('tokens', remainingTokens);

                        setTimeout(async () => {
                            let updatedTokens = store.get('tokens') || [];
                            updatedTokens.push(...userTokens);
                            store.set('tokens', updatedTokens);


                            await reply.edit({
                                content: `إستخدام ناجح، تم إعادة تشغيل البوتات بنجاح، البوتات المتأثرة: **${userTokens.length}**`
                            });

                        }, 20000);
                    } if (selectedOption === 'platform') {
                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('vipOptions')
                            .setPlaceholder('يرجى الاختيار ..')
                            .addOptions([
                                {
                                    label: 'يوتيوب',
                                    emoji: '1344143396893233152',
                                    description: 'من أجل تحديد منصة البحث والتشغيل الأساسية، يوتيوب',
                                    value: 'YouTube',
                                }, {
                                    label: 'ساندكلاود',
                                    emoji: '1344143819276292247',
                                    description: 'من أجل تحديد منصة البحث والتشغيل الأساسية، ساندكلاود',
                                    value: 'SoundCloud',
                                }
                            ]);

                        const cancelButton = new ButtonBuilder()
                            .setCustomId('cancel')
                            .setLabel('إلغاء')
                            .setStyle('Danger');

                        const replyMessage = await interaction.update({
                            content: `**أخـتـر الأمـر.**`,
                            components: [
                                new ActionRowBuilder().addComponents(selectMenu),
                                new ActionRowBuilder().addComponents(cancelButton)
                            ]
                        });

                                                const filter = (i) => i.user.id === message.author.id;
                                                const collector = replyMessage.createMessageComponentCollector({ filter, time: 60000 });

                                                collector.on('collect', async (interaction) => {
                                                        // زر الإلغاء
                                                        if (interaction.isButton() && interaction.customId === 'cancel') {
                                                                await interaction.deferUpdate().catch(() => {});
                                                                await interaction.message.delete().catch(() => {});
                                                                collector.stop('cancel');
                                                                return;
                                                        }

                                                        if (!interaction.isStringSelectMenu() || interaction.customId !== 'vipOptions') return;
                                                        const selectedOption = interaction.values[0];
                            if (selectedOption === 'YouTube') {
                                const lastClaimTime = await db.get(`YouTubeeditbuttons_${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete();
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                await interaction.deferUpdate();

                                const currentTokenData = tokens.filter(token => token.client === userId);
                                currentTokenData.forEach(tokenData => {
                                    tokenData.source = "ytsearch";
                                });

                                const disabledComponents = interaction.message.components.map(row => {
                                    return new ActionRowBuilder().addComponents(
                                        row.components.map(component => {
                                            if (component.type === ComponentType.Button) {
                                                return ButtonBuilder.from(component).setDisabled(true);
                                            } else if (component.type === ComponentType.StringSelect) {
                                                return StringSelectMenuBuilder.from(component).setDisabled(true);
                                            } else {
                                                return component;
                                            }
                                        })
                                    );
                                });

                                try {
                                    store.set('tokens', tokens);
                                    const botCount = currentTokenData.length;
                                    db.set(`YouTubeeditbuttons_${message.author.id}`, currentTime);
                                    await interaction.followUp({ content: `تم تعيين منصة التشغيل الأساسية لجميع البوتات إلى يوتيوب، البوتات المتأثرة : **${botCount}**` });
                                    interaction.editReply({ components: disabledComponents });
                                } catch (error) {
                                    console.error('حدث خطأ أثناء تحديث ملف التوكنات:', error);
                                    interaction.followUp({ content: `\`\`\`.حدث خطأ، يرجى التواصل مع الدعم الفني\`\`\``, components: [] });
                                    interaction.editReply({ components: disabledComponents });
                                }

                            } else if (selectedOption === 'SoundCloud') {

                                const lastClaimTime = await db.get(`soundcloudeditbuttons_${message.author.id}`) || 0;
                                const currentTime = Date.now();
                                const timeDifference = currentTime - lastClaimTime;

                                if (timeDifference < 240000) {
                                    const remainingTime = 240000 - timeDifference;
                                    const minutes = Math.floor(remainingTime / (1000 * 60));
                                    const seconds = Math.ceil((remainingTime % (1000 * 60)) / 1000);

                                    const formattedTime = `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

                                    if (!interaction.replied && !interaction.deferred) {
                                        interaction.message.delete();
                                        return message.reply({ content: `⌛ يجب أن تنتظر ${formattedTime} قبل إستخدام هذا الأمر مرة أخرى` });
                                    }
                                    return;
                                }

                                await interaction.deferUpdate();

                                const currentTokenData = tokens.filter(token => token.client === userId);
                                currentTokenData.forEach(tokenData => {
                                    tokenData.source = "scsearch";
                                });

                                const disabledComponents = interaction.message.components.map(row => {
                                    return new ActionRowBuilder().addComponents(
                                        row.components.map(component => {
                                            if (component.type === ComponentType.Button) {
                                                return ButtonBuilder.from(component).setDisabled(true);
                                            } else if (component.type === ComponentType.StringSelect) {
                                                return StringSelectMenuBuilder.from(component).setDisabled(true);
                                            } else {
                                                return component;
                                            }
                                        })
                                    );
                                });

                                try {
                                    store.set('tokens', tokens);
                                    const botCount = currentTokenData.length;
                                    db.set(`soundcloudeditbuttons_${message.author.id}`, currentTime);
                                    await interaction.followUp({ content: `تم تعيين منصة التشغيل الأساسية لجميع البوتات إلى ساندكلاود، البوتات المتأثرة : **${botCount}**` });
                                    interaction.editReply({ components: disabledComponents });
                                } catch (error) {
                                    console.error('حدث خطأ أثناء تحديث ملف التوكنات:', error);
                                    interaction.followUp({ content: `\`\`\`.حدث خطأ، يرجى التواصل مع الدعم الفني\`\`\``, components: [] });
                                    interaction.editReply({ components: disabledComponents });
                                }
                            }

                        });
                    }
                });
            }
        });
    }
};
