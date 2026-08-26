---
name: Performance Architecture
description: Key decisions for sub-1GB RAM and high-throughput performance in Mume bot.
---

## utils/store.js — Singleton JSON cache
All JSON settings files are loaded once into memory on startup. Every `get()` is O(1) in-memory. Writes are debounced 500ms + atomic (tmp+rename). Never use `fs.readFileSync/writeFileSync` for settings JSON files anywhere in the codebase.

Keys: `tokens`, `bots`, `time`, `host`, `display`, `emojis`
Path: `utils/store.js`

**Why:** 92 sync file I/O calls were found across the codebase. Each blocks the Node.js event loop. Under high concurrency (1000 bots × events) this causes severe latency spikes.

**How to apply:** Any new command or handler that reads/writes settings JSON must use `const store = require('../../utils/store')` and `store.get(key)` / `store.set(key, value)`.

## utils/rateLimit.js — Per-user rate limiter
`check(userId, commandName, ms=1500)` → true=allowed. Backed by Map with 60s TTL cleanup.

**Why:** Prevents event loop saturation from command spam under high concurrency.

## Discord.js client optimization (music.js + index.js)
Every TrueMusic sub-bot client uses `makeCache` with strict limits (ReactionManager:0, PresenceManager:0, GuildMemberManager:maxSize=5, MessageManager:maxSize=8) + sweepers (messages 60s/120s lifetime, members 300s) + `ws:{compress:true}`. Reduces per-bot RAM from ~50MB to ~3-5MB.

**Why:** With thousands of sub-bots, unoptimized clients consume RAM exponentially.

## manager.js — Lazy unloading + concurrency queue
- Max 5 bots start simultaneously (semaphore in `startQueue`)
- Every 5min: bots idle >30min AND not in VC get destroyed via `unloadIdleBots()`
- Activity tracked via `botLastActivity` Map (token → timestamp), exported from music.js
- `checkForNewBots()` runs every 10s, skips already-running bots

**Why:** Keeping all bots in memory permanently makes RAM grow unboundedly. Lazy unloading keeps active set small.

## Remaining fs usage (intentional, not to replace)
- `fs.copyFileSync` for backup files in mu.js restart flow — intentional, not a settings JSON
- `fs.readFileSync` for image files (avatar/banner PNG) — binary data, not JSON settings
- `store.js` itself uses `fs` internally for its atomic write logic
