'use strict';
const { runsys, runningBots, botLastActivity } = require('./music');
const store = require('./utils/store');

// Semaphore: max 5 bots starting simultaneously
let starting = 0;
const MAX_CONCURRENT = 5;
const startQueue = [];

async function tryStart(botData) {
  if (runningBots.has(botData.token)) return; // already running
  if (starting >= MAX_CONCURRENT) {
    startQueue.push(botData); // queue for later
    return;
  }
  starting++;
  try {
    await runsys(botData.token, botData.Server);
  } catch {}
  starting--;
  // drain queue
  if (startQueue.length > 0) {
    const next = startQueue.shift();
    setImmediate(() => tryStart(next));
  }
}

async function checkForNewBots() {
  const tokens = store.get('tokens') || [];
  for (const botData of tokens) {
    const inst = runningBots.get(botData.token);
    if (!inst || !inst.isReady()) {
      tryStart(botData); // non-blocking
    }
  }
}

// Lazy unloading: destroy bots idle >30min and NOT in VC and have no configured channel
async function unloadIdleBots() {
  const now = Date.now();
  const IDLE_MS = 30 * 60 * 1000;
  const tokens = store.get('tokens') || [];

  for (const [token, botClient] of runningBots) {
    const lastActive = botLastActivity?.get(token) || 0;
    if (now - lastActive < IDLE_MS) continue; // recently active

    // Never destroy a bot that has a configured voice channel in its token entry
    const tokenObj = tokens.find(t => t.token === token);
    if (tokenObj?.channel) continue; // has a configured VC → keep alive

    // Never destroy a bot with active Poru players
    const hasActivePlayers = botClient.poru?.players?.size > 0;
    if (hasActivePlayers) continue;

    // check if in VC via member cache
    const inVC = [...(botClient.guilds?.cache?.values() || [])].some(g =>
      g.members?.me?.voice?.channel
    );
    if (inVC) continue; // in VC → keep alive

    // truly idle and not in VC → destroy
    try { await botClient.destroy(); } catch {}
    runningBots.delete(token);
    botLastActivity?.delete(token);
  }
}

setInterval(checkForNewBots, 10000);
setInterval(unloadIdleBots,  5 * 60 * 1000); // check every 5 min
