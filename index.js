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
    Options,
    WebSocketShardStatus
} = require('discord.js');

const fs = require('fs');
const store = require('./utils/store');
const config = require(`${process.cwd()}/config`);
const { getEmbedColor, refreshEmbedColor } = require('./utils/embedColor');
const { liftDiscordClientLimits } = require('./utils/discordClientTuning');

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
liftDiscordClientLimits(client);

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
try {
    const subs = require('./commands/Subscriptions/subs');
    subs.installSubsPanelHandler?.(client);
} catch (err) {
    console.log('[Subs] failed to install panel handler:', err?.message || err);
}
require('./music.js');
require('./manager.js');


    client.on('error', error => console.log(error))
      .on('warn', info => console.log(info))
      .on('disconnecting', () => console.log("Bot is disconnecting...", "warn"))
      .on('reconnecting', () => console.log("Bot reconnecting...", "log"));

    process.on('unhandledRejection', reason => {
      console.log(reason.stack ? reason.stack : reason);
    })
      .on('uncaughtException', (err) => {
        console.log(err.stack ? err.stack : err);
      })
      .on('uncaughtExceptionMonitor', (err) => {
        console.log(err.stack ? err.stack : err);
      });

// ── F: Graceful shutdown — handle SIGTERM cleanly ────────────────────────────
process.on('SIGTERM', async () => {
    console.log('[Shutdown] SIGTERM received — starting graceful shutdown');
    try {
        const { runningBots: subBots } = require('./music');
        const shutdownTasks = [];
        for (const [, bot] of subBots) {
            shutdownTasks.push((async () => {
                try {
                    if (bot.poru?.players) {
                        for (const [, player] of bot.poru.players) {
                            try {
                                const msg = player.data?.nowPlayingMessage;
                                if (msg && typeof msg.edit === 'function') {
                                    await msg.edit({ components: [] }).catch(() => {});
                                }
                                if (player.data?.progressInterval) {
                                    clearInterval(player.data.progressInterval);
                                    player.data.progressInterval = null;
                                }
                            } catch {}
                        }
                    }
                    await bot.destroy().catch(() => {});
                } catch {}
            })());
        }
        await Promise.allSettled(shutdownTasks);
        console.log('[Shutdown] All bots destroyed cleanly');
    } catch (e) {
        console.error('[Shutdown] error during graceful shutdown:', e?.message || e);
    }
    process.exit(0);
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Keep-Alive: zombie-connection detection & auto-reconnect ─────────────────
// Tracks the last time any Discord gateway event was received.
// If no event arrives for ZOMBIE_THRESHOLD_MS, the WebSocket is considered
// dead and a forced reconnect is triggered.
let lastGatewayEventAt = Date.now();
const ZOMBIE_THRESHOLD_MS = Math.max(15 * 60 * 1000, Number(process.env.DISCORD_ZOMBIE_THRESHOLD_MS || 15 * 60 * 1000)); // quiet servers can have no dispatches for minutes

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

    const wsPing = client.ws?.ping ?? -1;
    const hasDeadShard = [...(client.ws?.shards?.values?.() || [])].some(shard => {
        if (!shard) return false;
        // discord.js v14: Ready = 3, Idle = 0. Treat only Ready as healthy;
        // an Idle/Connecting/Resuming shard with ping -1 is a dead shard even
        // when other shards keep the aggregate client.ws.ping healthy.
        return shard.status !== WebSocketShardStatus.Ready && shard.ping === -1;
    });
    if (wsPing !== -1 && !hasDeadShard) return;

    isReconnecting = true;
    console.log(`[KeepAlive] Discord gateway appears dead for ${Math.floor(elapsed / 1000)}s (ping=${wsPing}) — forcing reconnect`);

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
    
    let _cachedAutoSettings = null;
    let _cachedAutoSettingsAt = 0;
    function readAutomaticSettings() {
      try {
        const now = Date.now();
        if (_cachedAutoSettings && now - _cachedAutoSettingsAt < 5 * 60 * 1000) return _cachedAutoSettings;
        const file = './settings/automatic.json';
        if (!fs.existsSync(file)) { _cachedAutoSettings = {}; _cachedAutoSettingsAt = now; return {}; }
        _cachedAutoSettings = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        _cachedAutoSettingsAt = now;
        return _cachedAutoSettings;
      } catch { return _cachedAutoSettings || {}; }
    }

    async function checkSubscriptions() {
      const logsArray = store.get('time') || [];
      const automaticSettings = readAutomaticSettings();
      const automaticLink = automaticSettings.panelUrl
        || (automaticSettings.panelGuildId && automaticSettings.panelChannelId && automaticSettings.panelMessageId
          ? `https://discord.com/channels/${automaticSettings.panelGuildId}/${automaticSettings.panelChannelId}/${automaticSettings.panelMessageId}`
          : null);
    
      const logChannel = client.channels.cache.find(channel => channel.id === logChannelId);

      // ── #8: Pre-fetch all unique user IDs in parallel before the loop ────────
      const now = Date.now();
      const relevantIds = [...new Set(logsArray
        .filter(l => !l.pausedAt && (
          l.expirationTime - now <= 0 ||
          (l.expirationTime - now <= 3 * 24 * 60 * 60 * 1000 && !l.threeDayNoticeSentAt)
        ))
        .map(l => l.user)
        .filter(id => id && !client.users.cache.has(id))
      )];
      if (relevantIds.length) {
        await Promise.allSettled(relevantIds.map(id => client.users.fetch(id).catch(() => null)));
      }
      // ─────────────────────────────────────────────────────────────────────────

      for (let index = logsArray.length - 1; index >= 0; index--) {
        const log = logsArray[index];
        if (log.pausedAt) continue;
        const remainingTime = log.expirationTime - Date.now();
        const getUser = () => client.users.cache.get(log.user) || null;

        if (remainingTime > 0 && remainingTime <= 3 * 24 * 60 * 60 * 1000 && !log.threeDayNoticeSentAt) {
          const user = getUser();
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
          const user = getUser();
          
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
