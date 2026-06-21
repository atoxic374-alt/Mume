---
name: Rate Limit Retry Pattern
description: How bulk bot API operations in mu.js and settings.js handle Discord 429 rate limits with retry and retry_after detection.
---

## The Rule
Every bulk API call that touches Discord REST (setAvatar, setUsername, banner PATCH) must be wrapped in a retry helper that:
1. Detects 429 from discord.js errors (`err.rawError.retry_after`, `err.retryAfter`) AND axios errors (`err.response.status === 429`, header `retry-after`)
2. Waits exactly `retry_after * 1000 + 1500ms` before next attempt (capped at 90s)
3. Falls back to exponential backoff (1500ms × attempt, max 10s) for non-429 errors
4. Retries up to 4 times total

**Why:** Without this, any 429 during a bulk operation (100 bots) silently fails that bot with no recovery. Discord username changes (2/hour/bot) and avatar changes especially trigger 429 under load.

**How to apply:**
- `mu.js` → `muWithRetry(fn)` wrapping `muSetAvatar`, `muSetName`, `muSetBanner`
- `settings.js` → `stgWithRetry(fn)` wrapping avatar action and banner axios call inside `runBotProcess`
- Name change in `settings.js` (set_name button) has its own inline retry loop (4 attempts) with same logic
- Name change in distribution (`setBotNameAndVerify`) has its own inline retry loop (4 attempts) with same logic
- `setPresence` (status) is a Gateway call — NOT REST — no rate limit, no retry needed
- Sequential username operations: 700ms delay between bots (mu.js) / concurrency=1 (settings.js) to avoid global bucket exhaustion
