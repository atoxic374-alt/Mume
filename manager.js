'use strict';
const { runsys, runningBots, botLastActivity } = require('./music');
const store = require('./utils/store');
const lavalinkConsole = require('./utils/lavalinkConsole');

// Semaphore: max 5 bots starting simultaneously
let starting = 0;
const MAX_CONCURRENT = 5;
const startQueue = [];
const UNREADY_RESTART_AFTER_MS = Math.max(
  60_000,
  Number(process.env.SUBBOT_UNREADY_RESTART_MS) || 180_000,
);

async function recycleUnreadyBot(botData, botClient) {
  if (!botData?.token || !botClient || botClient._managerRestarting) return;
  botClient._managerRestarting = true;
  const token = botData.token;
  console.warn(`[Manager] recycling subscription bot …${String(token).slice(-6)} after prolonged unready state`);

  try {
    const cleanup = Promise.resolve().then(() => botClient._managerCleanup?.());
    let cleanupTimer;
    await Promise.race([
      cleanup,
      new Promise(resolve => {
        cleanupTimer = setTimeout(resolve, 10_000);
        cleanupTimer.unref?.();
      }),
    ]);
  } catch (err) {
    console.warn('[Manager] sub-bot cleanup failed:', err?.message || err);
  } finally {
    clearTimeout(cleanupTimer);
  }

  try {
    require('./utils/lavalinkKeepAlive').destroyKeepAlive(botClient.poru);
  } catch {}
  try {
    await botClient.destroy();
  } catch (err) {
    console.warn('[Manager] sub-bot destroy failed:', err?.message || err);
  }

  if (runningBots.get(token) === botClient) runningBots.delete(token);
  botLastActivity.delete(token);
  lavalinkConsole.removeBot(botClient, { token });

  const current = (store.get('tokens') || []).find(entry => entry.token === token);
  if (current && !current.paused && !current.awaitingReplacement) {
    const retry = setTimeout(() => tryStart(current), 5000);
    retry.unref?.();
  }
}

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
    if (!inst) {
      tryStart(botData); // non-blocking
      continue;
    }
    if (inst.isReady?.()) {
      inst._managerUnreadySince = null;
      continue;
    }

    const now = Date.now();
    if (!inst._managerUnreadySince) inst._managerUnreadySince = now;
    if (now - inst._managerUnreadySince >= UNREADY_RESTART_AFTER_MS) {
      // tryStart() intentionally refuses duplicate tokens; first retire the
      // stale instance cleanly, then schedule a fresh client after teardown.
      recycleUnreadyBot(botData, inst).catch(error => {
        console.warn('[Manager] sub-bot recovery failed:', error?.message || error);
      });
    }
  }
}

// Discord already persists each bot's appearance. Do not copy one sibling's
// banner/avatar to other tokens during project startup; profile changes belong
// to explicit profile-management actions or new-bot provisioning.

// Lazy unloading: only destroy truly ORPHANED bots (running but no longer in tokens list).
// Healthy subscribed bots are kept alive even while idle; the separate recovery
// path above only recycles an instance after it has remained unready for minutes.
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
    lavalinkConsole.removeBot(botClient);
    runningBots.delete(token);
    botLastActivity?.delete(token);
    console.log(`[Manager] Unloaded orphaned bot token …${token.slice(-6)}`);
  }
}

setInterval(checkForNewBots, 10000);
setInterval(unloadIdleBots,  5 * 60 * 1000); // check every 5 min
