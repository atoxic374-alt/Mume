'use strict';
/**
 * LavalinkKeepAlive — اتصال دائم بين البوتات و Lavalink ككيان واحد
 *
 * الإصلاحات:
 * 1. WRONG RESUME PAYLOAD  — Poru يرسل {resumingKey} لكن Lavalink v4 يتطلب {resuming:true}
 * 2. RAILWAY KILLS IDLE WS — WS ping كل 25s يمنع القطع بعد 60s
 * 3. VOICE STATE LOSS      — تجديد voice state بعد shard reconnect
 * 4. SESSION PERSISTENCE   — حفظ sessionId في الذاكرة + القرص، حقنه قبل reconnect
 * 5. REST HEALTH MONITOR   — كشف فشل متكرر → إعادة اتصال فورية
 * 6. IN-MEMORY CACHE       — لا قراءة قرص لكل nodeConnect
 * 7. BEST NODE SELECTION   — اختيار الـ node الأقل تحميلاً تلقائياً
 * 8. CLEANUP ON DESTROY    — تنظيف كل intervals عند destroy البوت
 * 9. UNDICI WARMUP         — تسخين الاتصال الأول عند nodeConnect
 */

const { request: undiciRequest } = require('undici');
const fs   = require('fs');
const path = require('path');

// ── الإعدادات ─────────────────────────────────────────────────────────────────
const RESUME_TIMEOUT_SEC   = 600;    // Lavalink يحفظ الـ session 10 دقائق
const WS_PING_MS           = 25_000; // أقل من 60s (حد Railway)
const REST_HEALTH_MS       = 45_000; // فحص REST صحة كل 45s
const REST_HEALTH_MAX_FAIL = 2;      // فشلان متتاليان → إعادة اتصال
const SESSION_TTL_MS       = 12 * 60 * 1000; // 12 دقيقة صلاحية session محفوظ
const SESSIONS_FILE        = path.join(process.cwd(), 'settings', 'lavalink-sessions.json');

// ── Fix #6: cache في الذاكرة — لا قراءة قرص لكل nodeConnect ─────────────────
// المفتاح: "host:port"، القيمة: { sessionId, ts }
const _memCache = {};
let _cacheLoaded = false;

function _ensureCacheLoaded() {
    if (_cacheLoaded) return;
    _cacheLoaded = true;
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return;
        const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {};
        Object.assign(_memCache, parsed);
    } catch {}
}

function _saveSession(key, sessionId) {
    _ensureCacheLoaded();
    _memCache[key] = { sessionId, ts: Date.now() };
    // كتابة القرص بشكل async لا يبطئ nodeConnect
    setImmediate(() => {
        try {
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(_memCache, null, 2), 'utf8');
        } catch {}
    });
}

function _getStoredSession(key) {
    _ensureCacheLoaded();
    const entry = _memCache[key];
    if (!entry?.sessionId) return null;
    if (Date.now() - entry.ts > SESSION_TTL_MS) {
        delete _memCache[key];
        return null;
    }
    return entry.sessionId;
}

function _nodeKey(node) {
    return `${node.options?.host}:${node.options?.port}`;
}

