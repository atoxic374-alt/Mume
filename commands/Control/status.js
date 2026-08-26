const { ActivityType, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { owners, TwitchUrl } = require('../../config');
const { getEmbedColor } = require('../../utils/embedColor');

function isMainOwner(id) {
    return (owners || []).map(String).includes(String(id));
}

function streamUrl() {
    const raw = Array.isArray(TwitchUrl) ? TwitchUrl[0] : TwitchUrl;
    const value = String(raw || '').trim();
    if (/^https?:\/\//i.test(value)) return value;
    return `https://twitch.tv/${value || 'Tnbeh'}`;
}

function persistStatus(text) {
    if (process.env.STATUSES) return false;
    const configPath = path.join(process.cwd(), 'settings', 'config.json');
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.statuses = [text];
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    name: 'status',
    aliases: ['setstatus', 'setstreaming', 'streaming', 'ste', 'ستريمنج'],
    async execute(client, message, args) {
        if (!isMainOwner(message.author.id)) return;

        const text = args.join(' ').trim();
        if (!text) {
            return message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(getEmbedColor(client))
                        .setTitle('Status Command')
                        .setDescription('**Usage :** *`status <status text>`*\n\n**Access :** *main bot owners from config only.*'),
                ],
            }).catch(() => {});
        }

        await client.user.setPresence({
            activities: [{ name: text.slice(0, 128), type: ActivityType.Streaming, url: streamUrl() }],
            status: 'online',
        });
        const persisted = persistStatus(text.slice(0, 128));

        return message.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(getEmbedColor(client))
                    .setTitle('Status Updated')
                    .setDescription([
                        `**Bot :** *${client.user.username}*`,
                        '',
                        `**Status :** *${text.slice(0, 128)}*`,
                        '',
                        `**Saved :** *${persisted ? 'Yes' : 'Runtime only'}*`,
                        '',
                        '**Result :** *تم تحديث حالة البوت الأساسي بنجاح.*',
                    ].join('\n'))
                    .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 })),
            ],
        }).catch(() => {});
    },
};
