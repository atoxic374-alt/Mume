// ── Boot Migration: must run before any other require ────────────────────────
require('./bootMigration');
// ─────────────────────────────────────────────────────────────────────────────

// Import necessary modules

// const { EventEmitter } = require('events');
// EventEmitter.defaultMaxListeners = 999999999999999;
require('events').defaultMaxListeners = 0;

const {
    Client,
    GatewayIntentBits,
    Collection,
    EmbedBuilder,
    Options
} = require('discord.js');

const fs = require('fs');
const store = require('./utils/store');
const config = require(`${process.cwd()}/config`);
const { getEmbedColor, refreshEmbedColor } = require('./utils/embedColor');

const { prefix, Token, logChannelId } = config;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: ['CHANNEL', 'MESSAGE', 'USER', 'GUILD_MEMBER'],
    allowedMentions: {
        parse: ['users'],
        repliedUser: true
    },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      ReactionManager: 0,
      GuildMemberManager: { maxSize: 200 },
      MessageManager: { maxSize: 20 },
      PresenceManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 120, lifetime: 300 },
    },
    ws: { compress: true },
    rest: { timeout: 15000, retries: 2 },
    failIfNotExists: false,
});

client.prefix = prefix;
module.exports = client;

client.commands = new Collection();
require("./handler/index.js")(client);
require('./music.js');
require('./manager.js');



    client.on('error', error => console.log(error))
      .on('warn', info => console.log(info))
      .on('disconnecting', () => console.log("Bot is disconnecting...", "warn"))
      .on('reconnecting', () => console.log("Bot reconnecting...", "log"))
      .on('error', e => console.log(e, "error"))
      .on('warn', info => console.log(info, "warn"));

    process.on('unhandledRejection', reason => {
      console.log(reason.stack ? reason.stack : reason);
    })
      .on('uncaughtException', (err) => {
        console.log(err.stack ? err.stack : err);
      })
      .on('uncaughtExceptionMonitor', (err) => {
        console.log(err.stack ? err.stack : err);
      });

client.once('ready', () => {
    refreshEmbedColor(client).catch(() => {});
    const { checkAndReplaceTokens } = require('./tokenHealthChecker');
    setTimeout(() => checkAndReplaceTokens(client), 15000);
    setInterval(() => checkAndReplaceTokens(client), 30 * 60 * 1000);
    setInterval(checkSubscriptions, 30000);
    });
    
    function checkSubscriptions() {
      const logsArray = store.get('time') || [];
    
      const logChannel = client.channels.cache.find(channel => channel.id === logChannelId);
    
      logsArray.forEach((log, index) => {
        const remainingTime = log.expirationTime - Date.now();
        if (remainingTime <= 0) {
          const user = client.users.cache.get(log.user);
          
          if (user) {
            const userembed = new EmbedBuilder()
            .setTitle("إشعار انتهى اشتراك! 🔔")
            .setThumbnail("https://cdn.discordapp.com/attachments/1091536665912299530/1316233635464220803/512-512-max.png?ex=675a4d99&is=6758fc19&hm=352d005827ec0252e09be31a939f3c2f1abb3c8a0d660f20012ac80a2bc62b12&")
            .setDescription(`> الإسم : <@${user.id}>\n> ألاشتراك : \`Music x${log.botsCount}\` \`(SuID ${log.code})\`\n> بدأ فيـ : \`${new Date(log.expirationTime).toLocaleString()}\``)
            .setColor(getEmbedColor(client));
            
               user.send({ content: `> <@${user.id}>`, embeds: [userembed] })
              .catch(error => console.error(`Could not send DM to ${user.tag}.\n`, error)); 
                  
    
            const embed = new EmbedBuilder()
            .setTitle("إشعار انتهى اشتراك! 🔔")
            .setThumbnail("https://cdn.discordapp.com/attachments/1091536665912299530/1316233635464220803/512-512-max.png?ex=675a4d99&is=6758fc19&hm=352d005827ec0252e09be31a939f3c2f1abb3c8a0d660f20012ac80a2bc62b12&")
            .setDescription(`> الإسم : <@${user.id}>\n> ألاشتراك : \`Music x${log.botsCount}\` \`(SuID ${log.code})\`\n> بدأ فيـ : \`${new Date(log.expirationTime).toLocaleString()}\``)
            .setColor(getEmbedColor(client));
            
            if (logChannel) logChannel.send({ content: "```العملية تمت بنجاح، وتم حذف أشتراك العميل.```", embeds: [embed] });
             
          }
    
          logsArray.splice(index, 1);
          const tokensArray = store.get('tokens') || [];
    
          const tokensToRemove = tokensArray.filter(tokenEntry => tokenEntry.code === log.code);
    
          const botsArray = store.get('bots') || [];
    
          tokensToRemove.forEach(tokenEntry => {
            botsArray.push({
              token: tokenEntry.token,
            });
          });
    
          store.set('bots', botsArray);
    
          const updatedTokensArray = tokensArray.filter(tokenEntry => !tokensToRemove.includes(tokenEntry));
          store.set('tokens', updatedTokensArray);
        }
      });
      store.set('time', logsArray);
    }


client.login(Token);
