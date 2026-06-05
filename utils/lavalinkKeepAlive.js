'use strict';
/**
 * LavalinkKeepAlive — اتصال دائم بين البوتات و Lavalink ككيان واحد
 *
 * المشاكل المُصلَحة:
 *
 * 1. PORU WRONG RESUME PAYLOAD (السبب الجذري الأول)
 *    Poru v5 يرسل { resumingKey: "...", timeout: 60 } لكن Lavalink v4 يتطلب
 *    { resuming: true, timeout: N } — الفرق يعني Lavalink لا يحفظ أي session
 *    → نرسل PATCH صحيح بعد كل nodeConnect فوراً
 *
 * 2. RAILWAY KILLS IDLE WEBSOCKET (السبب الجذري الثاني)
 *    Railway/nginx يقطع WebSocket خامل بعد ~60 ثانية بدون ping
 *    Poru لا يرسل أي ping frames من تلقاء نفسه
 *    → نرسل WS ping كل 25 ثانية
 *
 * 3. VOICE STATE LOSS AFTER SHARD RECONNECT (السبب الجذري الثالث)
 *    عند إعادة اتصال Discord shard، Discord لا يعيد إرسال VOICE_SERVER_UPDATE
 *    تلقائياً → Lavalink يفقد الـ voice session → "Session not found"
 *    → نجبر كل player على تجديد voice state بعد shard reconnect
 *
 * 4. SESSION ID PERSISTENCE
 *    نحفظ sessionId على القرص لكل node → يُحقن في resumeKey قبل كل reconnect
 *    حتى يرسل Poru الـ session القديم في هيدر الـ WebSocket
 *
 * 5. REST HEALTH MONITOR
 *    فحص REST كل 45 ثانية — فشلان متتاليان → إعادة اتصال فورية
 */

const { request: undiciRequest } = require('undici');
const fs   = require('fs');
const path = require('path');

// ── الإعدادات ─────────────────────────────────────────────────────────────────
const RESUME_TIMEOUT_SEC      = 600;   // 10 دقائق — يحفظ Lavalink الـ session حتى لو انقطع الاتصال
const WS_PING_MS              = 25_000; // 25 ثانية — أقل من 60 (حد Railway)
const REST_HEALTH_MS          = 45_000; // 45 ثانية
const REST_HEALTH_MAX_FAIL    = 2;     // إعادة اتصال بعد فشلين متتاليين
const SESSION_TTL_MS          = 12 * 60 * 1000; // 12 دقيقة صلاحية الـ session المحفوظ
const SESSIONS_FILE           = path.join(process.cwd(), 'settings', 'lavalink-sessions.json');

// ── مخزن الـ sessions المحفوظة ────────────────────────────────────────────────
function _loadSessions() {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return {};
        return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {};
    } catch { return {}; }
}

function _saveSession(key, sessionId) {
    try {
        const s = _loadSessions();
        s[key] = { sessionId, ts: Date.now() };
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2), 'utf8');
    } catch (e) {
        console.warn('[LL-KA] Failed to save session:', e?.message);
    }
}

function _getStoredSession(key) {
    try {
        const entry = _loadSessions()[key];
        if (!entry?.sessionId) return null;
        if (Date.now() - entry.ts > SESSION_TTL_MS) return null;
        return entry.sessionId;
    } catch { return null; }
}

function _nodeKey(node) {
    return `${node.options?.host}:${node.options?.port}`;
}

// ── Fix #1: إرسال PATCH صحيح لـ Lavalink v4 ──────────────────────────────────
// Poru يرسل { resumingKey: "..." } لكن Lavalink v4 يتطلب { resuming: true }
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
            bodyTimeout: 6000,
        });
        // drain body
        await res.body?.text?.().catch(() => '');

        if (res.statusCode < 400) {
            console.log(`[LL-KA] ✅ Session resuming enabled for ${key} (session: …${sessionId.slice(-6)}, timeout: ${RESUME_TIMEOUT_SEC}s)`);
            return true;
        }
        console.warn(`[LL-KA] ⚠️  enableResuming ${key}: HTTP ${res.statusCode}`);
        return false;
    } catch (err) {
        console.warn(`[LL-KA] enableResuming error (${key}): ${err?.message || err}`);
        return false;
    }
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
            if (typeof ws.ping === 'function') {
                ws.ping(Buffer.alloc(0));
            }
        } catch {}
    }, WS_PING_MS);

    iv.unref?.();
    node._llKaPingIv = iv;

    if (process.env.DEBUG_RECOVERY)
        console.log(`[LL-KA] WS ping started for ${key} (every ${WS_PING_MS / 1000}s)`);
}

function stopWsPing(node) {
    if (node._llKaPingIv) {
        clearInterval(node._llKaPingIv);
        node._llKaPingIv = null;
    }
}

