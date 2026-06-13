# Mume — Discord Music Bot

A Discord bot (Node.js) that manages music bot subscriptions and controls. It handles subscription lifecycle, bot token management, PayPal payments, and music playback via NodeLink through Moonlink.js.

## Setup

1. Add your Discord bot token to `settings/config.json` → `"Token"` field.
2. Configure `settings/host.json` with your NodeLink server details.
3. Set `"owners"` in `settings/config.json` to your Discord user ID(s).
4. Set `"logChannelId"` in `settings/config.json` to your log channel ID.

## Project Structure

- `index.js` — Main entry point, Discord client setup, subscription checker.
- `music.js` — Music bot logic (NodeLink/Moonlink integration).
- `utils/nodelinkCompat.js` — Legacy-player-compatible adapter backed by Moonlink.js.
- `manager.js` — Manages running sub-bot instances from tokens.
- `commands/` — Bot commands organized by category.
- `handler/` — Discord event handlers.
- `settings/` — Configuration files (JSON-based).
  - `config.json` — Main bot config (token, prefix, owners, etc.).
  - `host.json` — NodeLink server config.
  - `bots.json` — Available bot tokens pool.
  - `tokens.json` — Active subscriber tokens.
  - `time.json` — Subscription expiration tracking.

## Running

```bash
node index.js
```

## NodeLink auth

No external API key is required. The `password` in `settings/host.json` must match the password configured on your NodeLink server.
