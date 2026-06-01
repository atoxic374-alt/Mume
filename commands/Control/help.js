const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Colors, owners, prefix } = require('../../config');
const store = require('../../utils/store');

// أوامر التشغيل الأساسية — تظهر لكل المستخدمين
const PLAY_COMMANDS = [
    { name: 'play',    aliases: ['p', 'شغل'],      description: 'تشغيل أغنية أو playlist من رابط أو بحث' },
    { name: 'skip',    aliases: ['s', 'تخطي'],     description: 'تخطي الأغنية الحالية' },
    { name: 'stop',    aliases: ['st', 'إيقاف'],   description: 'إيقاف التشغيل ومسح القائمة' },
    { name: 'pause',   aliases: ['pa', 'تعليق'],   description: 'تعليق / استئناف التشغيل' },
    { name: 'queue',   aliases: ['q', 'قائمة'],    description: 'عرض قائمة الانتظار' },
    { name: 'volume',  aliases: ['v', 'صوت'],      description: 'ضبط مستوى الصوت (1–100)' },
    { name: 'loop',    aliases: ['l', 'تكرار'],    description: 'تكرار الأغنية أو القائمة' },
    { name: 'shuffle', aliases: ['sh', 'خلط'],     description: 'خلط قائمة الانتظار عشوائياً' },
    { name: 'nowplaying', aliases: ['np', 'الآن'], description: 'عرض الأغنية الحالية' },
    { name: 'seek',    aliases: ['وقت'],           description: 'الانتقال لوقت محدد في الأغنية' },
    { name: 'remove',  aliases: ['rm', 'حذف'],    description: 'حذف أغنية محددة من القائمة' },
    { name: 'lyrics',  aliases: ['كلمات'],         description: 'عرض كلمات الأغنية الحالية' },
    { name: 'join',    aliases: ['انضم'],           description: 'يدخل البوت إلى الروم الصوتي' },
    { name: 'leave',   aliases: ['اخرج'],          description: 'يخرج البوت من الروم الصوتي' },
    { name: 'help',    aliases: ['مساعدة'],        description: 'عرض هذه القائمة' },
];

// أوامر الاشتراك — تظهر لمالكي الاشتراك فقط
const SUB_COMMANDS = [
    { name: 'settings',  aliases: ['إعدادات'],   description: 'لوحة الإعدادات الكاملة (مظهر، منصة، غرف)' },
    { name: 'mu',        aliases: ['vip'],        description: 'لوحة تحكم الاشتراك الرئيسية' },
    { name: 'mysub',     aliases: ['my-sub'],     description: 'عرض بيانات الاشتراك والوقت المتبقي' },
];

// أوامر الإدارة — للأونرز فقط (system owners)
const ADMIN_COMMANDS = [
    { name: 'madd-sub',      aliases: [], description: 'إضافة اشتراك جديد لمستخدم' },
    { name: 'mremove-sub',   aliases: [], description: 'إزالة اشتراك' },
    { name: 'madd-time',     aliases: [], description: 'إضافة وقت لاشتراك محدد' },
    { name: 'madd-tokens',   aliases: [], description: 'إضافة توكنات للمخزون' },
    { name: 'musicallsub',   aliases: [], description: 'عرض جميع الاشتراكات النشطة' },
    { name: 'musicstock',    aliases: [], description: 'عرض مخزون البوتات' },
    { name: 'musicrestart',  aliases: [], description: 'إعادة تشغيل بوتات المخزون' },
    { name: 'automatic',     aliases: [], description: 'لوحة الشراء والتجديد التلقائي' },
];

function buildCmdList(cmds) {
    return cmds.map(c => {
        const al = c.aliases.length ? ` *(${c.aliases.join(', ')})*` : '';
        return `\`${prefix}${c.name}\`${al} — ${c.description}`;
    }).join('\n');
}

