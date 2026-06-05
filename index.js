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
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
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
        GatewayIntentBits.DirectMessages,
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
try {
    const automatic = require('./commands/Auto-Purchase/automatic');
    automatic.installAutomaticHandlers?.(client);
} catch (err) {
    console.log('[Automatic] failed to install handlers:', err?.message || err);
}
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

// ── Keep-Alive: zombie-connection detection & auto-reconnect ─────────────────
// Tracks the last time any Discord gateway event was received.
// If no event arrives for ZOMBIE_THRESHOLD_MS, the WebSocket is considered
// dead and a forced reconnect is triggered.
let lastGatewayEventAt = Date.now();
const ZOMBIE_THRESHOLD_MS = 4 * 60 * 1000; // 4 minutes without any event = zombie

// Update the timestamp on ANY raw packet received from the gateway
client.on('raw', () => {
    lastGatewayEventAt = Date.now();
});

// Also update on high-level events as a secondary signal
client.on('messageCreate', () => { lastGatewayEventAt = Date.now(); });
client.on('interactionCreate', () => { lastGatewayEventAt = Date.now(); });
client.on('voiceStateUpdate', () => { lastGatewayEventAt = Date.now(); });

let isReconnecting = false;

async function zombieCheck() {
    if (!client.readyAt) return; // not logged in yet
    if (isReconnecting) return;

    const elapsed = Date.now() - lastGatewayEventAt;
    if (elapsed < ZOMBIE_THRESHOLD_MS) return;

    isReconnecting = true;
    console.log(`[KeepAlive] No gateway events for ${Math.floor(elapsed / 1000)}s — forcing reconnect`);

    try {
        // Try soft WS reconnect first (all shards)
        if (client.ws?.shards?.size > 0) {
            client.ws.shards.forEach(shard => {
                try { shard.destroy({ recover: true }); } catch {}
            });
        } else {
            // Fallback: full destroy + re-login
            await client.destroy().catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
            await client.login(Token).catch(e => console.log('[KeepAlive] Re-login failed:', e?.message));
        }
        lastGatewayEventAt = Date.now();
    } catch (e) {
        console.log('[KeepAlive] Reconnect error:', e?.message);
    } finally {
        isReconnecting = false;
    }
}

// Check every 2 minutes
setInterval(zombieCheck, 2 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

client.once('clientReady', () => {
    lastGatewayEventAt = Date.now(); // reset on ready
    refreshEmbedColor(client).catch(() => {});
    const { checkAndReplaceTokens } = require('./tokenHealthChecker');
    setTimeout(() => checkAndReplaceTokens(client), 15000);
    setInterval(() => checkAndReplaceTokens(client), 30 * 60 * 1000);
    setInterval(() => checkSubscriptions().catch(error => console.error('[subscriptions]', error)), 30000);
    });
    
    async function checkSubscriptions() {
      const logsArray = store.get('time') || [];
      const readAutomaticSettings = () => {
        try {
          const file = './settings/automatic.json';
          if (!fs.existsSync(file)) return {};
          return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        } catch {
          return {};
        }
      };
      const automaticSettings = readAutomaticSettings();
      const automaticLink = automaticSettings.panelUrl
        || (automaticSettings.panelGuildId && automaticSettings.panelChannelId && automaticSettings.panelMessageId
          ? `https://discord.com/channels/${automaticSettings.panelGuildId}/${automaticSettings.panelChannelId}/${automaticSettings.panelMessageId}`
          : null);
    
      const logChannel = client.channels.cache.find(channel => channel.id === logChannelId);
    
      for (let index = logsArray.length - 1; index >= 0; index--) {
        const log = logsArray[index];
        if (log.pausedAt) continue;
        const remainingTime = log.expirationTime - Date.now();
        let fetchedUser = null;
        const getUser = async () => {
          if (fetchedUser) return fetchedUser;
          fetchedUser = client.users.cache.get(log.user) || await client.users.fetch(log.user).catch(() => null);
          return fetchedUser;
        };

        if (remainingTime > 0 && remainingTime <= 3 * 24 * 60 * 60 * 1000 && !log.threeDayNoticeSentAt) {
          const user = await getUser();
          if (user) {
            const noticeEmbed = new EmbedBuilder()
              .setTitle('Subscription Expiry Notice')
              .setDescription([
                `**Subscription :** *\`${log.code}\`*`,
                '',
                `**Bot Count :** *\`${log.botsCount}\` بوت داخل الاشتراك*`,
                '',
                `**Expires :** *<t:${Math.floor(log.expirationTime / 1000)}:R>*`,
                '',
                automaticLink
                  ? '**Renewal :** *افتح لوحة الأوتوماتك واضغط زر Renew.*'
                  : '**Renewal :** *افتح روم الأوتوماتك واضغط زر Renew.*',
              ].join('\n'))
              .setColor(getEmbedColor(client));
            const components = automaticLink
              ? [new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setLabel('Open Renewal Panel')
                    .setStyle(ButtonStyle.Link)
                    .setURL(automaticLink),
                )]
              : [];
            user.send({ embeds: [noticeEmbed], components }).catch(() => {});
            log.threeDayNoticeSentAt = Date.now();
          }
        }
        if (remainingTime <= 0) {
          const user = await getUser();
          
          if (user) {
            const userembed = new EmbedBuilder()
            .setTitle("Subscription Expired")
            .setThumbnail("https://cdn.discordapp.com/attachments/1091536665912299530/1316233635464220803/512-512-max.png?ex=675a4d99&is=6758fc19&hm=352d005827ec0252e09be31a939f3c2f1abb3c8a0d660f20012ac80a2bc62b12&")
            .setDescription(`**User :** *<@${user.id}>*\n\n**Subscription :** *\`Music x${log.botsCount}\` \`SuID ${log.code}\`*\n\n**Ended At :** *\`${new Date(log.expirationTime).toLocaleString()}\`*`)
            .setColor(getEmbedColor(client));
            
               user.send({ content: `> <@${user.id}>`, embeds: [userembed] })
              .catch(error => console.error(`Could not send DM to ${user.tag}.\n`, error)); 
                  
    
            const embed = new EmbedBuilder()
            .setTitle("Subscription Expired")
            .setThumbnail("https://cdn.discordapp.com/attachments/1091536665912299530/1316233635464220803/512-512-max.png?ex=675a4d99&is=6758fc19&hm=352d005827ec0252e09be31a939f3c2f1abb3c8a0d660f20012ac80a2bc62b12&")
            .setDescription(`**User :** *<@${user.id}>*\n\n**Subscription :** *\`Music x${log.botsCount}\` \`SuID ${log.code}\`*\n\n**Ended At :** *\`${new Date(log.expirationTime).toLocaleString()}\`*`)
            .setColor(getEmbedColor(client));
            
            if (logChannel) logChannel.send({ content: "**Subscription :** *تم حذف اشتراك العميل بعد انتهاء المدة.*", embeds: [embed] });
             
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
      }
      store.set('time', logsArray);
    }


client.login(Token);
