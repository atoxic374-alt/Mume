'use strict';

const WS = require('ws');
const lavalinkConsole = require('./lavalinkConsole');

const RESUME_TIMEOUT_SEC = Math.max(30, Number(process.env.LAVALINK_RESUME_TIMEOUT_SEC || 600));
const WS_PING_MS = Math.max(15_000, Number(process.env.LAVALINK_WS_PING_MS || 25_000));
const WS_PONG_TIMEOUT_MS = Math.max(45_000, Number(process.env.LAVALINK_WS_PONG_TIMEOUT_MS || 90_000));

function nodeKey(node) {
    return `${node?.options?.host || 'unknown'}:${node?.options?.port || 'unknown'}`;
}

function nodeOrigin(node) {
    const proto = node?.options?.secure ? 'https' : 'http';
    const host = node?.options?.host;
    const port = node?.options?.port;
    if (!host || !port) return null;
    return `${proto}://${host}:${port}`;
}

function patchSessionPayload(node) {
    const rest = node?.rest;
    if (!rest || rest._llSessionPayloadPatched) return;
    rest._llSessionPayloadPatched = true;

    const originalPatch = rest.patch.bind(rest);
    rest.patch = async function(endpoint, body, ...args) {
        if (
            typeof endpoint === 'string' &&
            /\/v4\/sessions\/[^/]+$/.test(endpoint) &&
            body &&
            Object.prototype.hasOwnProperty.call(body, 'resumingKey')
        ) {
            body = {
                resuming: true,
                timeout: Math.max(30, Number(body.timeout || RESUME_TIMEOUT_SEC)),
            };
        }
        return originalPatch(endpoint, body, ...args);
    };
}

async function enableServerResuming(node, sessionId = node?.sessionId || node?.rest?.sessionId) {
    if (!node?.rest || !sessionId) return false;

    patchSessionPayload(node);

    try {
        const response = await node.rest.patch(`/v4/sessions/${sessionId}`, {
            resuming: true,
            timeout: RESUME_TIMEOUT_SEC,
        });

        if (response?.status && Number(response.status) >= 400) {
            lavalinkConsole.updateNode(node, 'resume_failed', {
                event: 'resume_config_failed',
                note: response.message || response.error || response.status,
            });
            return false;
        }

        node._llResumeSessionId = sessionId;
        node._llResumeReady = true;
        return true;
    } catch (err) {
        lavalinkConsole.updateNode(node, 'resume_error', {
            event: 'resume_config_error',
            note: err?.message || err,
        });
        return false;
    }
}

function scheduleResumeEnable(node) {
    if (!node || node._llResumeEnableTimer) return;

    let attempts = 0;
    const interval = setInterval(() => {
        attempts++;

        const sessionId = node.sessionId || node.rest?.sessionId;
        if (sessionId) {
            clearInterval(interval);
            node._llResumeEnableTimer = null;
            enableServerResuming(node, sessionId).catch(() => {});
            return;
        }

        if (attempts >= 40 || !node.ws) {
            clearInterval(interval);
            node._llResumeEnableTimer = null;
        }
    }, 250);

    interval.unref?.();
    node._llResumeEnableTimer = interval;
}

