'use strict';
/**
 * LavalinkKeepAlive — اتصال دائم بين البوتات و Lavalink ككيان واحد
 *
 * ┌─ الإصلاحات ──────────────────────────────────────────────────────────────────┐
 * │ 1. WRONG RESUME PAYLOAD  Poru يرسل {resumingKey} لكن v4 يتطلب {resuming:true}│
 * │    ← BUG أعمق: open()→nodeConnect→نرسل PATCH صحيح ثمّ ready→Poru يُبطله    │
 * │    Fix: نرقّع rest.patch مباشرة لنعترض payload الخاطئ قبل وصوله لـ Lavalink │
 * │                                                                              │
 * │ 2. WRONG WS HEADER       Poru يرسل "Resume-Key" لكن v4 يتطلب "Session-Id"   │
 * │    ← بدون هذا Lavalink يُنشئ session جديد في كل reconnect                  │
 * │    Fix: نرقّع node.connect() كاملاً ليُرسل "Session-Id" الصحيح              │
 * │                                                                              │
 * │ 3. RAILWAY KILLS IDLE WS  Railway يقطع WebSocket خامل بعد ~60s              │
 * │    Fix: WS ping كل 25s                                                       │
 * │                                                                              │
 * │ 4. VOICE STATE LOSS       بعد shard reconnect، Discord لا يعيد VOICE_SERVER  │
 * │    Fix: نجدّد voice state لكل player بعد shard reconnect                    │
 * │                                                                              │
 * │ 5. SESSION PERSISTENCE    نحفظ sessionId ذاكرة+قرص ونحقنه قبل كل reconnect  │
 * │                                                                              │
 * │ 6. FILTERS LOST           بعد session جديد، الفلاتر تختفي من Lavalink        │
 * │    Fix: نعيد إرسال filters عبر updatePlayer بعد كل voice session refresh    │
 * │                                                                              │
 * │ 7. REST HEALTH MONITOR    فشلان REST متتاليان → إعادة اتصال فورية           │
 * │                                                                              │
 * │ 8. IN-MEMORY SESSION CACHE  لا قراءة قرص لكل nodeConnect                    │
 * │                                                                              │
 * │ 9. BEST NODE SELECTION    اختيار الـ node الأخف تحميلاً تلقائياً             │
 * │                                                                              │
 * │ 10. CLEANUP ON DESTROY    تنظيف كل intervals عند destroy البوت              │
 * │                                                                              │
 * │ 11. READY PACKET MONITOR  نتتبع resumed:true/false لكل session               │
 * └──────────────────────────────────────────────────────────────────────────────┘
 */

const { request: undiciRequest } = require('undici');
const WS   = require('ws');
const fs   = require('fs');
const path = require('path');

// ── الإعدادات ─────────────────────────────────────────────────────────────────
const RESUME_TIMEOUT_SEC   = 600;    // Lavalink يحفظ الـ session 10 دقائق
const WS_PING_MS           = 25_000; // أقل من 60s (حد Railway)
const REST_HEALTH_MS       = 45_000; // فحص REST صحة
const REST_HEALTH_MAX_FAIL = 2;      // فشلان → إعادة اتصال
const SESSION_TTL_MS       = 12 * 60 * 1000; // 12 دقيقة صلاحية session محفوظ
const SESSIONS_FILE        = path.join(process.cwd(), 'settings', 'lavalink-sessions.json');

// ── Fix #8: cache في الذاكرة — لا قراءة قرص لكل nodeConnect ──────────────────
const _memCache  = {};
let   _cacheLoaded = false;

function _ensureCacheLoaded() {
    if (_cacheLoaded) return;
    _cacheLoaded = true;
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return;
        Object.assign(_memCache, JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {});
    } catch {}
}

function _saveSession(key, sessionId) {
    _ensureCacheLoaded();
    _memCache[key] = { sessionId, ts: Date.now() };
    setImmediate(() => {
        try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(_memCache, null, 2), 'utf8'); } catch {}
    });
}

