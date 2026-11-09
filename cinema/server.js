'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const axios = require('axios');
const WebSocket = require('ws');
const { Pool } = require('pg');

const PORT = Number(process.env.CINEMA_PORT || 3010);
const HOST = process.env.CINEMA_HOST || '0.0.0.0';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const CONSUMET_API_URL = (process.env.CONSUMET_API_URL || '').replace(/\/+$/, '');
const ALLOWED_MEDIA_HOSTS = (process.env.CINEMA_ALLOWED_MEDIA_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const DATA_DIR = path.join(__dirname, 'data');
const ROOM_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = Number(process.env.CINEMA_MAX_ROOMS || 500);
const MAX_QUEUE = 100;
const MAX_CHAT = 100;
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INSTANCE_ID = id(8);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.CINEMA_DB_POOL_SIZE || 5), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } : undefined }) : null;
const rooms = new Map();
const connections = new Map();
const tokenCache = new Map();
const requestLimits = new Map();
let saveTimer = null;
let isSaving = false;
let saveAgain = false;

const now = () => Date.now();
const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max || 180);
const json = (res, status, payload, extraHeaders) => {
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  }, extraHeaders || {}));
  res.end(JSON.stringify(payload));
};
const id = (bytes) => crypto.randomBytes(bytes || 12).toString('base64url');
const roomIdValid = value => /^[a-zA-Z0-9_-]{5,32}$/.test(String(value || ''));
const isPrivateAddress = host => {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  if (/^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
};
function validateMediaUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'https:' || u.username || u.password || isPrivateAddress(u.hostname)) return null;
    if (ALLOWED_MEDIA_HOSTS.length && !ALLOWED_MEDIA_HOSTS.some(host => u.hostname.toLowerCase() === host || u.hostname.toLowerCase().endsWith('.' + host))) return null;
    if (u.href.length > 2048) return null;
    return u.href;
  } catch { return null; }
}
function limited(key, max, windowMs) {
  const t = now();
  let entry = requestLimits.get(key);
  if (!entry || t - entry.start >= windowMs) entry = { start: t, count: 0 };
  entry.count++;
  requestLimits.set(key, entry);
  if (requestLimits.size > 10000) {
    for (const [k, v] of requestLimits) if (t - v.start > windowMs * 2) requestLimits.delete(k);
  }
  return entry.count <= max;
}
async function body(req, limit) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > (limit || 32768)) throw Object.assign(new Error('Request body too large'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}
async function discordRequest(url, options) {
  const response = await axios(Object.assign({ url, timeout: 10000, maxContentLength: 2 * 1024 * 1024 }, options || {}));
  return response.data;
}
async function authenticateToken(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) throw Object.assign(new Error('Discord authentication is required'), { status: 401 });
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now()) return cached.user;
  const user = await discordRequest('https://discord.com/api/users/@me', {
    headers: { authorization: 'Bearer ' + token }
  });
  if (!user || !user.id) throw Object.assign(new Error('Discord authentication failed'), { status: 401 });
  tokenCache.set(key, { user: { id: String(user.id), username: text(user.username, 64), globalName: text(user.global_name, 64), avatar: text(user.avatar, 128) }, expiresAt: now() + 4 * 60 * 1000 });
  if (tokenCache.size > 5000) for (const [k, v] of tokenCache) if (v.expiresAt < now()) tokenCache.delete(k);
  return tokenCache.get(key).user;
}
function getBearer(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}
async function requireUser(req) { return authenticateToken(getBearer(req)); }
async function exchangeCode(code) {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) throw Object.assign(new Error('Discord OAuth is not configured'), { status: 503 });
  const form = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI
  });
  const token = await discordRequest('https://discord.com/api/oauth2/token', {
    method: 'POST', data: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  const user = await discordRequest('https://discord.com/api/users/@me', {
    headers: { authorization: 'Bearer ' + token.access_token }
  });
  return { access_token: token.access_token, token_type: token.token_type, expires_in: token.expires_in, user };
}
function normalizeRoom(room) {
  if (!room || !room.id) return null;
  return {
    id: text(room.id, 32),
    inviteCode: text(room.inviteCode || id(18), 64),
    name: text(room.name || 'Watch Party', 48),
    ownerId: String(room.ownerId || ''),
    hostId: String(room.hostId || room.ownerId || ''),
    visibility: room.visibility === 'public' ? 'public' : 'private',
    createdAt: Number(room.createdAt || now()),
    updatedAt: Number(room.updatedAt || now()),
    state: Object.assign({ status: 'paused', media: null, currentTime: 0, anchorAt: now(), updatedAt: now(), loop: false }, room.state || {}),
    queue: Array.isArray(room.queue) ? room.queue.slice(0, MAX_QUEUE).map(normalizeMedia).filter(Boolean) : [],
    chat: Array.isArray(room.chat) ? room.chat.slice(-MAX_CHAT).map(x => ({ id: text(x.id, 32), userId: String(x.userId || ''), username: text(x.username, 64), message: text(x.message, 500), at: Number(x.at || now()) })) : [],
    votes: Array.isArray(room.votes) ? room.votes.map(String).slice(0, 500) : [],
    settings: Object.assign({ allowChat: true, allowQueue: true, syncEnabled: true, voteSkip: true }, room.settings || {})
  };
}
function normalizeMedia(item) {
  if (!item || typeof item !== 'object') return null;
  const url = validateMediaUrl(item.url);
  if (!url) return null;
  return {
    id: text(item.id || id(8), 80),
    title: text(item.title || 'Untitled media', 180),
    url,
    kind: ['movie', 'episode', 'video'].includes(item.kind) ? item.kind : 'video',
    poster: safeImage(item.poster),
    duration: Math.max(0, Math.min(Number(item.duration) || 0, 24 * 60 * 60)),
    addedBy: String(item.addedBy || '')
  };
}
function safeImage(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' && !isPrivateAddress(u.hostname) ? u.href.slice(0, 2048) : null;
  } catch { return null; }
}
async function loadRooms() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS cinema_rooms (id VARCHAR(32) PRIMARY KEY, data JSONB NOT NULL, updated_at BIGINT NOT NULL)');
    const result = await pool.query('SELECT data FROM cinema_rooms WHERE updated_at > $1', [now() - ROOM_TTL_MS]);
    for (const row of result.rows) { const room = normalizeRoom(row.data); if (room) rooms.set(room.id, room); }
    return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const parsed = JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8'));
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      const room = normalizeRoom(raw);
      if (room && now() - room.updatedAt < ROOM_TTL_MS) rooms.set(room.id, room);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[Cinema] room restore failed:', error.message);
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveRooms().catch(error => console.error('[Cinema] save failed:', error.message)); }, 300);
  saveTimer.unref?.();
}
async function saveRooms() {
  if (isSaving) { saveAgain = true; return; }
  isSaving = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const snapshot = [...rooms.values()].map(room => Object.assign({}, room, { participants: undefined }));
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const room of snapshot) await client.query('INSERT INTO cinema_rooms (id, data, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at', [room.id, JSON.stringify(room), room.updatedAt]);
        await client.query('DELETE FROM cinema_rooms WHERE updated_at < $1', [now() - ROOM_TTL_MS]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    } else {
      const temp = ROOM_FILE + '.' + process.pid + '.tmp';
      await fs.promises.writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
      await fs.promises.rename(temp, ROOM_FILE);
    }
  } finally {
    isSaving = false;
    if (saveAgain) { saveAgain = false; scheduleSave(); }
  }
}
function getRoom(roomKey) {
  let room = rooms.get(roomKey);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) throw Object.assign(new Error('Room capacity reached'), { status: 503 });
    room = normalizeRoom({ id: roomKey, ownerId: '', hostId: '', createdAt: now(), updatedAt: now() });
    rooms.set(roomKey, room);
  }
  return room;
}
function roomSnapshot(room) {
  const state = Object.assign({}, room.state);
  if (state.status === 'playing' && state.anchorAt) state.currentTime = Math.max(0, state.currentTime + (now() - state.anchorAt) / 1000);
  state.serverTime = now();
  return {
    id: room.id, name: room.name, ownerId: room.ownerId, hostId: room.hostId,
    visibility: room.visibility, state, queue: room.queue,
    chat: room.chat.slice(-40), votes: room.votes,
    settings: room.settings,
    participants: [...(connections.get(room.id) || new Map()).values()].map(x => x.user)
  };
}
function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 512 * 1024) { ws.close(1013, 'Client is too slow'); return; }
  ws.send(JSON.stringify(payload));
}
function broadcast(room, payload) {
  const peers = connections.get(room.id);
  if (!peers) return;
  const message = payload || { type: 'room:state', room: roomSnapshot(room) };
  for (const peer of peers.values()) send(peer.ws, message);
}
function publish(room) { room.updatedAt = now(); scheduleSave(); broadcast(room); }
function addParticipant(room, user, ws) {
  let peers = connections.get(room.id);
  if (!peers) { peers = new Map(); connections.set(room.id, peers); }
  peers.set(user.id, { user, ws, joinedAt: now() });
  if (!room.ownerId) { room.ownerId = user.id; room.hostId = user.id; }
  broadcast(room, { type: 'room:presence', participants: [...peers.values()].map(x => x.user) });
}
function removeParticipant(room, userId, ws) {
  const peers = connections.get(room.id);
  if (!peers) return;
  const current = peers.get(userId);
  if (current && current.ws === ws) peers.delete(userId);
  if (!peers.size) connections.delete(room.id);
  if (room.hostId === userId && !peers.size) {
    room.state.status = 'paused';
    room.state.anchorAt = now();
  } else if (room.hostId === userId && peers.size) {
    const next = peers.values().next().value.user.id;
    room.hostId = next;
    broadcast(room, { type: 'room:notice', message: 'The host disconnected. Host control was transferred.' });
  }
  publish(room);
  broadcast(room, { type: 'room:presence', participants: [...(connections.get(room.id) || new Map()).values()].map(x => x.user) });
}
function requireHost(room, user) {
  if (room.hostId !== user.id && room.ownerId !== user.id) throw Object.assign(new Error('Only the room host can do this'), { status: 403 });
}
function currentTime(state) {
  return Math.max(0, Number(state.currentTime || 0) + (state.status === 'playing' ? (now() - Number(state.anchorAt || now())) / 1000 : 0));
}
function processRoomAction(room, user, msg) {
  const action = text(msg.action, 32);
  const isHost = room.hostId === user.id || room.ownerId === user.id;
  if (action === 'play' || action === 'pause' || action === 'seek' || action === 'load' || action === 'next' || action === 'host:transfer' || action === 'settings:update' || action === 'queue:clear') requireHost(room, user);
  if (action === 'load') {
    const media = normalizeMedia(Object.assign({}, msg.media, { addedBy: user.id }));
    if (!media) throw Object.assign(new Error('This media URL is not allowed. Use an authorized HTTPS source.'), { status: 400 });
    room.state.media = media; room.state.currentTime = 0; room.state.anchorAt = now(); room.state.status = 'playing'; room.votes = [];
  } else if (action === 'play') {
    if (!room.state.media) throw Object.assign(new Error('Choose a video before pressing play'), { status: 409 });
    room.state.currentTime = currentTime(room.state); room.state.anchorAt = now(); room.state.status = 'playing';
  } else if (action === 'pause') {
    room.state.currentTime = currentTime(room.state); room.state.anchorAt = now(); room.state.status = 'paused';
  } else if (action === 'seek') {
    const target = Number(msg.currentTime);
    if (!Number.isFinite(target) || target < 0 || target > 24 * 60 * 60) throw Object.assign(new Error('Invalid seek position'), { status: 400 });
    room.state.currentTime = target; room.state.anchorAt = now();
  } else if (action === 'queue:add') {
    if (!room.settings.allowQueue) throw Object.assign(new Error('Queue is disabled for this room'), { status: 403 });
    if (room.queue.length >= MAX_QUEUE) throw Object.assign(new Error('Queue is full'), { status: 409 });
    const media = normalizeMedia(Object.assign({}, msg.media, { addedBy: user.id }));
    if (!media) throw Object.assign(new Error('Invalid or unauthorized media URL'), { status: 400 });
    room.queue.push(media);
  } else if (action === 'queue:remove') {
    const index = room.queue.findIndex(x => x.id === String(msg.mediaId));
    if (index < 0) throw Object.assign(new Error('Queue item was not found'), { status: 404 });
    if (!isHost && room.queue[index].addedBy !== user.id) throw Object.assign(new Error('You can only remove your own queue items'), { status: 403 });
    room.queue.splice(index, 1);
  } else if (action === 'queue:clear') {
    room.queue = [];
  } else if (action === 'next') {
    if (!room.queue.length) { room.state.status = 'paused'; room.state.currentTime = 0; room.state.anchorAt = now(); room.state.media = null; }
    else { room.state.media = room.queue.shift(); room.state.currentTime = 0; room.state.anchorAt = now(); room.state.status = 'playing'; }
    room.votes = [];
  } else if (action === 'vote:skip') {
    if (!room.settings.voteSkip) throw Object.assign(new Error('Voting is disabled'), { status: 403 });
    room.votes = [...new Set(room.votes.concat(user.id))];
    const participantCount = Math.max(1, (connections.get(room.id) || new Map()).size);
    const needed = Math.max(2, Math.ceil(participantCount * 0.6));
    if (room.votes.length >= needed) {
      if (room.queue.length) { room.state.media = room.queue.shift(); room.state.currentTime = 0; room.state.anchorAt = now(); room.state.status = 'playing'; }
      else { room.state.status = 'paused'; room.state.media = null; room.state.currentTime = 0; room.state.anchorAt = now(); }
      room.votes = [];
      return { notice: 'The room voted to skip.' };
    }
  } else if (action === 'host:transfer') {
    const target = String(msg.userId || '');
    if (!(connections.get(room.id) || new Map()).has(target)) throw Object.assign(new Error('The selected member is not in this room'), { status: 404 });
    room.hostId = target;
  } else if (action === 'settings:update') {
    const settings = msg.settings || {};
    for (const key of ['allowChat', 'allowQueue', 'syncEnabled', 'voteSkip']) if (typeof settings[key] === 'boolean') room.settings[key] = settings[key];
  } else if (action === 'chat:send') {
    if (!room.settings.allowChat) throw Object.assign(new Error('Chat is disabled'), { status: 403 });
    const message = text(msg.message, 500);
    if (!message) throw Object.assign(new Error('Message cannot be empty'), { status: 400 });
    const entry = { id: id(8), userId: user.id, username: user.globalName || user.username, message, at: now() };
    room.chat.push(entry); room.chat = room.chat.slice(-MAX_CHAT);
    return { chat: entry };
  } else if (action === 'reaction') {
    const emoji = text(msg.emoji, 16);
    if (!/^[\p{Emoji}\p{Emoji_Component}\u200d\ufe0f]+$/u.test(emoji)) throw Object.assign(new Error('Invalid reaction'), { status: 400 });
    return { reaction: { userId: user.id, emoji, at: now() } };
  } else if (action !== 'ping') {
    throw Object.assign(new Error('Unknown room action'), { status: 400 });
  }
  return {};
}
async function searchTmdb(query, type) {
  if (!TMDB_API_KEY) return { results: [], configured: false };
  const kind = type === 'tv' ? 'tv' : 'movie';
  const data = await discordRequest('https://api.themoviedb.org/3/search/' + kind, {
    params: { api_key: TMDB_API_KEY, query, include_adult: false, language: 'en-US', page: 1 }
  });
  return {
    results: (data.results || []).slice(0, 24).map(item => ({
      id: String(item.id), title: text(item.title || item.name, 180),
      poster: item.poster_path ? 'https://image.tmdb.org/t/p/w500' + item.poster_path : null,
      backdrop: item.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + item.backdrop_path : null,
      date: text(item.release_date || item.first_air_date, 20),
      overview: text(item.overview, 700), rating: Number(item.vote_average || 0),
      kind, source: 'TMDB', playable: false
    })),
    configured: true
  };
}
async function searchConsumet(query) {
  if (!CONSUMET_API_URL) return { results: [], configured: false };
  const data = await discordRequest(CONSUMET_API_URL + '/anime/gogoanime/' + encodeURIComponent(query));
  return {
    results: (Array.isArray(data.results) ? data.results : []).slice(0, 24).map(item => ({
      id: text(item.id || item.url, 250), title: text(item.title || item.name, 180),
      poster: safeImage(item.image || item.cover || item.poster),
      date: text(item.releaseDate, 20), overview: text(item.description, 700),
      kind: 'anime', source: 'Consumet', playable: false
    })).filter(item => item.title),
    configured: true
  };
}
async function catalogTrending(type) {
  if (type === 'anime') {
    if (!CONSUMET_API_URL) return { results: [], configured: false };
    return { results: [], configured: true, message: 'Search the anime catalog to discover titles.' };
  }
  if (!TMDB_API_KEY) return { results: [], configured: false };
  const kind = type === 'tv' ? 'tv' : 'movie';
  const data = await discordRequest('https://api.themoviedb.org/3/trending/' + kind + '/week', {
    params: { api_key: TMDB_API_KEY, language: 'en-US' }
  });
  return { results: (data.results || []).slice(0, 24).map(item => ({
    id: String(item.id), title: text(item.title || item.name, 180),
    poster: item.poster_path ? 'https://image.tmdb.org/t/p/w500' + item.poster_path : null,
    backdrop: item.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + item.backdrop_path : null,
    date: text(item.release_date || item.first_air_date, 20), overview: text(item.overview, 700),
    rating: Number(item.vote_average || 0), kind, source: 'TMDB', playable: false
  })), configured: true };
}
async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'mume-cinema', rooms: rooms.size, uptime: Math.floor(process.uptime()), storage: pool ? 'postgres' : 'local-json' });
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { clientId: CLIENT_ID, catalogs: { tmdb: Boolean(TMDB_API_KEY), consumet: Boolean(CONSUMET_API_URL) } });
  if (req.method === 'POST' && url.pathname === '/api/auth/exchange') {
    const data = await body(req, 8192);
    if (!data.code || typeof data.code !== 'string' || !data.state || typeof data.state !== 'string') return json(res, 400, { error: 'OAuth code and state are required' });
    const result = await exchangeCode(data.code);
    return json(res, 200, result);
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog/search') {
    const user = await requireUser(req);
    if (!limited('search:' + user.id, 25, 60_000)) return json(res, 429, { error: 'Search limit reached. Wait a moment.' });
    const query = text(url.searchParams.get('q'), 100);
    const type = text(url.searchParams.get('type') || 'movie', 10);
    if (query.length < 2) return json(res, 400, { error: 'Enter at least two characters' });
    if (!['movie', 'tv', 'anime'].includes(type)) return json(res, 400, { error: 'Unsupported catalog type' });
    const data = type === 'anime' ? await searchConsumet(query) : await searchTmdb(query, type);
    return json(res, 200, Object.assign(data, { note: 'Catalog metadata only. Playback requires an authorized media source.' }));
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog/trending') {
    await requireUser(req);
    const type = text(url.searchParams.get('type') || 'movie', 10);
    if (!['movie', 'tv', 'anime'].includes(type)) return json(res, 400, { error: 'Unsupported catalog type' });
    return json(res, 200, await catalogTrending(type));
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const user = await requireUser(req);
    const data = await body(req, 8192);
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Room capacity reached' });
    const roomKey = id(9);
    const room = normalizeRoom({
      id: roomKey, inviteCode: id(18), name: text(data.name || 'Watch Party', 48),
      ownerId: user.id, hostId: user.id, visibility: data.visibility === 'public' ? 'public' : 'private',
      createdAt: now(), updatedAt: now()
    });
    rooms.set(roomKey, room); scheduleSave();
    return json(res, 201, { room: roomSnapshot(room), inviteCode: room.inviteCode, invite: '/?room=' + roomKey + '&invite=' + room.inviteCode });
  }
  const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{5,32})$/);
  if (req.method === 'GET' && roomMatch) {
    const user = await requireUser(req);
    const room = rooms.get(roomMatch[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (room.visibility === 'private' && room.ownerId !== user.id && url.searchParams.get('invite') !== room.inviteCode && !(connections.get(room.id) || new Map()).has(user.id)) return json(res, 403, { error: 'This room is private. Ask the host for an invite.' });
    return json(res, 200, { room: roomSnapshot(room) });
  }
  return false;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const ip = req.socket.remoteAddress || 'unknown';
  if (!limited('http:' + ip, 180, 60_000)) return json(res, 429, { error: 'Too many requests' });
  try {
    const handled = await handleApi(req, res, url);
    if (handled !== false) return;
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = path.basename(url.pathname);
      const file = path.join(PUBLIC_DIR, 'assets', name);
      if (!file.startsWith(path.join(PUBLIC_DIR, 'assets'))) return json(res, 400, { error: 'Invalid path' });
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = Number(error.status || error.response?.status || 500);
    if (status >= 500) console.error('[Cinema API]', error.message);
    return json(res, status, { error: status >= 500 ? 'The cinema service could not complete this request' : text(error.message, 180) });
  }
});
const wss = new WebSocket.Server({ noServer: true, maxPayload: 16_000, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const origin = req.headers.origin || '';
  const roomKey = url.searchParams.get('room') || '';
  if (url.pathname !== '/ws' || !roomIdValid(roomKey) || (origin && !/^https:\/\//.test(origin))) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, roomKey));
});
wss.on('connection', (ws, roomKey) => {
  ws.isAlive = true;
  ws.authenticated = false;
  ws.on('pong', () => { ws.isAlive = true; });
  const authTimer = setTimeout(() => { if (!ws.authenticated) ws.close(1008, 'Authentication timeout'); }, 8000);
  ws.on('message', async raw => {
    if (!limited('ws-ip:' + (ws._socket?.remoteAddress || 'unknown'), 90, 60_000)) return ws.close(1008, 'Rate limit');
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid message format' }); }
    if (!ws.authenticated) {
      if (msg.type !== 'auth' || !msg.accessToken) return ws.close(1008, 'Authenticate first');
      try {
        const user = await authenticateToken(msg.accessToken);
        ws.user = user; ws.authenticated = true; clearTimeout(authTimer);
        const room = getRoom(roomKey);
        if (room.visibility === 'private' && room.ownerId && room.ownerId !== user.id && msg.inviteCode !== room.inviteCode && !(connections.get(room.id) || new Map()).has(user.id)) {
          ws.close(1008, 'Private room'); return;
        }
        addParticipant(room, user, ws);
        send(ws, { type: 'room:joined', room: roomSnapshot(room), user });
      } catch (error) { ws.close(1008, 'Discord authentication failed'); }
      return;
    }
    const room = rooms.get(roomKey);
    if (!room) return ws.close(1008, 'Room not found');
    if (!limited('ws-user:' + ws.user.id, 45, 10_000)) return send(ws, { type: 'error', message: 'Slow down before sending more actions.' });
    try {
      const result = processRoomAction(room, ws.user, msg);
      if (result.chat) broadcast(room, { type: 'chat:message', message: result.chat });
      else if (result.reaction) broadcast(room, { type: 'room:reaction', reaction: result.reaction });
      else if (result.notice) broadcast(room, { type: 'room:notice', message: result.notice });
      publish(room);
      if (msg.action === 'ping') send(ws, { type: 'pong', at: now() });
    } catch (error) {
      send(ws, { type: 'error', message: text(error.message, 180), code: Number(error.status || 400) });
    }
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws.authenticated && ws.user) {
      const room = rooms.get(roomKey);
      if (room) removeParticipant(room, ws.user.id, ws);
    }
  });
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { ws.terminate(); }
  }
}, 25000);
heartbeat.unref?.();
const cleanup = setInterval(() => {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [key, room] of rooms) if (room.updatedAt < cutoff && !(connections.get(key) || new Map()).size) rooms.delete(key);
  scheduleSave();
}, 60 * 60 * 1000);
cleanup.unref?.();
async function shutdown() {
  clearInterval(heartbeat); clearInterval(cleanup);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  await saveRooms().catch(() => {});
  server.close(() => { if (pool) pool.end().finally(() => process.exit(0)); else process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref?.();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
loadRooms().then(() => {
  server.listen(PORT, HOST, () => console.log('[Cinema] listening on ' + HOST + ':' + PORT + ' · storage=' + (pool ? 'postgres' : 'local-json')));
}).catch(error => {
  console.error('[Cinema] startup storage error:', error.message);
  process.exit(1);
});
