const { EmbedBuilder } = require('discord.js');
const { owners } = require('../../config');
const { getEmbedColor } = require('../../utils/embedColor');

function isMainOwner(id) {
    return (owners || []).map(String).includes(String(id));
}

module.exports = {
    name: 'sn',
    aliases: ['setname', 'name', 'اسم'],
    async execute(client, message, args) {
        if (!isMainOwner(message.author.id)) return;

        const name = args.join(' ').trim();
        if (!name) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Set Name')
                        .setDescription('**Usage :** *`sn <new bot name>`*\n\n**Access :** *main bot owners from config only.*'),
                ],
            }).catch(() => {});
        }

        const oldName = client.user.username;

        try {
            await client.user.setUsername(name.slice(0, 32));
        } catch (error) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Name Update Failed')
                        .setDescription([
                            `**Requested :** *${name.slice(0, 32)}*`,
                            '',
                            `**Reason :** *${error?.message || 'Discord rejected the update.'}*`,
                        ].join('\n')),
                ],
            }).catch(() => {});
        }

        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(getEmbedColor(client))
                    .setTitle('Name Updated')
                    .setDescription([
                        `**Old Name :** *${oldName}*`,
                        '',
                        `**New Name :** *${client.user.username}*`,
                        '',
                        '**Result :** *تم تحديث اسم البوت الأساسي بنجاح.*',
                    ].join('\n'))
                    .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 })),
            ],
        }).catch(() => {});
    },
};