function patchNodeConnectV4(node) {
    if (!node || node._llV4ConnectPatched) return;
    node._llV4ConnectPatched = true;

    const originalConnect = node.connect.bind(node);

    node.connect = function() {
        const sessionId = node._llResumeSessionId || node.sessionId || node.rest?.sessionId;
        if (!sessionId || !node.poru?.userId) {
            return originalConnect();
        }

        return new Promise((resolve) => {
            try {
                if (node.isConnected) return resolve(true);
                if (node.ws) {
                    try {
                        node.ws.removeAllListeners();
                        node.ws.close();
                    } catch {}
                }

                if (!node.poru.nodes.get(node.options.name)) {
                    node.poru.nodes.set(node.options.name, node);
                }

                const headers = {
                    Authorization: node.password,
                    'User-Id': node.poru.userId,
                    'Client-Name': node.clientName,
                    'Session-Id': sessionId,
                };

                node._llTriedResumeSessionId = sessionId;
                node._llAwaitingReadyFromResume = sessionId;
                node.ws = new WS(node.socketURL, { headers });
                node.ws.on('open', node.open.bind(node));
                node.ws.on('error', node.error.bind(node));
                node.ws.on('message', node.message.bind(node));
                node.ws.on('close', node.close.bind(node));
                node.ws.on('upgrade', (request) => node.upgrade(request));
                resolve(true);
            } catch (err) {
                lavalinkConsole.updateNode(node, 'connect_error', {
                    event: 'connect_patch_failed',
                    note: err?.message || err,
                });
                originalConnect().then(resolve).catch(() => resolve(false));
            }
        });
    };
}

function clearResumeSession(node) {
    node._llResumeSessionId = null;
    node._llTriedResumeSessionId = null;
    node._llAwaitingReadyFromResume = null;
    node._llResumeReady = false;
    node.sessionId = null;
    if (node.rest) {
        if (typeof node.rest.setSessionId === 'function') {
            node.rest.setSessionId(null);
        } else {
            node.rest.sessionId = null;
        }
    }
}

function patchNodeCloseHandler(node) {
    if (!node || node._llCloseHandlerPatched) return;
    node._llCloseHandlerPatched = true;

    const originalClose = node.close.bind(node);

    node.close = async function(code, ...args) {
        if (node._llAwaitingReadyFromResume) {
            lavalinkConsole.updateNode(node, 'resume_retry', {
                event: 'resume_closed_before_ready',
                note: 'Retrying with a fresh session',
            });
            clearResumeSession(node);
        }

        return originalClose(code, ...args);
    };
}

function patchNodeMessageHandler(node) {
    if (!node || node._llReadyHandlerPatched) return;
    node._llReadyHandlerPatched = true;

    const originalMessage = node.message.bind(node);

    node.message = async function(payload) {
        let packet = null;
        try { packet = JSON.parse(payload); } catch {}

        const result = await originalMessage(payload);

        if (packet?.op === 'ready' && packet.sessionId) {
            node._llAwaitingReadyFromResume = null;
            node._llResumeSessionId = packet.sessionId;
            if (packet.resumed === true) {
                lavalinkConsole.updateNode(node, 'online', {
                    event: 'session_resumed',
                    note: `session ...${String(packet.sessionId).slice(-6)}`,
                });
            } else if (node._llTriedResumeSessionId) {
                lavalinkConsole.updateNode(node, 'online', {
                    event: 'fresh_session',
                    note: `session ...${String(packet.sessionId).slice(-6)}`,
                });
            }
            node._llTriedResumeSessionId = null;
            await enableServerResuming(node, packet.sessionId);
        }

        return result;
    };
}

function startWsPing(node) {
    stopWsPing(node);
    node._llLastPongAt = Date.now();

    const attachPongHandler = () => {
        const ws = node?.ws;
        if (!ws || ws._llPongHandlerAttached) return;
        ws._llPongHandlerAttached = true;
        ws.on?.('pong', () => {
            node._llLastPongAt = Date.now();
        });
    };

    attachPongHandler();
    const interval = setInterval(() => {
        const ws = node?.ws;
        if (!ws || ws.readyState !== 1) return;
        attachPongHandler();

        const lastPongAt = Number(node._llLastPongAt || 0);
        if (lastPongAt && Date.now() - lastPongAt > WS_PONG_TIMEOUT_MS) {
            lavalinkConsole.updateNode(node, 'reconnecting', {
                event: 'ws_pong_timeout',
                note: `No Lavalink pong for ${Math.floor((Date.now() - lastPongAt) / 1000)}s`,
            });
            try {
                node.isConnected = false;
                node._llLastPongAt = Date.now();
            } catch {}
            try { ws.terminate?.(); } catch {}
            try { ws.close?.(); } catch {}
            // Do not call node.connect() here. Poru's close handler owns the
            // reconnect schedule; racing it can create duplicate Lavalink sockets.
            return;
        }

        try {
            if (typeof ws.ping === 'function') ws.ping(Buffer.alloc(0));
        } catch {}
    }, WS_PING_MS);
    interval.unref?.();
    node._llPingInterval = interval;
}

