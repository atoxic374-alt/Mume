const store = require('../../utils/store');
const { owners, emco, logChannelId, prefix, Services, price } = require('../../config');
const { EmbedBuilder } = require('discord.js'); 
const { applyProfileToToken, getSubBotProfile } = require('../../utils/subBotProfile');
const { getEmbedColor } = require('../../utils/embedColor');

module.exports = {
    name: 'musicrestart',
    aliases: ["musicrestart"],
    async execute(client, message, args) {
        if (!owners.includes(message.author.id)) return;

        try {
            const allBots = store.get('bots') || [];
            const activeSubs = new Set((store.get('tokens') || []).map(t => t.token));
            const botsArray = allBots.filter(b => !activeSubs.has(b.token));
            const skipped = allBots.length - botsArray.length;
	
	            if (botsArray.length === 0) {
	                return message.reply({
	                    embeds: [new EmbedBuilder()
	                        .setTitle('Restart Stock Bots')
	                        .setDescription(`لا توجد بوتات حرة في الستوك حالياً.${skipped > 0 ? `\n\nتم تجاهل \`${skipped}\` بوت لأنها ضمن اشتراكات نشطة.` : ''}`)
	                        .setColor(getEmbedColor(client))]
	                });
	            }

            let totalBots = botsArray.length;
            let timePerBot = 5000; 
            let estimatedTimeInSeconds = (totalBots * timePerBot) / 1000;
            let estimatedMinutes = Math.floor(estimatedTimeInSeconds / 60);
            let estimatedSeconds = Math.round(estimatedTimeInSeconds % 60);

	            message.reply({
	                embeds: [new EmbedBuilder()
	                    .setTitle('Restart Stock Bots')
	                    .setDescription('جاري إعادة تهيئة البوتات الحرة في الستوك وتطبيق إعدادات الاسم والصورة والبنر.')
	                    .addFields(
	                        { name: 'Stock Bots', value: `\`${totalBots}\``, inline: true },
	                        { name: 'Estimated Time', value: `\`${estimatedMinutes}:${estimatedSeconds < 10 ? '0' : ''}${estimatedSeconds}\` دقيقة`, inline: true },
	                        { name: 'Skipped Active Bots', value: `\`${skipped}\``, inline: true }
	                    )
	                    .setColor(getEmbedColor(client))]
	            });

            const profile = getSubBotProfile();
            for (const bot of botsArray) {
                const token = bot.token;

                try {
                    await applyProfileToToken(token, { profile, leaveGuilds: true });

                } catch (error) {
                    console.error(`Error setting avatar or banner for bot with token ${token}:`, error);
                    continue;
                }
            }
	        } catch (error) {
	            console.error('Error reading bots data:', error);
	            message.reply({
	                embeds: [new EmbedBuilder()
	                    .setTitle('Restart Failed')
	                    .setDescription('حدث خطأ أثناء معالجة الأمر.')
	                    .setColor(getEmbedColor(client))]
	            });
	        }
    }
};
