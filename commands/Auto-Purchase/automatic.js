const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { owners, Colors } = require(`${process.cwd()}/settings/config`);
const fs = require('fs');

module.exports = {
  name: "automatic",
  aliases: ["ظبط"],
  description: "لوحة الشراء التلقائي",
  async execute(client, message, args) {
    if (!owners.includes(message.author.id)) return;

    try {
      const botsStock = JSON.parse(fs.readFileSync(`${process.cwd()}/settings/bots.json`, 'utf8'));
      const activeSubs = JSON.parse(fs.readFileSync(`${process.cwd()}/settings/tokens.json`, 'utf8'));

      const embed = new EmbedBuilder()
        .setTitle("نظام الموسيقى - Mume")
        .setDescription("مرحباً بك في لوحة التحكم الخاصة بنظام الموسيقى. يمكنك من خلال الأزرار أدناه شراء اشتراك جديد أو تجديد اشتراكك الحالي.")
        .addFields(
          { name: "المخزون المتوفر", value: `\`${botsStock.length}\` بوت`, inline: true },
          { name: "الاشتراكات النشطة", value: `\`${activeSubs.length}\` اشتراك`, inline: true }
        )
        .setColor(Colors)
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

      if (fs.existsSync(`${process.cwd()}/settings/image/Auto.png`)) {
        options.files = ["settings/image/Auto.png"];
      }

      await message.channel.send(options);
    } catch (error) {
      console.error(error);
      await message.reply("حدث خطأ أثناء تنفيذ الأمر.");
    }
  },
};
