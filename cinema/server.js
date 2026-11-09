'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const axios = require('axios');
const WebSocket = require('ws');

const PORT = Number(process.env.CINEMA_PORT || 3010);
const HOST = process.env.CINEMA_HOST || '0.0.0.0';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';
const CONSUMET_API_URL = (process.env.CONSUMET_API_URL || '').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const rate = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const safeText = (value, max = 160) => String(value || '').trim().slice(0, max);
const isAllowedMediaUrl = value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  } catch { return false; }
};
function limited(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rate.get(ip) || { start: now, count: 0 };
  if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
  entry.count++;
  rate.set(ip, entry);
  if (entry.count > 90) { json(res, 429, { error: 'Too many requests. Try again shortly.' }); return true; }
  return false;
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32_000) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}
async function exchangeCode(code) {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) throw new Error('Discord OAuth is not configured');
  const form = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code',
    code, redirect_uri: REDIRECT_URI
  });
  const { data } = await axios.post('https://discord.com/api/oauth2/token', form, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 10_000
  });
  const user = await axios.get('https://discord.com/api/users/@me', {
    headers: { authorization: \`Bearer \${data.access_token}\` }, timeout: 10_000
  });
  return { access_token: data.access_token, expires_in: data.expires_in, user: user.data };
}
function publicItem(item, type) {
  return {
    id: safeText(item.id || item.url, 300),
    title: safeText(item.title || item.name, 180),
    image: isAllowedMediaUrl(item.image || item.cover || item.poster) ? (item.image || item.cover || item.poster) : null,
    type,
    releaseDate: safeText(item.releaseDate || item.releaseDate, 30),
    description: safeText(item.description, 500),
    source: 'Consumet',
    playable: false
  };
}
async function searchConsumet(query, type) {
  if (!CONSUMET_API_URL) return { items: [], unavailable: true, message: 'Set CONSUMET_API_URL to your own Consumet API instance.' };
  const provider = type === 'anime' ? 'anime/gogoanime' : 'movies/flixhq';
  const endpoint = \`\${CONSUMET_API_URL}/\${provider}/\${encodeURIComponent(query)}\`;
  const { data } = await axios.get(endpoint, { timeout: 12_000, maxContentLength: 2_000_000 });
  const list = Array.isArray(data?.results) ? data.results : [];
  return { items: list.slice(0, 24).map(item => publicItem(item, type)).filter(x => x.title), unavailable: false };
}
async function searchTmdb(query, type) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return [];
  const kind = type === 'tv' ? 'tv' : 'movie';
  const { data } = await axios.get(\`https://api.themoviedb.org/3/search/\${kind}\`, {
    params: { api_key: key, query, include_adult: false }, timeout: 10_000
  });
  return (data.results || []).slice(0, 18).map(item => ({
    id: String(item.id), title: safeText(item.title || item.name, 180),
    image: item.poster_path ? \`https://image.tmdb.org/t/p/w500\${item.poster_path}\` : null,
    type, releaseDate: safeText(item.release_date || item.first_air_date, 30),
    description: safeText(item.overview, 500), source: 'TMDB', playable: false
  }));
}
function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { id, state: { status: 'paused', mediaUrl: null, title: '', currentTime: 0, updatedAt: Date.now(), hostId: null }, clients: new Set() };
    rooms.set(id, room);
  }
  return room;
}
function broadcast(room) {
  const payload = JSON.stringify({ type: 'state', state: room.state });
  for (const ws of room.clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}
const server = http.createServer(async (req, res) => {
  if (limited(req, res)) return;
  const url = new URL(req.url, \`http://\${req.headers.host || 'localhost'}\`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'mume-cinema' });
    if (req.method === 'POST' && url.pathname === '/api/auth/exchange') {
      const body = await readBody(req);
      if (!body.code || typeof body.code !== 'string') return json(res, 400, { error: 'Authorization code is required' });
      const result = await exchangeCode(body.code);
      return json(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const query = safeText(url.searchParams.get('q'), 100);
      const type = safeText(url.searchParams.get('type') || 'movie', 10);
      if (query.length < 2) return json(res, 400, { error: 'Enter at least two characters' });
      if (!['movie', 'tv', 'anime'].includes(type)) return json(res, 400, { error: 'Unsupported catalog type' });
      const results = type === 'anime'
        ? await searchConsumet(query, 'anime')
        : await searchTmdb(query, type);
      return json(res, 200, { results: Array.isArray(results) ? results : results.items, provider: type === 'anime' ? 'Consumet' : 'TMDB', note: 'Catalog metadata only. Search results are not verified playback sources.' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.response?.status || 500;
    return json(res, status, { error: status >= 500 ? 'Cinema service request failed' : safeText(error.message, 180) });
  }
});
const wss = new WebSocket.Server({ noServer: true, maxPayload: 16_000 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, \`http://\${req.headers.host || 'localhost'}\`);
  if (url.pathname !== '/ws' || !/^[a-zA-Z0-9_-]{3,48}$/.test(url.searchParams.get('room') || '')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, url.searchParams.get('room')));
});
wss.on('connection', (ws, req, roomId) => {
  const room = getRoom(roomId);
  room.clients.add(ws);
  ws.send(JSON.stringify({ type: 'state', state: room.state }));
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!['play', 'pause', 'seek', 'load'].includes(msg.action)) return;
    const userId = safeText(msg.userId, 32);
    if (!userId) return;
    const state = room.state;
    if (state.hostId && state.hostId !== userId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Only the room host can control playback.' }));
      return;
    }
    if (!state.hostId) state.hostId = userId;
    if (msg.action === 'load') {
      if (!isAllowedMediaUrl(msg.mediaUrl)) return ws.send(JSON.stringify({ type: 'error', message: 'Use a direct HTTPS video URL that you are authorized to play.' }));
      state.mediaUrl = msg.mediaUrl;
      state.title = safeText(msg.title, 180);
      state.currentTime = 0;
      state.status = 'playing';
    } else if (msg.action === 'play') state.status = 'playing';
    else if (msg.action === 'pause') state.status = 'paused';
    else if (msg.action === 'seek' && Number.isFinite(Number(msg.currentTime))) state.currentTime = Math.max(0, Math.min(Number(msg.currentTime), 24 * 60 * 60));
    state.updatedAt = Date.now();
    broadcast(room);
  });
  ws.on('close', () => room.clients.delete(ws));
});
server.listen(PORT, HOST, () => console.log(\`[Cinema] listening on \${HOST}:\${PORT}\`));