module.exports = {
    name: 'help',
    aliases: ['مساعدة'],
    async execute(client, message, args) {
        const userId   = message.author.id;
        const isOwner  = owners.includes(userId);

        // فحص مالك اشتراك
        const tokens    = store.get('tokens') || [];
        const isSubOwner = !isOwner && tokens.some(t => t.owner === userId || t.user === userId);

        // ── رياكشن دائماً ──────────────────────────────────────────────
        message.react('🎵').catch(() => {});

        // ════════════════════════════════════════════════════════════════
        //  مستخدم عادي → DM أوامر التشغيل فقط
        // ════════════════════════════════════════════════════════════════
        if (!isOwner && !isSubOwner) {
            const embed = new EmbedBuilder()
                .setTitle('🎵 أوامر التشغيل')
                .setDescription(buildCmdList(PLAY_COMMANDS))
                .setColor(Colors)
                .setFooter({ text: `البادئة: ${prefix}  |  للمزيد تواصل مع مالك السيرفر` });

            return message.author.send({ embeds: [embed] })
                .then(() => message.reply({ content: '📨 تم إرسال الأوامر في الخاص.', allowedMentions: { repliedUser: false } }))
                .catch(() => message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }));
        }

        // ════════════════════════════════════════════════════════════════
        //  مالك اشتراك → أوامر التشغيل + أوامر الاشتراك (بدون إدارة)
        // ════════════════════════════════════════════════════════════════
        if (isSubOwner) {
            const pages = [
                new EmbedBuilder()
                    .setTitle('🎵 أوامر التشغيل')
                    .setDescription(buildCmdList(PLAY_COMMANDS))
                    .setColor(Colors)
                    .setFooter({ text: `صفحة 1 / 2  •  البادئة: ${prefix}` }),
                new EmbedBuilder()
                    .setTitle('⚙️ أوامر الاشتراك')
                    .setDescription(buildCmdList(SUB_COMMANDS))
                    .setColor(Colors)
                    .setFooter({ text: `صفحة 2 / 2  •  البادئة: ${prefix}` }),
            ];
            return sendPaged(message, pages);
        }

        // ════════════════════════════════════════════════════════════════
        //  أونر (system owner) → كل الأوامر بصفحات
        // ════════════════════════════════════════════════════════════════
        const pages = [
            new EmbedBuilder()
                .setTitle('🎵 أوامر التشغيل')
                .setDescription(buildCmdList(PLAY_COMMANDS))
                .setColor(Colors)
                .setFooter({ text: `صفحة 1 / 3  •  البادئة: ${prefix}` }),
            new EmbedBuilder()
                .setTitle('⚙️ أوامر الاشتراك')
                .setDescription(buildCmdList(SUB_COMMANDS))
                .setColor(Colors)
                .setFooter({ text: `صفحة 2 / 3  •  البادئة: ${prefix}` }),
            new EmbedBuilder()
                .setTitle('👑 أوامر الإدارة')
                .setDescription(buildCmdList(ADMIN_COMMANDS))
                .setColor(Colors)
                .setFooter({ text: `صفحة 3 / 3  •  للأونرز فقط` }),
        ];
        return sendPaged(message, pages);
    }
};

// ── دالة مشتركة للصفحات ────────────────────────────────────────────────────
async function sendPaged(message, pages) {
    let page = 0;
    const mid = message.id;

    const getRow = (p) => new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`help_prev_${mid}`)
            .setLabel('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(p === 0),
        new ButtonBuilder()
            .setCustomId(`help_next_${mid}`)
            .setLabel('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(p === pages.length - 1),
        new ButtonBuilder()
            .setCustomId(`help_close_${mid}`)
            .setLabel('✖ إغلاق')
            .setStyle(ButtonStyle.Danger)
    );

    const msg = await message.reply({
        embeds: [pages[page]],
        components: [getRow(page)],
        allowedMentions: { repliedUser: false }
    });

    const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === message.author.id && i.customId.endsWith(`_${mid}`),
        time: 300000
    });

    collector.on('collect', async i => {
        if (i.customId === `help_prev_${mid}`)  page--;
        if (i.customId === `help_next_${mid}`)  page++;
        if (i.customId === `help_close_${mid}`) return collector.stop('closed');

        await i.update({ embeds: [pages[page]], components: [getRow(page)] });
    });

    collector.on('end', (_, reason) => {
        msg.edit({ components: [] }).catch(() => {});
    });
}
