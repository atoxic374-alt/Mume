'use strict';

const {
  Client,
  GatewayIntentBits,
} = require('discord.js');
const store = require('./store');
const { reconcileTokenStores } = require('./tokenReconciler');

const SERVER_ID_RE = /^\d{17,20}$/;
const INSPECTION_TIMEOUT_MS = Math.max(3000, Number(process.env.BOT_STOCK_INSPECTION_TIMEOUT_MS || 10000));
const RUNNING_READY_WAIT_MS = Math.max(1000, Number(process.env.BOT_STOCK_READY_WAIT_MS || 5000));
const INSPECTION_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.BOT_STOCK_INSPECTION_CONCURRENCY || 5)));

// All allocation paths in this process share one queue. This prevents two
// simultaneous approvals from handing out the same stock token.
let allocationTail = Promise.resolve();

function withAllocationLock(fn) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const previous = allocationTail;
  allocationTail = gate;
  return previous.then(fn).finally(release);
}

function normalizeServerId(serverId) {
  const value = String(serverId || '').trim();
  if (!SERVER_ID_RE.test(value)) throw new Error('Invalid Discord server ID');
  return value;
}

function normalizeCount(count) {
  const value = Number(count);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1000) {
    throw new Error('Invalid bot count');
  }
  return value;
}

function tokenKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function inviteUrlFromToken(token) {
  try {
    const clientId = Buffer.from(tokenKey(token).split('.')[0], 'base64url').toString('utf8');
    if (!/^\d{15,20}$/.test(clientId)) return null;
    return `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot`;
  } catch {
    return null;
  }
}

function getRunningBots() {
  try { return require('../music').runningBots; } catch { return null; }
}

function waitForReady(client, timeoutMs) {
  if (client?.isReady?.()) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.off?.('clientReady', onReady);
      resolve(value);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    client?.once?.('clientReady', onReady);
  });
}

async function inspectWithTemporaryLogin(token, serverId) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let timer;
  try {
    const ready = await Promise.race([
      client.login(token).then(() => true).catch(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), INSPECTION_TIMEOUT_MS); }),
    ]);
    if (!ready) return { valid: false, inServer: false, reason: 'login_failed_or_timeout' };
    return {
      valid: true,
      inServer: Boolean(client.guilds?.cache?.has(serverId)),
      reason: 'temporary_login',
    };
  } finally {
    clearTimeout(timer);
    await client.destroy().catch(() => {});
  }
}

async function inspectBot(token, serverId, runningBots) {
  const running = runningBots?.get?.(token);
  if (running) {
    // Never open a second gateway session for a bot that is already starting.
    const ready = await waitForReady(running, RUNNING_READY_WAIT_MS);
    if (!ready) return { valid: true, inServer: false, reason: 'already_running_not_ready' };
    return {
      valid: true,
      inServer: Boolean(running.guilds?.cache?.has(serverId)),
      reason: 'running_client',
    };
  }
  return inspectWithTemporaryLogin(token, serverId);
}

function freeInventory() {
  const active = new Set((store.get('tokens') || []).map(item => tokenKey(item?.token)).filter(Boolean));
  const seen = new Set();
  return (store.get('bots') || []).filter(item => {
    const token = tokenKey(item?.token);
    if (!token || active.has(token) || seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

/**
 * Atomically claims free stock for a server.
 * Existing membership is preferred, then valid free bots outside the server.
 * Bots are only temporarily logged in for inspection; the manager owns their
 * permanent connection after the caller writes them to tokens.json.
 */
async function claimBotsForServer({ serverId, count }) {
  const normalizedServerId = normalizeServerId(serverId);
  const requested = normalizeCount(count);

  return withAllocationLock(async () => {
    const reconciliation = reconcileTokenStores();
    if (reconciliation.changed) {
      console.log('[BotAllocator] Reconciled stores before allocation:', reconciliation);
    }

    const candidates = freeInventory();
    if (candidates.length < requested) {
      throw new Error(`Not enough free stock: ${candidates.length}/${requested}`);
    }

    const runningBots = getRunningBots();
    const inside = [];
    const outside = [];
    const inspection = [];

    // Inspect bounded batches in parallel. This keeps allocation responsive
    // with a large stock while still stopping as soon as a batch proves that
    // enough in-server bots have been found. Invalid tokens remain in stock
    // for the health checker/admin rather than being silently deleted.
    for (let offset = 0; offset < candidates.length; offset += INSPECTION_CONCURRENCY) {
      const batch = candidates.slice(offset, offset + INSPECTION_CONCURRENCY);
      const results = await Promise.all(batch.map(async candidate => ({
        candidate,
        token: tokenKey(candidate.token),
        result: await inspectBot(tokenKey(candidate.token), normalizedServerId, runningBots),
      })));
      for (const { candidate, token, result } of results) {
        inspection.push({ token, ...result });
        if (!result.valid) continue;
        (result.inServer ? inside : outside).push(candidate);
      }
      if (inside.length >= requested) break;
    }

    const selected = [...inside, ...outside].slice(0, requested);
    if (selected.length < requested) {
      const validCount = inside.length + outside.length;
      throw new Error(`Not enough valid free bots: ${validCount}/${requested}`);
    }

    const selectedTokens = new Set(selected.map(item => tokenKey(item.token)));
    const currentBots = store.get('bots') || [];
    const remaining = currentBots.filter(item => !selectedTokens.has(tokenKey(item?.token)));
    store.set('bots', remaining);
    store.flushSync();

    const inspectionByToken = new Map(inspection.map(item => [item.token, item]));
    const inviteLinks = selected
      .filter(item => !inspectionByToken.get(tokenKey(item.token))?.inServer)
      .map(item => inviteUrlFromToken(item.token))
      .filter(Boolean);

    return {
      selected,
      remainingCount: remaining.length,
      matchedInServer: selected.filter(item => inside.includes(item)).length,
      matchedOutsideServer: selected.filter(item => outside.includes(item)).length,
      inviteLinks,
      inspection,
    };
  });
}

async function releaseBotsToStock(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return;
  return withAllocationLock(async () => {
    const active = new Set((store.get('tokens') || []).map(item => tokenKey(item?.token)).filter(Boolean));
    const current = store.get('bots') || [];
    const seen = new Set(current.map(item => tokenKey(item?.token)).filter(Boolean));
    for (const item of rows) {
      const token = tokenKey(item?.token);
      if (token && !active.has(token) && !seen.has(token)) {
        current.push({ ...item, token });
        seen.add(token);
      }
    }
    store.set('bots', current);
    store.flushSync();
  });
}

function getFreeStockCount() {
  return freeInventory().length;
}

module.exports = {
  claimBotsForServer,
  releaseBotsToStock,
  getFreeStockCount,
  inspectBot,
  inviteUrlFromToken,
};
