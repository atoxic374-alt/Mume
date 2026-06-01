// messageCreate.js
const client = require('../index');
const { prefix } = require('../settings/config');


client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    let usedPrefix = prefix;
    const mentionPrefix = `<@${client.user.id}>`;
    const mentionPrefixNickname = `<@!${client.user.id}>`;

    if (message.content.startsWith(mentionPrefix)) {
        usedPrefix = mentionPrefix;
    } else if (message.content.startsWith(mentionPrefixNickname)) {
        usedPrefix = mentionPrefixNickname;
    } else if (!message.content.toLowerCase().startsWith(prefix.toLowerCase())) {
        return;
    }

    const [cmd, ...args] = message.content
        .slice(usedPrefix.length)
        .trim()
        .split(/ +/g);

    if (!cmd) return;

    const command = client.commands.get(cmd.toLowerCase()) || client.commands.find(c => c.aliases?.includes(cmd.toLowerCase()));

    if (!command) return;
    await command.execute(client, message, args);
});
