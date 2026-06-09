'use strict';

function liftEmitterLimit(emitter) {
  if (!emitter || typeof emitter.setMaxListeners !== 'function') return;
  try {
    emitter.setMaxListeners(0);
  } catch {}
}

function liftDiscordClientLimits(client) {
  liftEmitterLimit(client);
  liftEmitterLimit(client?.ws);
  liftEmitterLimit(client?.rest);

  const liftShards = () => {
    try {
      client?.ws?.shards?.forEach(shard => liftEmitterLimit(shard));
    } catch {}
  };

  liftShards();

  try {
    client?.ws?.on?.('shardCreate', shard => liftEmitterLimit(shard));
  } catch {}

  try {
    client?.on?.('clientReady', liftShards);
    client?.on?.('shardReady', liftShards);
    client?.on?.('shardResume', liftShards);
    client?.on?.('shardReconnecting', liftShards);
  } catch {}
}

module.exports = {
  liftDiscordClientLimits,
};
