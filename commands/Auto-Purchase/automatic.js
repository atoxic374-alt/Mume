const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { owners } = require(`${process.cwd()}/settings/config`);
const fs = require('fs');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');

module.exports = {
  name: "automatic",
  aliases: ["ظبط"],
  description: "لوحة الشراء التلقائي",
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;
    if (!check(message.author.id, 'automatic')) return;

    try {
      const botsStock = store.get('bots') || [];
      const activeSubs = store.get('tokens') || [];

      const embed = new EmbedBuilder()
        .setTitle("نظام الموسيقى - Mume")
        .setDescription("مرحباً بك في لوحة التحكم الخاصة بنظام الموسيقى. يمكنك من خلال الأزرار أدناه شراء اشتراك جديد أو تجديد اشتراكك الحالي.")
        .addFields(
          { name: "المخزون المتوفر", value: `\`${botsStock.length}\` بوت`, inline: true },
          { name: "الاشتراكات النشطة", value: `\`${activeSubs.length}\` اشتراك`, inline: true }
        )
        .setColor(getEmbedColor(client))
        .setFooter({ text: "Mume Music System", iconURL: client.user.displayAvatarURL() });

      const buying = new ButtonBuilder()
        .setCustomId("SelectBots")
        .setLabel("شراء")
        .setEmoji("1368430934180761730")
        .setStyle(ButtonStyle.Secondary);

      const renewal = new ButtonBuilder()
        .setCustomId("renewal")
        .setLabel("تجديد")
        .setEmoji("1352113229803028551")
        .setStyle(ButtonStyle.Secondary);

      const mySub = new ButtonBuilder()
        .setCustomId("my_subscription_summary")
        .setLabel("اشتراكي")
        .setEmoji("📋")
        .setStyle(ButtonStyle.Primary);

      const row1 = new ActionRowBuilder().addComponents(buying, renewal, mySub);

      const components = [row1];

      if (owners.includes(message.author.id)) {
        const allSubs = new ButtonBuilder()
          .setCustomId("view_all_subs_admin")
          .setLabel("جميع الاشتراكات")
          .setEmoji("📚")
          .setStyle(ButtonStyle.Danger);

        const stock = new ButtonBuilder()
          .setCustomId("view_stock_admin")
          .setLabel("المخزون")
          .setEmoji("📦")
          .setStyle(ButtonStyle.Danger);

        const row2 = new ActionRowBuilder().addComponents(allSubs, stock);
        components.push(row2);
      }

      const options = {
        embeds: [embed],
        components: components,
      };

      if (fs.existsSync(`${process.cwd()}/assets/image/Auto.png`)) {
        options.files = ["assets/image/Auto.png"];
      }

      await message.channel.send(options);
    } catch (error) {
      console.error(error);
      await message.reply("حدث خطأ أثناء تنفيذ الأمر.");
    }
  },
};
