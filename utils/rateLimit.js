'use strict';
const hits = new Map(); // `${userId}:${cmd}` → last timestamp

// Clean stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of hits) {
    if (now - ts > 10000) hits.delete(key);
  }
}, 60000).unref();

function check(userId, cmd, ms = 1500) {
  const key = `${userId}:${cmd}`;
  const last = hits.get(key) || 0;
  if (Date.now() - last < ms) return false;
  hits.set(key, Date.now());
  return true;
}

module.exports = { check };