// ── Fix #5: REST health monitor ───────────────────────────────────────────────
function startRestHealthMonitor(node, onFailed) {
    stopRestHealthMonitor(node);

    const key    = _nodeKey(node);
    const proto  = node.options?.secure ? 'https' : 'http';
    const origin = `${proto}://${node.options.host}:${node.options.port}`;
    let failures = 0;

    const iv = setInterval(async () => {
        // تخطى لو الـ node غير متصل (Poru يتولى إعادة الاتصال)
        if (!node.isConnected) {
            failures = 0;
            return;
        }
        try {
            const res = await undiciRequest(`${origin}/version`, {
                method: 'GET',
                headers: { authorization: node.options.password },
                headersTimeout: 7000,
                bodyTimeout: 7000,
            });
            await res.body?.text?.().catch(() => '');

            if (res.statusCode < 400) {
                failures = 0; // صحي
            } else {
                failures++;
                console.warn(`[LL-KA] REST health (${key}): HTTP ${res.statusCode} — ${failures}/${REST_HEALTH_MAX_FAIL}`);
                if (failures >= REST_HEALTH_MAX_FAIL) {
                    failures = 0;
                    onFailed('REST consecutive failures');
                }
            }
        } catch (err) {
            failures++;
            console.warn(`[LL-KA] REST health (${key}): ${err?.message || err} — ${failures}/${REST_HEALTH_MAX_FAIL}`);
            if (failures >= REST_HEALTH_MAX_FAIL) {
                failures = 0;
                onFailed('REST error');
            }
        }
    }, REST_HEALTH_MS);

    iv.unref?.();
    node._llKaHealthIv = iv;
}

function stopRestHealthMonitor(node) {
    if (node._llKaHealthIv) {
        clearInterval(node._llKaHealthIv);
        node._llKaHealthIv = null;
    }
}

// ── Fix #4: حقن الـ sessionId المحفوظ ────────────────────────────────────────
// يُضبط node.resumeKey بالـ session القديم حتى يرسله Poru في هيدر الـ WS
function injectStoredSession(node) {
    const key      = _nodeKey(node);
    const stored   = _getStoredSession(key);
    if (stored) {
        node.resumeKey = stored;
        if (process.env.DEBUG_RECOVERY)
            console.log(`[LL-KA] Injected stored session …${stored.slice(-6)} into node ${key}`);
    }
}

// ── نقطة الدخول الرئيسية: nodeConnect / nodeReconnect ─────────────────────────
/**
 * استدعِ هذه الدالة على حدث nodeConnect و nodeReconnect.
 * تُنفّذ جميع إصلاحات الاتصال الدائم.
 */
async function onNodeConnect(node, client) {
    const key       = _nodeKey(node);
    const sessionId = node.sessionId || node.rest?.sessionId;

    if (sessionId) {
        // حفظ الـ session + ضبط resumeKey للـ reconnect القادم
        _saveSession(key, sessionId);
        node.resumeKey = sessionId;

        // إرسال PATCH صحيح (الإصلاح الأهم)
        await enableServerResuming(node, sessionId);
    } else {
        console.warn(`[LL-KA] ⚠️  No sessionId on nodeConnect for ${key}`);
    }

    // بدء WS ping
    startWsPing(node);

    // بدء REST health monitor
    startRestHealthMonitor(node, (reason) => {
        if (!node.isConnected) return;
        console.warn(`[LL-KA] 🔄 Forcing node reconnect: ${key} (${reason})`);
        stopWsPing(node);
        stopRestHealthMonitor(node);
        try {
            injectStoredSession(node);
            node.connect?.();
        } catch {}
    });
}

/**
 * استدعِ على nodeDisconnect.
 */
function onNodeDisconnect(node) {
    stopWsPing(node);
    // لا نوقف health monitor — سيتخطى الفحص تلقائياً حين يكون isConnected=false
}

/**
 * Fix #3: استدعِ على shardResume و shardReconnecting.
 * يجبر كل player على تجديد voice state لأن Discord لا يعيد VOICE_SERVER_UPDATE تلقائياً.
 */
function onShardReconnect(client, poru, delayMs = 5000) {
    if (!poru?.players?.size) return;

    setTimeout(() => {
        if (!poru.players?.size) return;
        let refreshed = 0;

        poru.players.forEach(player => {
            if (!player?.voiceChannel) return;
            try {
                // إعادة الاتصال بنفس الـ voice channel → يجبر Discord على إرسال
                // VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE من جديد لـ Lavalink
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

        if (refreshed > 0) {
            console.log(`[LL-KA] 🔄 Refreshed voice state for ${refreshed} player(s) after shard reconnect`);
        }
    }, delayMs);
}

/**
 * استدعِ قبل poru.init() — يحقن sessions محفوظة لكل الـ nodes.
 */
function prepareNodes(poru) {
    if (!poru?.nodes) return;
    poru.nodes.forEach(node => injectStoredSession(node));
}

module.exports = {
    onNodeConnect,
    onNodeDisconnect,
    onShardReconnect,
    prepareNodes,
    enableServerResuming,
    startWsPing,
    stopWsPing,
    injectStoredSession,
};