// ── Fix #1: إرسال PATCH صحيح لـ Lavalink v4 ──────────────────────────────────
async function enableServerResuming(node, sessionId) {
    const proto  = node.options?.secure ? 'https' : 'http';
    const origin = `${proto}://${node.options.host}:${node.options.port}`;
    const key    = _nodeKey(node);
    try {
        const res = await undiciRequest(`${origin}/v4/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: {
                'content-type': 'application/json',
                'authorization': node.options.password,
            },
            body: JSON.stringify({ resuming: true, timeout: RESUME_TIMEOUT_SEC }),
            headersTimeout: 6000,
            bodyTimeout:    6000,
        });
        await res.body?.text?.().catch(() => '');
        if (res.statusCode < 400) {
            console.log(`[LL-KA] ✅ Session resuming enabled for ${key} (…${sessionId.slice(-6)}, ${RESUME_TIMEOUT_SEC}s)`);
            return true;
        }
        console.warn(`[LL-KA] ⚠️  enableResuming ${key}: HTTP ${res.statusCode}`);
        return false;
    } catch (err) {
        console.warn(`[LL-KA] enableResuming error (${key}): ${err?.message || err}`);
        return false;
    }
}

// ── Fix #9: تسخين undici عند أول اتصال ───────────────────────────────────────
function warmupNodeConnection(node) {
    try {
        const rest = node?.rest;
        if (!rest?.url) return;
        // patchPoruNodeRest في music.js يسخّن المسار الرئيسي
        // هنا نسخّن مسار keepAlive نفسه (undiciRequest مباشر)
        const proto  = node.options?.secure ? 'https' : 'http';
        const origin = `${proto}://${node.options.host}:${node.options.port}`;
        undiciRequest(`${origin}/version`, {
            method: 'GET',
            headers: { authorization: node.options.password },
            headersTimeout: 2000,
            bodyTimeout:    2000,
        }).then(r => r.body?.text?.().catch(() => '')).catch(() => {});
    } catch {}
}

// ── Fix #2: WS ping كل 25 ثانية ───────────────────────────────────────────────
function startWsPing(node) {
    stopWsPing(node);
    const key = _nodeKey(node);
    const iv = setInterval(() => {
        if (!node.isConnected) return;
        const ws = node.ws;
        if (!ws || ws.readyState !== 1 /* OPEN */) return;
        try {
            if (typeof ws.ping === 'function') ws.ping(Buffer.alloc(0));
        } catch {}
    }, WS_PING_MS);
    iv.unref?.();
    node._llKaPingIv = iv;
    if (process.env.DEBUG_RECOVERY)
        console.log(`[LL-KA] WS ping started for ${key} (every ${WS_PING_MS / 1000}s)`);
}

function stopWsPing(node) {
    if (node._llKaPingIv) { clearInterval(node._llKaPingIv); node._llKaPingIv = null; }
}

// ── Fix #5: REST health monitor ───────────────────────────────────────────────
function startRestHealthMonitor(node, onFailed) {
    stopRestHealthMonitor(node);
    const key    = _nodeKey(node);
    const proto  = node.options?.secure ? 'https' : 'http';
    const origin = `${proto}://${node.options.host}:${node.options.port}`;
    let failures = 0;
    const iv = setInterval(async () => {
        if (!node.isConnected) { failures = 0; return; }
        try {
            const res = await undiciRequest(`${origin}/version`, {
                method: 'GET',
                headers: { authorization: node.options.password },
                headersTimeout: 7000,
                bodyTimeout:    7000,
            });
            await res.body?.text?.().catch(() => '');
            if (res.statusCode < 400) {
                failures = 0;
            } else {
                failures++;
                console.warn(`[LL-KA] REST health (${key}): HTTP ${res.statusCode} — ${failures}/${REST_HEALTH_MAX_FAIL}`);
                if (failures >= REST_HEALTH_MAX_FAIL) { failures = 0; onFailed('REST consecutive failures'); }
            }
        } catch (err) {
            failures++;
            console.warn(`[LL-KA] REST health (${key}): ${err?.message || err} — ${failures}/${REST_HEALTH_MAX_FAIL}`);
            if (failures >= REST_HEALTH_MAX_FAIL) { failures = 0; onFailed('REST error'); }
        }
    }, REST_HEALTH_MS);
    iv.unref?.();
    node._llKaHealthIv = iv;
}

function stopRestHealthMonitor(node) {
    if (node._llKaHealthIv) { clearInterval(node._llKaHealthIv); node._llKaHealthIv = null; }
}

// ── Fix #4: حقن الـ sessionId المحفوظ ────────────────────────────────────────
function injectStoredSession(node) {
    const key    = _nodeKey(node);
    const stored = _getStoredSession(key);
    if (stored) {
        node.resumeKey = stored;
        if (process.env.DEBUG_RECOVERY)
            console.log(`[LL-KA] Injected stored session …${stored.slice(-6)} into node ${key}`);
    }
}

// ── Fix #7: اختيار الـ node الأقل تحميلاً ────────────────────────────────────
/**
 * يعيد الـ node المتصل ذات أقل CPU load + أقل عدد players.
 * إذا لم يوجد أي node متصل → null.
 */
function getBestNode(poru) {
    if (!poru?.nodes?.size) return null;
    let best     = null;
    let bestScore = Infinity;

    poru.nodes.forEach(node => {
        if (!node.isConnected) return;
        // stats.cpu.systemLoad و stats.cpu.lavalinkLoad بين 0 و 1
        const cpuLoad     = node.stats?.cpu?.systemLoad     ?? 0;
        const llLoad      = node.stats?.cpu?.lavalinkLoad   ?? 0;
        const players     = node.stats?.players             ?? node.players?.size ?? 0;
        // وزن: CPU أهم من عدد الـ players
        const score       = (cpuLoad * 0.6) + (llLoad * 0.3) + (players * 0.001);

        if (score < bestScore) { bestScore = score; best = node; }
    });

    return best;
}

// ── نقطة الدخول: nodeConnect / nodeReconnect ──────────────────────────────────
async function onNodeConnect(node, client) {
    const key       = _nodeKey(node);
    const sessionId = node.sessionId || node.rest?.sessionId;

    if (sessionId) {
        _saveSession(key, sessionId);
        node.resumeKey = sessionId;
        await enableServerResuming(node, sessionId);
    } else {
        console.warn(`[LL-KA] ⚠️  No sessionId on nodeConnect for ${key}`);
    }

    // Fix #9: تسخين الاتصال
    warmupNodeConnection(node);

    // Fix #2: WS ping
    startWsPing(node);

    // Fix #5: REST health monitor
    startRestHealthMonitor(node, (reason) => {
        if (!node.isConnected) return;
        console.warn(`[LL-KA] 🔄 Forcing node reconnect: ${key} (${reason})`);
        stopWsPing(node);
        stopRestHealthMonitor(node);
        try { injectStoredSession(node); node.connect?.(); } catch {}
    });
}

// ── nodeDisconnect ─────────────────────────────────────────────────────────────
function onNodeDisconnect(node) {
    stopWsPing(node);
    // health monitor يبقى — يتخطى الفحص تلقائياً حين isConnected=false
}

// ── Fix #3: shard reconnect → تجديد voice state ──────────────────────────────
function onShardReconnect(client, poru, delayMs = 5000) {
    if (!poru?.players?.size) return;
    setTimeout(() => {
        if (!poru.players?.size) return;
        let refreshed = 0;
        poru.players.forEach(player => {
            if (!player?.voiceChannel) return;
            try {
                if (typeof player.connect === 'function') {
                    player.connect({
                        guildId:      player.guildId,
                        voiceChannel: player.voiceChannel,
                        textChannel:  player.textChannel,
                        deaf:         true,
                        mute:         false,
                    });
                    refreshed++;
                }
            } catch {}
        });
        if (refreshed > 0)
            console.log(`[LL-KA] 🔄 Refreshed voice state for ${refreshed} player(s) after shard reconnect`);
    }, delayMs);
}

// ── Fix #8: تنظيف كامل عند destroy البوت ─────────────────────────────────────
/**
 * استدعِ هذه الدالة قبل TrueMusic.destroy() مباشرة.
 * تُوقف كل intervals لمنع memory leaks مع كثرة البوتات.
 * لا تستدعي destroy() بنفسها.
 */
function destroyKeepAlive(poru) {
    if (!poru?.nodes) return;
    poru.nodes.forEach(node => {
        stopWsPing(node);
        stopRestHealthMonitor(node);
    });
}

// ── حقن sessions قبل poru.init() ─────────────────────────────────────────────
function prepareNodes(poru) {
    if (!poru?.nodes) return;
    poru.nodes.forEach(node => injectStoredSession(node));
}

module.exports = {
    onNodeConnect,
    onNodeDisconnect,
    onShardReconnect,
    prepareNodes,
    destroyKeepAlive,
    getBestNode,
    enableServerResuming,
    startWsPing,
    stopWsPing,
    injectStoredSession,
};
