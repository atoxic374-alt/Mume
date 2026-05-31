const fs = require('fs');
const { TwitchUrl, statuses } = require(`${process.cwd()}/settings/config`);
const store = require(`${process.cwd()}/statusStore`);

function formatRemaining(ms) {
  if (ms <= 0) return '🔴 Expired';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return '🟢 ' + ([d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '< 1m');
}

function printStatus() {
  let hostConfig = [], tokens = [], bots = [], timeData = [];
  try { hostConfig = JSON.parse(fs.readFileSync('./settings/host.json', 'utf8')); } catch { hostConfig = []; }
  try { tokens = JSON.parse(fs.readFileSync('./settings/tokens.json', 'utf8')); if (!Array.isArray(tokens)) tokens = []; } catch { tokens = []; }
  try { bots   = JSON.parse(fs.readFileSync('./settings/bots.json',   'utf8')); if (!Array.isArray(bots))   bots   = []; } catch { bots   = []; }
  try { timeData= JSON.parse(fs.readFileSync('./settings/time.json',  'utf8')); if (!Array.isArray(timeData)) timeData=[]; } catch { timeData=[]; }

  const W    = 54;
  const line = '─'.repeat(W);
  const now  = new Date().toLocaleString('en-GB', { hour12: false });

  console.log(`\n\x1b[36m╔${line}╗\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m  \x1b[1m📊 System Status\x1b[0m  \x1b[90m${now}\x1b[0m`);
  console.log(`\x1b[36m╚${line}╝\x1b[0m`);

  // ── Lavalink (من Poru مباشرة) ──────────────────────────────────
  console.log(`\n\x1b[33m  🎵 Lavalink Nodes\x1b[0m`);
  const liveNodes = store.getNodes();
  if (hostConfig.length === 0) {
    console.log(`\x1b[31m  ✖  No nodes in host.json\x1b[0m`);
  } else {
    const rows = {};
    for (const node of hostConfig) {
      const name = node.name || node.host || 'unknown';
      const live = liveNodes.get(name);
      rows[name] = {
        Host:   `${node.host}:${node.port}`,
        Status: live?.status === 'online'  ? '✅ Online'
               : live?.status === 'offline' ? '❌ Offline'
               : '⏳ Connecting…',
        Since:  live?.connectedAt
                  ? new Date(live.connectedAt).toLocaleTimeString('en-GB')
                  : '-',
        Reconnects: live?.reconnects ?? 0,
      };
    }
    console.table(rows);
  }

  // ── البوتات الفرعية ─────────────────────────────────────────────
  console.log(`\x1b[33m  🤖 Sub Bots\x1b[0m`);
  if (tokens.length === 0) {
    console.log(`\x1b[90m  —  No active sub-bots\x1b[0m`);
  } else {
    const rows = {};
    for (const t of tokens) {
      const exp       = timeData.find(d => d.code === t.code);
      const remaining = exp ? exp.expirationTime - Date.now() : null;
      rows[t.code]    = {
        Server:  t.Server || t.server || '-',
        VC:      t.channel ? '✅ Set' : '⚠️  Not Set',
        Expires: remaining === null ? '?' : formatRemaining(remaining),
      };
    }
    console.table(rows);
  }

  // ── المخزون والاشتراكات ─────────────────────────────────────────
  console.log(`\x1b[33m  📦 Inventory & Subscriptions\x1b[0m`);
  console.table({
    'Available Bots': { Count: bots.length },
    'Active Subs':    { Count: timeData.filter(d => d.expirationTime > Date.now()).length },
    'Expired Subs':   { Count: timeData.filter(d => d.expirationTime <= Date.now()).length },
  });

  console.log(`\x1b[36m  ${line}\x1b[0m\n`);
}

module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {

    console.log(`\n\x1b[36m╔${'─'.repeat(54)}╗\x1b[0m`);
    console.log(`\x1b[36m║\x1b[0m  \x1b[1m\x1b[32m✅ Bot Ready\x1b[0m`);
    console.table({
      Name:     client.user.tag,
      BotId:    client.user.id,
      Servers:  client.guilds.cache.size,
      Members:  client.users.cache.size,
      Channels: client.channels.cache.size,
    });

    // انتظر 12 ثانية حتى يبدأ manager.js ويتصل Poru
    setTimeout(() => {
      printStatus();
      setInterval(printStatus, 5 * 60 * 1000);
    }, 12000);

    client.user.setPresence({
      status: 'dnd',
      activities: [{ name: `${statuses}`, type: 1, url: `${TwitchUrl}` }]
    });
  },
};
