'use strict';

const SUPPORTED_EVENT_TYPES = new Set([
    'TrackStartEvent',
    'TrackEndEvent',
    'TrackStuckEvent',
    'TrackExceptionEvent',
    'WebSocketClosedEvent',
]);
const LOG_COOLDOWN_MS = 60_000;
const warningBuckets = new Map();
const PATCHED = Symbol.for('mume.poruUnknownEventGuard');

function getEventSummary(data) {
    const event = data && typeof data === 'object' ? data : {};
    const summary = {
        type: typeof event.type === 'string' ? event.type : null,
        keys: Object.keys(event).slice(0, 12),
    };
    for (const key of ['guildId', 'reason', 'code']) {
        if (typeof event[key] === 'string' || typeof event[key] === 'number') summary[key] = event[key];
    }
    if (event.exception && typeof event.exception === 'object') {
        const exception = {};
        for (const key of ['message', 'severity', 'cause']) {
            if (typeof event.exception[key] === 'string') exception[key] = event.exception[key].slice(0, 240);
        }
        if (Object.keys(exception).length) summary.exception = exception;
    }
    return summary;
}

function installPoruUnknownEventGuard(poru, logger = console) {
    if (!poru || typeof poru.on !== 'function') return false;

    poru.on('playerCreate', player => {
        if (!player || typeof player.eventHandler !== 'function' || player[PATCHED]) return;
        const originalHandler = player.eventHandler;
        player[PATCHED] = true;

        player.eventHandler = async function guardedEventHandler(data) {
            if (SUPPORTED_EVENT_TYPES.has(data?.type)) {
                return originalHandler.call(this, data);
            }

            const nodeName = this.node?.options?.name || this.node?.options?.host || 'Unknown';
            const type = typeof data?.type === 'string' ? data.type : '<missing>';
            const key = `${nodeName}:${type}`;
            const now = Date.now();
            const previous = warningBuckets.get(key);

            if (previous && now - previous.loggedAt < LOG_COOLDOWN_MS) {
                previous.suppressed++;
                return undefined;
            }

            const suppressed = previous?.suppressed || 0;
            warningBuckets.set(key, { loggedAt: now, suppressed: 0 });
            logger.warn(
                `[Poru] Ignored unsupported Lavalink event; node=${nodeName}; guild=${this.guildId || 'unknown'}; suppressed=${suppressed}; payload=${JSON.stringify(getEventSummary(data))}`,
            );
            return undefined;
        };
    });

    return true;
}

module.exports = { installPoruUnknownEventGuard };
