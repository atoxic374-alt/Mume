const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Colors, owners, prefix } = require('../../settings/config');

module.exports = {
    name: 'help',
    aliases: ['مساعدة'],
    async execute(client, message, args) {
        const isOwner = owners.includes(message.author.id);

        const categories = [
            {
                name: '🎵 Control (User)',
                description: 'أوامر التحكم في الاشتراك الخاص بك',
                commands: [
                    { name: 'mu', aliases: ['vip'], description: 'لوحة تحكم الاشتراك الرئيسية' },
                    { name: 'mysub', aliases: ['اشتراك', 'my-sub'], description: 'عرض بيانات الاشتراك والوقت المتبقي' },
                    { name: 'settings', aliases: [], description: 'إعدادات الاشتراك (المظهر، المنصة، الغرف)' },
                    { name: 'help', aliases: ['مساعدة'], description: 'عرض هذه القائمة' }
                ]
            }
        ];

        if (isOwner) {
            categories.push({
                name: '👑 Subscriptions (Admin)',
                description: 'أوامر إدارة الاشتراكات (للملاك فقط)',
                commands: [
                    { name: 'madd-sub', aliases: [], description: 'إضافة اشتراك جديد لمستخدم' },
                    { name: 'mremove-sub', aliases: [], description: 'إزالة اشتراك موجود' },
                    { name: 'madd-time', aliases: [], description: 'إضافة وقت لاشتراك محدد' },
                    { name: 'musicallsub', aliases: [], description: 'عرض جميع الاشتراكات النشطة' },
                    { name: 'musicstock', aliases: [], description: 'عرض مخزون البوتات المتاحة' },
                    { name: 'madd-tokens', aliases: [], description: 'إضافة توكنات جديدة للمخزون' },
                    { name: 'musicrestart', aliases: [], description: 'إعادة تشغيل بوتات المخزون' }
                ]
            });
            categories.push({
                name: '🛒 Auto-Purchase (Admin)',
                description: 'أوامر الشراء التلقائي',
                commands: [
                    { name: 'automatic', aliases: [], description: 'إرسال لوحة الشراء والتجديد التلقائي' }
                ]
            });
        }

        const embeds = categories.map(cat => {
            const embed = new EmbedBuilder()
                .setTitle(cat.name)
                .setDescription(cat.description)
                .setColor(Colors)
                .setTimestamp()
                .setFooter({ text: `البرادئة: ${prefix} | المساعدة` });

            cat.commands.forEach(cmd => {
                const aliasList = cmd.aliases.length > 0 ? ` (${cmd.aliases.join(', ')})` : '';
                embed.addFields({ name: `${prefix}${cmd.name}${aliasList}`, value: cmd.description });
            });

            return embed;
        });

        if (embeds.length === 1) {
            return message.reply({ embeds: [embeds[0]] });
        }

        let currentPage = 0;
        const mid = message.id;

        const getButtons = (page) => {
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`prev_${mid}`)
                    .setLabel('السابق')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`next_${mid}`)
                    .setLabel('التالي')
                    .setEmoji('➡️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === embeds.length - 1)
            );
        };

        const msg = await message.reply({
            embeds: [embeds[currentPage]],
            components: [getButtons(currentPage)]
        });

        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === message.author.id,
            time: 300000
        });

        collector.on('collect', async (i) => {
            if (i.customId === `prev_${mid}`) {
                currentPage--;
            } else if (i.customId === `next_${mid}`) {
                currentPage++;
            }

            await i.update({
                embeds: [embeds[currentPage]],
                components: [getButtons(currentPage)]
            });
        });

        collector.on('end', () => {
            msg.edit({ components: [] }).catch(() => {});
        });
    }
};
