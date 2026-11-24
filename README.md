# Mume

## Lavalink scaling notes

This project can run many subscription music bots. Each Discord bot token still needs its own Discord gateway identity and Lavalink WebSocket session, because Lavalink identifies a client session by the bot `User-Id` and creates players under that session.

### Node partitioning

When more than one Lavalink node is configured in `store.get('host')`, Mume defaults to **partitioning** bots across nodes instead of connecting every bot to every Lavalink node. This lowers Lavalink RAM/WebSocket pressure because each bot only opens one Lavalink connection by default.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `LAVALINK_NODE_STRATEGY` | `partition` | `partition` assigns each bot to a stable subset of nodes. Use `all` to restore the old behavior where every bot connects to all nodes. |
| `LAVALINK_NODE_REPLICAS` | `1` | Number of Lavalink nodes each bot should connect to when partitioning. Set to `2` only if you need redundancy and can afford extra RAM. |

Recommended production setup for RAM-constrained Lavalink servers:

1. Run 2+ Lavalink servers.
2. Add all of them to the host config.
3. Keep `LAVALINK_NODE_STRATEGY=partition` and `LAVALINK_NODE_REPLICAS=1`.
4. Increase replicas only after measuring RAM headroom.

## Server-aware bot allocation

Subscription allocation is handled by `utils/botAllocator.js`. Before assigning
stock, it reconciles `bots.json` and `tokens.json`, excludes active or duplicate
tokens, and checks each free bot's Discord guild cache. A free bot already in the
requested server is preferred. If the bot is not running, Mume opens a temporary
Guilds-only gateway session to inspect its guilds, closes that session, and then
the normal subscription manager starts the assigned bot permanently.

All allocation entry points use the same in-process lock, so concurrent approval
actions cannot claim the same token. Invalid or timed-out stock tokens are never
assigned. Existing guild membership is preserved when tokens are added to stock;
profile cleanup operations for subscribed or removed bots can still explicitly
leave guilds when required.
