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
