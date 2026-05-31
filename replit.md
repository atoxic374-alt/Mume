# Mume — Discord Music Bot

A Discord bot (Node.js) that manages music bot subscriptions and controls. It handles subscription lifecycle, bot token management, PayPal payments, and music playback via Lavalink.

## Setup

1. Add your Discord bot token to `settings/config.json` → `"Token"` field
2. Configure `settings/host.json` with your Lavalink server details
3. Set `"owners"` in `settings/config.json` to your Discord user ID(s)
4. Set `"logChannelId"` in `settings/config.json` to your log channel ID

## Project Structure

- `index.js` — Main entry point, Discord client setup, subscription checker
- `music.js` — Music bot logic (Lavalink/Poru integration)
- `manager.js` — Manages running sub-bot instances from tokens
- `commands/` — Bot commands organized by category
  - `Auto-Purchase/` — Automated purchase flow
  - `Control/` — Music control commands
  - `Subscriptions/` — Subscription management (add/remove/list)
- `handler/` — Discord event handlers
- `settings/` — Configuration files (JSON-based)
  - `config.json` — Main bot config (token, prefix, owners, etc.)
  - `host.json` — Lavalink server config
  - `bots.json` — Available bot tokens pool
  - `tokens.json` — Active subscriber tokens
  - `time.json` — Subscription expiration tracking

## Running

```
node index.js
```

## User Preferences