function _getStoredSession(key) {
    _ensureCacheLoaded();
    const entry = _memCache[key];
    if (!entry?.sessionId) return null;
    if (Date.now() - entry.ts > SESSION_TTL_MS) { delete _memCache[key]; return null; }
    return entry.sessionId;
}

function _nodeKey(node) { return `${node.options?.host}:${node.options?.port}`; }

// ══════════════════════════════════════════════════════════════════════════════
// Fix #1 + Fix #2: رقع connect() و rest.patch — قلب الإصلاحات
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Fix #1 — يعترض PATCH الخاطئ من Poru قبل وصوله لـ Lavalink.
 *
 * الترتيب الحقيقي في Poru:
 *   open() → nodeConnect (نحن نُطلَق هنا) → ready packet → Poru يُرسل {resumingKey} ← يُبطل إصلاحنا!
 *
 * بالاعتراض على rest.patch نضمن أن Lavalink يستقبل {resuming:true} دائماً
 * بغض النظر عن متى يصل ready packet.
 */
function patchNodeRestPatch(node) {
    const rest = node?.rest;
    if (!rest || rest._llKaRestPatchFixed) return;
    rest._llKaRestPatchFixed = true;

    const origPatch = rest.patch.bind(rest);
    rest.patch = async function(endpoint, body, ...args) {
        // الاعتراض: Poru يرسل { resumingKey: "...", timeout: N } لـ /v4/sessions/{id}
        // Lavalink v4 يتجاهله تماماً — نستبدله بـ { resuming: true, timeout: N }
        if (
            typeof endpoint === 'string' &&
            /\/v4\/sessions\/[^/]+$/.test(endpoint) &&
            body != null &&
            'resumingKey' in body
        ) {
            if (process.env.DEBUG_RECOVERY)
                console.log(`[LL-KA] 🔧 Fixed session PATCH: {resumingKey} → {resuming:true} for ${_nodeKey(node)}`);
            body = { resuming: true, timeout: body.timeout || RESUME_TIMEOUT_SEC };
        }
        return origPatch(endpoint, body, ...args);
    };
}

/**
 * Fix #2 — يُعيد كتابة connect() ليُرسل "Session-Id" (Lavalink v4) بدل "Resume-Key" (v3).
 *
 * بدون هذا: كل reconnect = session جديد حتى لو أرسلنا PATCH صحيح
 * لأن Lavalink يُطابق الـ session عبر هذا الهيدر فقط.
 */
function patchNodeConnectV4(node) {
    if (node._llKaV4ConnectPatched) return;
    node._llKaV4ConnectPatched = true;

    // نحتفظ بمرجع للـ connect الأصلي للحالات الطارئة
    const origConnect = node.connect.bind(node);

    node.connect = function() {
        return new Promise((resolve) => {
            if (node.isConnected) return resolve(true);
            if (node.ws) node.ws.close();

            if (!node.poru.nodes.get(node.options.name))
                node.poru.nodes.set(node.options.name, node);

            if (!node.poru.userId) {
                // userId غير جاهز بعد — استخدم connect الأصلي
                return origConnect().then(resolve).catch(() => resolve(false));
            }

            const headers = {
                Authorization: node.password,
                'User-Id':     node.poru.userId,
                'Client-Name': node.clientName,
            };

            // Fix #2: Session-Id بدل Resume-Key
            const key     = _nodeKey(node);
            const stored  = _getStoredSession(key);
            const session = stored || node.resumeKey || null;
            if (session) {
                headers['Session-Id'] = session;   // ← Lavalink v4 الصحيح
                // نبقي resumeKey حتى يُرسل Poru PATCH لنعترضه ونصلحه
                node.resumeKey = session;
                console.log(`[LL-KA] 🔗 Connect with Session-Id …${session.slice(-6)} for ${key}`);
            }

            try {
                node.ws = new WS(node.socketURL, { headers });
                node.ws.on('open',    node.open.bind(node));
                node.ws.on('error',   node.error.bind(node));
                node.ws.on('message', node.message.bind(node));
                node.ws.on('close',   node.close.bind(node));
                node.ws.on('upgrade', (req) => node.upgrade(req));
                resolve(true);
            } catch (err) {
                console.warn(`[LL-KA] patchNodeConnectV4 error for ${key}: ${err?.message || err} — falling back`);
                origConnect().then(resolve).catch(() => resolve(false));
            }
        });
    };
}

