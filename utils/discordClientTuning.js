'use strict';

// ── Patch AsyncEventEmitter (used by discord.js WebSocketShard internally) ───
// Node's EventEmitter.defaultMaxListeners = 0 does NOT affect this class.
// We must patch it directly at module load, before any Client is created.
try {
  const { AsyncEventEmitter } = require('@vladfrangu/async_event_emitter');
  if (AsyncEventEmitter) {
    AsyncEventEmitter.defaultMaxListeners = 0;
    // Also patch the prototype so every instance starts unlimited
    const proto = AsyncEventEmitter.prototype;
    if (typeof proto?.setMaxListeners === 'function') {
      const _orig = proto.setMaxListeners;
      // Override the default constructor limit
      proto.setMaxListeners = function(n) { return _orig.call(this, n); };
    }
  }
} catch {}

// ─────────────────────────────────────────────────────────────────────────────

function liftEmitterLimit(emitter) {
  if (!emitter) return;
  try { if (typeof emitter.setMaxListeners === 'function') emitter.setMaxListeners(0); } catch {}
  // Some versions expose _maxListeners directly
  try { if ('_maxListeners' in emitter) emitter._maxListeners = 0; } catch {}
}

/**
 * Proxy a discord.js WebSocketManager's shards Collection so every shard
 * that gets inserted (now or in the future) immediately has its listener
 * cap removed. This covers the race window where listeners are added to a
 * shard before shardCreate fires.
 */
function proxyShardMap(wsManager) {
  try {
    if (!wsManager?.shards) return;
    const map = wsManager.shards;
    if (map.__listenerProxied) return; // already patched
    const origSet = map.set.bind(map);
    map.set = function(key, shard) {
      liftEmitterLimit(shard);
      // Also lift any internal sub-emitters the shard exposes
      try {
        if (shard?.connection) liftEmitterLimit(shard.connection);
        if (shard?.socket)     liftEmitterLimit(shard.socket);
      } catch {}
      return origSet(key, shard);
    };
    map.__listenerProxied = true;
  } catch {}
}

function liftDiscordClientLimits(client) {
  // Lift the client itself and its major sub-emitters
  liftEmitterLimit(client);
  liftEmitterLimit(client?.ws);
  liftEmitterLimit(client?.rest);

  // Proxy the shards Map so EVERY future shard is immediately unlimited
  proxyShardMap(client?.ws);

  // Lift all shards that already exist
  const liftShards = () => {
    try { client?.ws?.shards?.forEach(shard => {
      liftEmitterLimit(shard);
      try { if (shard?.connection) liftEmitterLimit(shard.connection); } catch {}
      try { if (shard?.socket)     liftEmitterLimit(shard.socket);     } catch {}
    }); } catch {}
  };

  liftShards();

  // Wire into every shard lifecycle event so reconnects stay unlimited
  try { client?.ws?.on?.('shardCreate',       shard => { liftEmitterLimit(shard); proxyShardMap(client?.ws); }); } catch {}
  try {
    client?.on?.('clientReady',      liftShards);
    client?.on?.('shardReady',       liftShards);
    client?.on?.('shardResume',      liftShards);
    client?.on?.('shardReconnecting',liftShards);
    client?.on?.('shardDisconnect',  liftShards);
    client?.on?.('shardError',       liftShards);
  } catch {}
}

module.exports = { liftDiscordClientLimits, liftEmitterLimit };
