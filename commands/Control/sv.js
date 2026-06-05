const { EmbedBuilder } = require('discord.js');
const { owners } = require('../../config');
const { getEmbedColor, refreshEmbedColor } = require('../../utils/embedColor');

function isMainOwner(id) {
    return (owners || []).map(String).includes(String(id));
}

module.exports = {
    name: 'sv',
    aliases: ['setavatar', 'avatar', 'sa', 'صورة'],
    async execute(client, message, args) {
        if (!isMainOwner(message.author.id)) return;

        const imageUrl = message.attachments.first()?.url || args[0];
        if (!imageUrl) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Set Avatar')
                        .setDescription('**Usage :** *`sv <image url>`* أو أرفق صورة مع الأمر.\n\n**Access :** *main bot owners from config only.*'),
                ],
            }).catch(() => {});
        }

        try {
            await client.user.setAvatar(imageUrl);
            refreshEmbedColor(client).catch(() => {});
        } catch (error) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Avatar Update Failed')
                        .setDescription([
                            '**Image :** *Discord rejected the avatar update.*',
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
                    .setTitle('Avatar Updated')
                    .setDescription([
                        `**Bot :** *${client.user.username}*`,
                        '',
                        '**Result :** *تم تحديث صورة البوت الأساسي بنجاح.*',
                    ].join('\n'))
                    .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 })),
            ],
        }).catch(() => {});
    },
};
