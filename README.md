# Mume

## NodeLink audio backend

This branch migrates Mume from **old Poru/Lavalink backend** to **Moonlink.js + NodeLink**. The runtime uses `client.audio`, a `NodeLinkCompatManager` backed by `moonlink.js`, so the existing music commands run on NodeLink without the Poru package.

### Do we need an API key?

No extra API key is required for Mume itself. You only need:

1. A running **NodeLink** server.
2. The NodeLink host/port/secure values.
3. The same server password configured in NodeLink's `config.js`.
4. Your existing Discord bot tokens in the current settings files.

`settings/host.json` keeps the same shape:

```json
[
  {
    "name": "main",
    "host": "127.0.0.1",
    "port": 2333,
    "secure": false,
    "password": "your-node-password"
  }
]
```

The password is not a third-party key; it is just the shared authorization secret between this bot and your NodeLink server. If your NodeLink config uses the default password, put that password here. If you deploy NodeLink behind HTTPS/proxy, set `secure` to `true` and use the public host/port.

### Where do the NodeLink node values come from?

You get the values from the machine/container that runs NodeLink:

| Mume `settings/host.json` field | Where to get it from NodeLink |
| --- | --- |
| `host` | The public IP/domain of your VPS, panel allocation host, Docker service name, or `127.0.0.1` if Mume and NodeLink run on the same machine. |
| `port` | `server.port` in NodeLink `config.js`, or the exposed/mapped port in Docker/panel hosting. |
| `secure` | `false` for direct HTTP/WebSocket connections; `true` only when NodeLink is behind HTTPS/WSS through a reverse proxy or provider SSL endpoint. |
| `password` | `server.password` in NodeLink `config.js`, or `NODELINK_SERVER_PASSWORD` when using the official Docker environment variables. |

Typical local/VPS flow:

```bash
git clone https://github.com/PerformanC/NodeLink.git
cd NodeLink
npm install
cp config.default.js config.js
```

Then open `config.js`, find the server settings, set your own password, and copy the same value to Mume:

```js
server: {
  host: '0.0.0.0',
  port: 2333,
  password: 'change-this-password'
}
```

Matching Mume config:

```json
[
  {
    "name": "main",
    "host": "YOUR_VPS_IP_OR_DOMAIN",
    "port": 2333,
    "secure": false,
    "password": "change-this-password"
  }
]
```

If NodeLink logs `Unauthorized connection attempt` or Mume cannot connect with a 401/invalid password error, the password in Mume does not exactly match NodeLink's `server.password`.

### Node partitioning

This project can run many subscription music bots. Each Discord bot token still needs its own Discord gateway identity and NodeLink WebSocket session, because the audio node identifies a client session by the bot `User-Id` and creates players under that session.

When more than one NodeLink node is configured in `store.get('host')`, Mume defaults to **partitioning** bots across nodes instead of connecting every bot to every NodeLink node. This lowers RAM/WebSocket pressure because each bot only opens one audio-node connection by default.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `LAVALINK_NODE_STRATEGY` | `partition` | Backward-compatible name. `partition` assigns each bot to a stable subset of nodes. Use `all` to connect every bot to all nodes. |
| `LAVALINK_NODE_REPLICAS` | `1` | Backward-compatible name. Number of NodeLink nodes each bot should connect to when partitioning. Set to `2` only if you need redundancy and can afford extra RAM. |
| `LAVALINK_RESUME_TIMEOUT_SEC` | `600` | Backward-compatible name used as the NodeLink resume timeout. |

Recommended production setup for RAM-constrained NodeLink servers:

1. Run 2+ NodeLink servers.
2. Add all of them to `settings/host.json`.
3. Keep `LAVALINK_NODE_STRATEGY=partition` and `LAVALINK_NODE_REPLICAS=1`.
4. Increase replicas only after measuring RAM headroom.

## Setup

1. Install dependencies with `npm install` after switching to this branch.
2. Add your Discord bot token to `settings/config.json` → `"Token"` field.
3. Configure `settings/host.json` with your NodeLink server details.
4. Set `"owners"` in `settings/config.json` to your Discord user ID(s).
5. Set `"logChannelId"` in `settings/config.json` to your log channel ID.

## Project Structure

- `index.js` — Main entry point, Discord client setup, subscription checker.
- `music.js` — Music bot logic and NodeLink/Moonlink integration.
- `utils/nodelinkCompat.js` — Compatibility adapter that exposes the old legacy music-player-like surface while using Moonlink.js + NodeLink underneath.
- `manager.js` — Manages running sub-bot instances from tokens.
- `commands/` — Bot commands organized by category.
- `settings/` — JSON configuration files.

## Running

```bash
node index.js
```