/**
 * Fix #11 — يعترض ready packet ليكشف resumed:true/false.
 * مفيد للتشخيص: نعرف هل الـ session استُعيد فعلاً أم أُنشئ من جديد.
 */
function patchNodeMessageHandler(node) {
    if (node._llKaMsgPatched) return;
    node._llKaMsgPatched = true;

    const origMessage = node.message.bind(node);
    node.message = async function(payload) {
        try {
            const packet = JSON.parse(payload);
            if (packet?.op === 'ready') {
                const key = _nodeKey(node);
                if (packet.resumed === true) {
                    console.log(`[LL-KA] ✅ Session RESUMED (${key}) session:…${String(packet.sessionId || '').slice(-6)}`);
                } else {
                    // session جديد — سنحتاج لإعادة تأسيس كل شيء
                    console.log(`[LL-KA] 🆕 New session (${key}) session:…${String(packet.sessionId || '').slice(-6)}`);
                }
            }
        } catch {}
        return origMessage(payload);
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// Fix #3: WS ping كل 25s
// ══════════════════════════════════════════════════════════════════════════════
function startWsPing(node) {
    stopWsPing(node);
    const iv = setInterval(() => {
        if (!node.isConnected) return;
        const ws = node.ws;
        if (!ws || ws.readyState !== 1) return;
        try { if (typeof ws.ping === 'function') ws.ping(Buffer.alloc(0)); } catch {}
    }, WS_PING_MS);
    iv.unref?.();
    node._llKaPingIv = iv;
}
function stopWsPing(node) {
    if (node._llKaPingIv) { clearInterval(node._llKaPingIv); node._llKaPingIv = null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// Fix #7: REST health monitor
// ══════════════════════════════════════════════════════════════════════════════
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
                method: 'GET', headers: { authorization: node.options.password },
                headersTimeout: 7000, bodyTimeout: 7000,
            });
            await res.body?.text?.().catch(() => '');
            if (res.statusCode < 400) { failures = 0; }
            else {
                failures++;
                if (failures >= REST_HEALTH_MAX_FAIL) { failures = 0; onFailed(`HTTP ${res.statusCode}`); }
            }
        } catch (err) {
            failures++;
            if (failures >= REST_HEALTH_MAX_FAIL) {
                failures = 0; onFailed(err?.message || 'REST error');
            }
        }
    }, REST_HEALTH_MS);
    iv.unref?.();
    node._llKaHealthIv = iv;
}
function stopRestHealthMonitor(node) {
    if (node._llKaHealthIv) { clearInterval(node._llKaHealthIv); node._llKaHealthIv = null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// Fix #5: حقن session محفوظ
// ══════════════════════════════════════════════════════════════════════════════
function injectStoredSession(node) {
    const key    = _nodeKey(node);
    const stored = _getStoredSession(key);
    if (stored) {
        node.resumeKey = stored;
        if (process.env.DEBUG_RECOVERY)
            console.log(`[LL-KA] Injected stored session …${stored.slice(-6)} into node ${key}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Fix #9: اختيار الـ node الأخف تحميلاً
// ══════════════════════════════════════════════════════════════════════════════
function getBestNode(poru) {
    if (!poru?.nodes?.size) return null;
    let best = null, bestScore = Infinity;
    poru.nodes.forEach(node => {
        if (!node.isConnected) return;
        const cpu     = node.stats?.cpu?.systemLoad    ?? 0;
        const llLoad  = node.stats?.cpu?.lavalinkLoad  ?? 0;
        const players = node.stats?.players            ?? node.players?.size ?? 0;
        const score   = (cpu * 0.6) + (llLoad * 0.3) + (players * 0.001);
        if (score < bestScore) { bestScore = score; best = node; }
    });
    return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// Fix #6: إعادة تطبيق الفلاتر بعد session جديد
// ══════════════════════════════════════════════════════════════════════════════
/**
 * يُعيد إرسال filters الحالية للاعب إلى Lavalink.
 * استدعِه بعد كل voice session refresh لضمان بقاء الفلاتر.
 */
async function reapplyPlayerFilters(player) {
    try {
        const filters = player?.filters;
        if (!filters || !player.node?.rest) return;

        // تحقق من وجود أي filter نشط
        const hasActiveFilter =
            (Array.isArray(filters.equalizer) && filters.equalizer.length > 0) ||
            filters.karaoke   != null ||
            filters.timescale != null ||
            filters.tremolo   != null ||
            filters.vibrato   != null ||
            filters.rotation  != null ||
            filters.distortion!= null ||
            filters.channelMix!= null ||
            filters.lowPass   != null ||
            (filters.volume != null && filters.volume !== 1);

        if (!hasActiveFilter) return;

        await player.node.rest.updatePlayer({
            guildId: player.guildId,
            data: { filters },
        });
        if (process.env.DEBUG_RECOVERY)
            console.log(`[LL-KA] 🎛️  Filters reapplied for guild ${player.guildId}`);
    } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// نقاط الدخول الرئيسية
// ══════════════════════════════════════════════════════════════════════════════

/**
 * استدعِ على nodeConnect و nodeReconnect.
 * يُطبّق كل الإصلاحات.
 */
async function onNodeConnect(node, client) {
    const key       = _nodeKey(node);
    const sessionId = node.sessionId || node.rest?.sessionId;

    if (sessionId) {
        _saveSession(key, sessionId);
        node.resumeKey = sessionId;
    } else {
        console.warn(`[LL-KA] ⚠️  No sessionId on nodeConnect for ${key}`);
    }

    // Fix #1: اعترض PATCH الخاطئ (يُصلّح timing bug الحرج)
    patchNodeRestPatch(node);

    // Fix #2: اعترض connect() لإرسال Session-Id الصحيح
    patchNodeConnectV4(node);

    // Fix #11: تتبع resumed status
    patchNodeMessageHandler(node);

    // Fix #3: WS ping
    startWsPing(node);

    // Fix #7: REST health monitor
    startRestHealthMonitor(node, (reason) => {
        if (!node.isConnected) return;
        console.warn(`[LL-KA] 🔄 Forcing reconnect: ${key} (${reason})`);
        stopWsPing(node);
        stopRestHealthMonitor(node);
        try { injectStoredSession(node); node.connect?.(); } catch {}
    });
}

/**
 * استدعِ على nodeDisconnect.
 */
function onNodeDisconnect(node) {
    stopWsPing(node);
}

/**
 * Fix #4: استدعِ على shardResume و shardReconnecting.
 */
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

/**
 * استدعِ قبل poru.init() — يُطبّق كل الترقيعات على nodes قبل الاتصال.
 */
function prepareNodes(poru) {
    if (!poru?.nodes) return;
    poru.nodes.forEach(node => {
        injectStoredSession(node);
        patchNodeRestPatch(node);
        patchNodeConnectV4(node);
        patchNodeMessageHandler(node);
    });
}

/**
 * Fix #10: استدعِ قبل TrueMusic.destroy() — يُوقف كل intervals.
 */
function destroyKeepAlive(poru) {
    if (!poru?.nodes) return;
    poru.nodes.forEach(node => {
        stopWsPing(node);
        stopRestHealthMonitor(node);
    });
}

module.exports = {
    onNodeConnect,
    onNodeDisconnect,
    onShardReconnect,
    prepareNodes,
    destroyKeepAlive,
    getBestNode,
    reapplyPlayerFilters,
    patchNodeRestPatch,
    patchNodeConnectV4,
    patchNodeMessageHandler,
    enableServerResuming: async (node, sessionId) => {
        // backward compat — الآن rest.patch مرقّع يتولى الأمر تلقائياً
        if (!node?.rest || !sessionId) return false;
        try {
            const res = await node.rest.patch(`/v4/sessions/${sessionId}`, {
                resuming: true, timeout: RESUME_TIMEOUT_SEC,
            });
            return true;
        } catch { return false; }
    },
    startWsPing,
    stopWsPing,
    injectStoredSession,
};