function stopWsPing(node) {
    if (!node?._llPingInterval) return;
    clearInterval(node._llPingInterval);
    node._llPingInterval = null;
    node._llLastPongAt = null;
}

function getBestNode(poru) {
    if (!poru?.nodes?.size) return null;

    let best = null;
    let bestScore = Infinity;

    poru.nodes.forEach(node => {
        if (!node?.isConnected) return;
        const cpu = Number(node.stats?.cpu?.systemLoad || 0);
        const lavalink = Number(node.stats?.cpu?.lavalinkLoad || 0);
        const players = Number(node.stats?.players || node.players?.size || 0);
        const score = (cpu * 0.6) + (lavalink * 0.3) + (players * 0.001);
        if (score < bestScore) {
            bestScore = score;
            best = node;
        }
    });

    return best;
}

async function reapplyPlayerFilters(player) {
    try {
        const filters = player?.filters;
        if (!filters || !player.node?.rest) return;

        const hasActiveFilter =
            (Array.isArray(filters.equalizer) && filters.equalizer.length > 0) ||
            filters.karaoke != null ||
            filters.timescale != null ||
            filters.tremolo != null ||
            filters.vibrato != null ||
            filters.rotation != null ||
            filters.distortion != null ||
            filters.channelMix != null ||
            filters.lowPass != null ||
            (filters.volume != null && filters.volume !== 1);

        if (!hasActiveFilter) return;

        await player.node.rest.updatePlayer({
            guildId: player.guildId,
            data: { filters },
        });
    } catch {}
}

async function onNodeConnect(node) {
    patchSessionPayload(node);
    patchNodeConnectV4(node);
    patchNodeCloseHandler(node);
    patchNodeMessageHandler(node);
    startWsPing(node);
    scheduleResumeEnable(node);

    const sessionId = node?.sessionId || node?.rest?.sessionId;
    if (sessionId) await enableServerResuming(node, sessionId);
}

function onNodeDisconnect(node) {
    stopWsPing(node);
}

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
                        guildId: player.guildId,
                        voiceChannel: player.voiceChannel,
                        textChannel: player.textChannel,
                        deaf: true,
                        mute: false,
                    });
                    refreshed++;
                }
            } catch {}
        });

        if (refreshed > 0) {
            lavalinkConsole.updateBot(client, {
                state: 'voice_refresh',
                event: 'shard_reconnect_refresh',
                note: `Refreshed voice state for ${refreshed} player(s)`,
                players: poru.players?.size || 0,
            });
        }
    }, delayMs).unref?.();
}

function prepareNodes(poru) {
    if (!poru?.nodes) return;
    poru.nodes.forEach(node => {
        patchSessionPayload(node);
        patchNodeConnectV4(node);
        patchNodeCloseHandler(node);
        patchNodeMessageHandler(node);
    });
}

function destroyKeepAlive(poru) {
    if (!poru?.nodes) return;
    poru.nodes.forEach(node => stopWsPing(node));
}

module.exports = {
    onNodeConnect,
    onNodeDisconnect,
    onShardReconnect,
    prepareNodes,
    destroyKeepAlive,
    getBestNode,
    reapplyPlayerFilters,
    patchNodeRestPatch: patchSessionPayload,
    patchNodeConnectV4,
    patchNodeCloseHandler,
    patchNodeMessageHandler,
    clearResumeSession,
    enableServerResuming,
    startWsPing,
    stopWsPing,
    nodeOrigin,
};
