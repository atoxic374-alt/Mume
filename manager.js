'use strict';
const { runsys, runningBots, botLastActivity } = require('./music');
const store = require('./utils/store');

// Semaphore: max 5 bots starting simultaneously.
let starting = 0;
const MAX_CONCURRENT = 5;
const startQueue = [];
const pendingStarts = new Set();

function drainStartQueue() {
  while (starting < MAX_CONCURRENT && startQueue.length) {
    const job = startQueue.shift();
    starting++;
    runStartJob(job).catch(err => console.error('[Manager] start job error:', err?.message || err));
  }
}

function enqueueStart(botData, attempt = 0) {
  const token = botData?.token;
  if (!token || botData.paused || runningBots.has(token) || pendingStarts.has(token)) return;
  pendingStarts.add(token);
  startQueue.push({ botData, attempt });
  drainStartQueue();
}

async function runStartJob({ botData, attempt = 0 }) {
  const token = botData?.token;
  let retryScheduled = false;
  try {
    if (botData?.paused || runningBots.has(token)) return;
    await runsys(token, botData.Server);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[Manager] runsys failed for bot:', msg);
    const isRetryable = /rate.?limit|429|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
    if (isRetryable && attempt < 2 && !botData?.paused) {
      const delay = (2 ** attempt) * 5000;
      retryScheduled = true;
      console.log(`[Manager] retrying bot in ${delay}ms (attempt ${attempt + 2}/3)`);
      setTimeout(() => {
        pendingStarts.delete(token);
        const current = (store.get('tokens') || []).find(item => item.token === token);
        if (current && !current.paused) enqueueStart(current, attempt + 1);
      }, delay).unref?.();
    }
  } finally {
    starting--;
    if (!retryScheduled) pendingStarts.delete(token);
    drainStartQueue();
  }
}

async function checkForNewBots() {
  const tokens = store.get('tokens') || [];
  for (const botData of tokens) {
    if (botData?.paused) continue;
    const inst = runningBots.get(botData.token);
    if (!inst || !inst.isReady()) {
      enqueueStart(botData); // non-blocking and de-duplicated
    }
  }
}

// Lazy unloading: only destroy truly ORPHANED bots (running but no longer in tokens list).
// Bots that have an active subscription entry in tokens are NEVER unloaded here,
// even if they have no channel yet — destroying/restarting them breaks Lavalink
// sessions and causes "No nodes available" when the user tries to put them in voice.
async function unloadIdleBots() {
  const tokens = store.get('tokens') || [];
  const tokenSet = new Set(tokens.map(t => t.token));

  for (const [token, botClient] of runningBots) {
    // Bot still has a valid subscription entry → keep it alive no matter what
    if (tokenSet.has(token)) continue;

    // Bot is running but not in tokens at all → orphaned, safe to destroy
    try { await botClient.destroy(); } catch (err) {
      console.warn('[Manager] destroy failed for orphaned bot:', err?.message || err);
    }
    runningBots.delete(token);
    botLastActivity?.delete(token);
    console.log(`[Manager] Unloaded orphaned bot token …${token.slice(-6)}`);
  }
}

setInterval(checkForNewBots, 10000);
setInterval(unloadIdleBots,  5 * 60 * 1000); // check every 5 min
