'use strict';

try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch {}

/**
 * Boot Migration — Railway Volume Safety Layer
 * 
 * Runs synchronously before any require() in index.js.
 * Strategy:
 *   1. Ensure `settings/` directory exists (Volume mount point).
 *   2. For every JSON file found in `settings_default/`, copy it to
 *      `settings/` ONLY if that file does not already exist there.
 *      → Existing live files (tokens, subscriptions, config) are NEVER
 *        overwritten, protecting real user data across deploys/restarts.
 *   3. Ensure `settings/database.json` exists (migrated from root if present).
 */

const fs   = require('fs');
const path = require('path');

const ROOT            = process.cwd();
const SETTINGS_DIR    = path.join(ROOT, 'settings');
const DEFAULTS_DIR    = path.join(ROOT, 'settings_default');
const LEGACY_DB_FILE  = path.join(ROOT, 'database.json');
const SETTINGS_DB     = path.join(SETTINGS_DIR, 'database.json');
const STALE_LL_SESSIONS = path.join(SETTINGS_DIR, 'lavalink-sessions.json');

// ── 1. Ensure settings/ exists ──────────────────────────────────────────────
if (!fs.existsSync(SETTINGS_DIR)) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  console.log('[Boot] Created settings/ directory.');
}

try {
  if (fs.existsSync(STALE_LL_SESSIONS)) {
    fs.unlinkSync(STALE_LL_SESSIONS);
    console.log('[Boot] Removed stale Lavalink session cache.');
  }
} catch (err) {
  console.warn('[Boot] Failed to remove stale Lavalink session cache:', err.message);
}

// ── 2. Copy missing defaults from settings_default/ → settings/ ─────────────
if (fs.existsSync(DEFAULTS_DIR)) {
  const defaultFiles = fs.readdirSync(DEFAULTS_DIR).filter(f => f.endsWith('.json'));

  for (const file of defaultFiles) {
    const dest = path.join(SETTINGS_DIR, file);
    const src  = path.join(DEFAULTS_DIR, file);

    if (!fs.existsSync(dest)) {
      try {
        fs.copyFileSync(src, dest);
        console.log(`[Boot] Initialized missing config: settings/${file}`);
      } catch (err) {
        console.error(`[Boot] Failed to copy ${file}:`, err.message);
      }
    }
  }
} else {
  console.warn('[Boot] settings_default/ not found — skipping default seeding.');
}

// ── 3. Migrate legacy root database.json → settings/database.json ───────────
if (!fs.existsSync(SETTINGS_DB)) {
  if (fs.existsSync(LEGACY_DB_FILE)) {
    try {
      fs.copyFileSync(LEGACY_DB_FILE, SETTINGS_DB);
      console.log('[Boot] Migrated database.json → settings/database.json');
    } catch (err) {
      console.error('[Boot] Failed to migrate database.json:', err.message);
    }
  } else {
    // Create an empty database file
    fs.writeFileSync(SETTINGS_DB, '{}\n', 'utf8');
    console.log('[Boot] Created empty settings/database.json');
  }
}

console.log('[Boot] Migration complete. All settings verified.');
