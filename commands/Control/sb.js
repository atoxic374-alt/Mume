const { EmbedBuilder } = require('discord.js');
const { owners } = require('../../config');
const { getEmbedColor } = require('../../utils/embedColor');

function isMainOwner(id) {
    return (owners || []).map(String).includes(String(id));
}

module.exports = {
    name: 'sb',
    aliases: ['setbanner', 'banner', 'بنر'],
    async execute(client, message, args) {
        if (!isMainOwner(message.author.id)) return;

        const imageUrl = message.attachments.first()?.url || args[0];
        if (!imageUrl) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Set Banner')
                        .setDescription('**Usage :** *`sb <image url>`* أو أرفق صورة مع الأمر.\n\n**Access :** *main bot owners from config only.*'),
                ],
            }).catch(() => {});
        }

        try {
            await client.user.setBanner(imageUrl);
        } catch (error) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Banner Update Failed')
                        .setDescription([
                            '**Image :** *Discord rejected the banner update.*',
                            '',
                            `**Reason :** *${error?.message || 'Unknown error'}*`,
                        ].join('\n')),
                ],
            }).catch(() => {});
        }

        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(getEmbedColor(client))
                    .setTitle('Banner Updated')
                    .setDescription([
                        `**Bot :** *${client.user.username}*`,
                        '',
                        '**Result :** *تم تحديث بنر البوت الأساسي بنجاح.*',
                    ].join('\n'))
                    .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 })),
            ],
        }).catch(() => {});
    },
};
