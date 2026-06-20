---
name: automatic.js interaction rules
description: Rules for when to use interaction.update() vs reply() in automatic.js to prevent public panel modification. Also covers runsys startup pattern and known bugs fixed.
---

# automatic.js Interaction Rules

## Core Rule: update() vs reply()
Never call `interaction.update()` for buttons triggered from the PUBLIC panel.
Only use `interaction.update()` when the source message is ephemeral:
```js
const isEphSrc = interaction.message?.flags?.has?.(MessageFlags.Ephemeral);
if (interaction.isStringSelectMenu() || (interaction.isButton() && isEphSrc)) return interaction.update(payload);
return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
```
Applied to: `startRenewal`, `showControlPanel`.

**Why:** Public panel buttons (auto_user_buy, auto_user_renew, etc.) calling `interaction.update()` would modify the shared public embed visible to all users.

## Bot Startup Pattern
After saving tokens to store in `acceptPurchase` and `approveAddBots`, ALWAYS call `runsys` immediately:
```js
const { runsys } = require('../../music');
for (const bot of given) {
  runsys(bot.token, serverId).catch(e => console.error('runsys error:', e?.message));
}
```
The manager.js polls every 10s as backup, but explicit runsys call is required for immediate startup.

**Why:** Without explicit runsys call, bots stay offline until the next 10-second manager poll, which feels broken to users.

## Modal ID Conflicts
- `handleAdminPricing` uses customId `'auto_pricing_modal'`
- `handlePricingCalculator` (user) uses `'auto_user_pricing_modal'` (different!)
Never reuse the same modal customId across different handlers.

## Known Fixed Bugs
- `transferSubscriptionOwnership`: `newOwnerId` was undefined — fixed to `newUserId`
- `approveAddBots`: missing runsys calls — fixed
- `startRenewal`: update() on public panel — fixed with ephemeral check
- `showControlPanel`: update() safety — fixed with ephemeral check
- Rate limiting: `check()` from rateLimit.js was imported but unused — now applied to all public panel user buttons (3s cooldown)
