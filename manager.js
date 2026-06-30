'use strict';
const { runsys, runningBots, botLastActivity } = require('./music');
const store = require('./utils/store');

// Semaphore: max 5 bots starting simultaneously
let starting = 0;
const MAX_CONCURRENT = 5;
const startQueue = [];

// startQueue holds { botData, attempt } to preserve retry state across concurrency waits
async function tryStart(botData, attempt = 0) {
  if (botData?.paused) return;
  if (runningBots.has(botData.token)) return; // already running
  if (starting >= MAX_CONCURRENT) {
    startQueue.push({ botData, attempt }); // preserve attempt count
    return;
  }
  starting++;
  try {
    await runsys(botData.token, botData.Server);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[Manager] runsys failed for bot:', msg);
    // Retry with exponential backoff on rate-limit or transient errors
    // attempt 0 = first call; retries: 1, 2 → max 3 total calls
    const isRetryable = /rate.?limit|429|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
    if (isRetryable && attempt < 2) {
      const delay = (2 ** attempt) * 5000; // 5s, 10s
      console.log(`[Manager] retrying bot in ${delay}ms (attempt ${attempt + 2}/3)`);
      setTimeout(() => tryStart(botData, attempt + 1), delay).unref?.();
    }
  }
  starting--;
  // drain queue
  if (startQueue.length > 0) {
    const { botData: next, attempt: nextAttempt } = startQueue.shift();
    setImmediate(() => tryStart(next, nextAttempt));
  }
}

async function checkForNewBots() {
  const tokens = store.get('tokens') || [];
  for (const botData of tokens) {
    if (botData?.paused) continue;
    const inst = runningBots.get(botData.token);
    if (!inst || !inst.isReady()) {
      tryStart(botData); // non-blocking
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
