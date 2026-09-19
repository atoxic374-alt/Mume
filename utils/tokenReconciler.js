'use strict';

const store = require('./store');

const DEFAULT_SUBSCRIPTION_FIELDS = {
  Server: null,
  channel: null,
  chat: null,
  status: null,
  client: null,
  code: null,
};

function tokenKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function mergeMissingFields(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (key === 'token' || value === undefined || value === null || value === '') continue;
    if (target[key] === undefined || target[key] === null || target[key] === '') {
      target[key] = value;
    }
  }
}

/**
 * Reconciles the inventory and active subscription lists.
 *
 * Rules:
 *  - A token can have only one active subscription entry.
 *  - Active subscription tokens always win over inventory tokens.
 *  - Duplicate subscription entries keep the first entry and merge missing
 *    settings from later entries into it.
 *  - Invalid/empty records are discarded from both lists.
 *  - Each subscription's botsCount is synchronized to its actual token count.
 *  - Subscription records with no remaining tokens are removed from `time`.
 */
function reconcileTokenStores({ now = Date.now(), removeEmptySubscriptions = true } = {}) {
  // The files can be edited or replaced while the process is running. Refresh
  // clean stores first so tokens.json and bots.json are reconciled together.
  store.reload('tokens');
  store.reload('bots');
  store.reload('time');

  const sourceTokens = Array.isArray(store.get('tokens')) ? store.get('tokens') : [];
  const sourceBots = Array.isArray(store.get('bots')) ? store.get('bots') : [];
  const sourceTime = Array.isArray(store.get('time')) ? store.get('time') : [];

  const activeTokens = [];
  const activeByToken = new Map();
  const duplicateSubscriptionTokens = new Set();
  const invalidSubscriptionTokens = new Set();

  for (const rawEntry of sourceTokens) {
    const key = tokenKey(rawEntry?.token);
    if (!key) {
      invalidSubscriptionTokens.add(key || '(empty)');
      continue;
    }

    const entry = { ...rawEntry, token: key };
    const existing = activeByToken.get(key);
    if (existing) {
      duplicateSubscriptionTokens.add(key);
      mergeMissingFields(existing, entry);
      continue;
    }

    activeByToken.set(key, entry);
    activeTokens.push(entry);
  }

  const activeTokenSet = new Set(activeTokens.map(entry => entry.token));
  const inventory = [];
  const inventoryByToken = new Map();
  let duplicateInventoryCount = 0;
  let activeInventoryConflictCount = 0;
  let invalidInventoryCount = 0;

  for (const rawBot of sourceBots) {
    const key = tokenKey(rawBot?.token);
    if (!key) {
      invalidInventoryCount++;
      continue;
    }
    if (activeTokenSet.has(key)) {
      activeInventoryConflictCount++;
      continue;
    }
    if (inventoryByToken.has(key)) {
      duplicateInventoryCount++;
      continue;
    }

    const bot = { ...rawBot, token: key };
    inventoryByToken.set(key, bot);
    inventory.push(bot);
  }

  const tokensByCode = new Map();
  for (const entry of activeTokens) {
    if (!entry.code) continue;
    if (!tokensByCode.has(entry.code)) tokensByCode.set(entry.code, []);
    tokensByCode.get(entry.code).push(entry);
  }

  const updatedTime = [];
  let removedEmptySubscriptionCount = 0;
  let updatedSubscriptionCount = 0;
  for (const rawSubscription of sourceTime) {
    const subscription = { ...rawSubscription };
    const code = subscription.code;
    const count = code ? (tokensByCode.get(code)?.length || 0) : 0;

    if (count === 0 && removeEmptySubscriptions) {
      removedEmptySubscriptionCount++;
      continue;
    }

    if (subscription.botsCount !== count) {
      subscription.botsCount = count;
      updatedSubscriptionCount++;
    }
    updatedTime.push(subscription);
  }

  // A token whose subscription metadata has no matching time record is still
  // kept: removing it here could disconnect a valid bot unexpectedly. Its
  // subscription can be repaired by the owner/admin later.
  const changed = JSON.stringify(sourceTokens) !== JSON.stringify(activeTokens)
    || JSON.stringify(sourceBots) !== JSON.stringify(inventory)
    || JSON.stringify(sourceTime) !== JSON.stringify(updatedTime);

  if (changed) {
    store.set('tokens', activeTokens);
    store.set('bots', inventory);
    store.set('time', updatedTime);
    store.flushSync();
  }

  return {
    changed,
    tokens: activeTokens,
    bots: inventory,
    time: updatedTime,
    duplicateSubscriptionCount: duplicateSubscriptionTokens.size,
    duplicateInventoryCount,
    activeInventoryConflictCount,
    invalidSubscriptionCount: invalidSubscriptionTokens.size,
    invalidInventoryCount,
    removedEmptySubscriptionCount,
    updatedSubscriptionCount,
  };
}

module.exports = {
  reconcileTokenStores,
  DEFAULT_SUBSCRIPTION_FIELDS,
};
