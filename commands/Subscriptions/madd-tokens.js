const store = require('../../utils/store');

const { owners } = require('../../config');
const { EmbedBuilder } = require('discord.js');
const {
  applyProfileToToken,
  getSubBotProfile,
  resolveProfileAssets,
} = require('../../utils/subBotProfile');
const { getEmbedColor } = require('../../utils/embedColor');

module.exports = {
  name: 'musicaddtokens',
  aliases: ["madd-tokens"],
  async execute(client, message) {
    if (!owners.includes(message.author.id)) return;

	    if (message.author.bot) return;
	
	    const args = message.content.split(' ');
	    args.shift();
	    const tokenValues = args;
	
	    if (tokenValues.length === 0) {
	      return message.reply({
	        embeds: [new EmbedBuilder()
	          .setTitle('Add Bot Tokens')
	          .setDescription('يرجى كتابة التوكنات بعد الأمر، ويمكن وضع أكثر من توكن مفصول بمسافة.')
	          .setColor(getEmbedColor(client))]
	      });
	    }
	
	    const validTokens = [];
	    const duplicateTokens = [];
	    const invalidTokens = [];
	    const known = new Set([
      ...((store.get('bots') || []).map(b => b.token)),
      ...((store.get('tokens') || []).map(t => t.token)),
    ].filter(Boolean));
    const profile = getSubBotProfile();
    let assets = null;
    try {
      assets = await resolveProfileAssets(profile);
    } catch {
      assets = { avatarData: null, bannerData: null };
    }

	    for (const tokenValue of tokenValues) {
	      const maskedToken = `...${String(tokenValue).slice(-6)}`;
	      if (known.has(tokenValue)) {
	        duplicateTokens.push(maskedToken);
	        continue;
	      }
	      try {
	        await applyProfileToToken(tokenValue, { profile, assets, leaveGuilds: true });
	        validTokens.push(tokenValue);
	        known.add(tokenValue);
	      } catch (error) {
	        if (error.message === 'TOKEN_INVALID') {
	          console.error(`Invalid token > ${maskedToken}`);
	          invalidTokens.push(maskedToken);
	        } else {
	          console.error(`Token check failed > ${maskedToken}`, error.message);
	          invalidTokens.push(maskedToken);
	        }
	      }
	    }

    if (validTokens.length > 0) {
      let bots = [...(store.get('bots') || [])];

      for (const tokenValue of validTokens) {
        const tokenExists = bots.some(bot => bot.token === tokenValue);
        if (!tokenExists) {
          bots.push({ token: tokenValue });
        }
	      }
	      store.set('bots', bots);
	    }

	    const fields = [
	      { name: 'Checked Tokens', value: `\`${tokenValues.length}\``, inline: true },
	      { name: 'Added', value: `\`${validTokens.length}\``, inline: true },
	      { name: 'Duplicates', value: `\`${duplicateTokens.length}\``, inline: true },
	      { name: 'Failed', value: `\`${invalidTokens.length}\``, inline: true },
	    ];
	    if (duplicateTokens.length) {
	      fields.push({ name: 'Duplicate Tokens', value: duplicateTokens.slice(0, 10).map(t => `\`${t}\``).join('\n'), inline: true });
	    }
	    if (invalidTokens.length) {
	      fields.push({ name: 'Failed Tokens', value: invalidTokens.slice(0, 10).map(t => `\`${t}\``).join('\n'), inline: true });
	    }
	    if (duplicateTokens.length > 10 || invalidTokens.length > 10) {
	      fields.push({ name: 'Hidden Results', value: `تم إخفاء النتائج الإضافية للحفاظ على ترتيب الرسالة.`, inline: false });
	    }

	    await message.channel.send({
	      embeds: [new EmbedBuilder()
	        .setTitle('Bot Tokens Processed')
	        .setDescription('تم فحص التوكنات وإضافة الصالح منها للستوك، مع تطبيق الاسم والصورة والبنر على البوت والـ App.')
	        .addFields(fields)
	        .setColor(getEmbedColor(client))]
	    });
	    await message.delete().catch(() => {});
	  }
	};
