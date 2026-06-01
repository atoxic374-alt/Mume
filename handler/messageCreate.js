// messageCreate.js
const client = require('../index');
const { prefix } = require('../settings/config');
const { check } = require('../utils/rateLimit');


client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    let content = message.content;
    const botMention1 = `<@${client.user?.id}>`;
    const botMention2 = `<@!${client.user?.id}>`;

    if (content.startsWith(botMention1))      content = content.slice(botMention1.length).trimStart();
    else if (content.startsWith(botMention2)) content = content.slice(botMention2.length).trimStart();
    else if (content.toLowerCase().startsWith(prefix.toLowerCase())) content = content.slice(prefix.length);
    else return;

    if (!content.trim()) return;

    const [cmd, ...args] = content.trim().split(/ +/g);
    const command = client.commands.get(cmd.toLowerCase())
                 || client.commands.find(c => c.aliases?.includes(cmd.toLowerCase()));

    if (!command) return;

    // Rate limit: 1.5s per user per command
    if (!check(message.author.id, cmd.toLowerCase())) return;

    try {
        await command.execute(client, message, args);
    } catch (e) {
        console.error(`[cmd:${cmd}]`, e.message);
    }
});
