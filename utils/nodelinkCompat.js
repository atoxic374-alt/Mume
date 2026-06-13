'use strict';

const { EventEmitter } = require('events');

function loadMoonlink() {
  try {
    return require('moonlink.js');
  } catch (err) {
    err.message = `moonlink.js is required for NodeLink audio. Run npm install after pulling this branch. Original error: ${err.message}`;
    throw err;
  }
}

function normalizeLoopMode(mode) {
  const value = String(mode || '').toLowerCase();
  if (value === 'track' || value === 'song' || value === 'on') return 'track';
  if (value === 'queue') return 'queue';
  return 'off';
}

function legacyLoopMode(mode) {
  const value = String(mode || '').toLowerCase();
  if (value === 'track') return 'TRACK';
  if (value === 'queue') return 'QUEUE';
  return 'NONE';
}

function normalizeLoadType(loadType, result) {
  const value = String(loadType || '').toLowerCase();
  if (value.includes('playlist') || result?.isPlaylist) return 'playlist';
  if (value.includes('track') || result?.isTrack) return 'track';
  if (value.includes('search') || result?.isSearch) return 'search';
  if (value.includes('empty') || result?.isEmpty) return 'empty';
  if (value.includes('error') || result?.isError) return 'error';
  return value || (Array.isArray(result?.tracks) && result.tracks.length ? 'search' : 'empty');
}

function normalizeTrack(track, requester) {
  if (!track) return null;
  if (track.info && (track.track || track.encoded)) {
    if (!track.track && track.encoded) track.track = track.encoded;
    if (requester && !track.info.requester) track.info.requester = requester;
    return track;
  }

  const json = typeof track.toJSON === 'function' ? track.toJSON() : null;
  const info = json?.info || {
    identifier: track.identifier,
    isSeekable: track.isSeekable,
    author: track.author,
    length: track.duration ?? track.length,
    isStream: track.isStream,
    position: track.position || 0,
    title: track.title,
    uri: track.uri,
    artworkUrl: track.artworkUrl || track.thumbnail,
    sourceName: track.sourceName,
    requester: track.requester || requester,
  };

  const wrapped = {
    track: track.encoded || json?.encoded || json?.track,
    encoded: track.encoded || json?.encoded || json?.track,
    info: {
      identifier: info.identifier,
      isSeekable: info.isSeekable,
      author: info.author,
      length: info.length ?? info.duration,
      isStream: info.isStream,
      position: info.position || 0,
      title: info.title,
      uri: info.uri,
      artworkUrl: info.artworkUrl,
      sourceName: info.sourceName,
      requester: info.requester || requester,
    },
    _moonTrack: track,
  };

  return wrapped;
}

function denormalizeTrack(track) {
  if (!track) return null;
  if (track._moonTrack) return track._moonTrack;
  return track;
}

class CompatQueue extends Array {
  add(track) {
    if (Array.isArray(track)) this.push(...track.filter(Boolean));
    else if (track) this.push(track);
    return this.length;
  }

  clear() {
    this.splice(0, this.length);
  }

  get size() {
    return this.length;
  }

  get first() {
    return this[0];
  }

  get all() {
    return Array.from(this);
  }
}

class CompatRest {
  constructor(node) {
    this.node = node;
  }

  get url() {
    return this.node.origin;
  }

  get password() {
    return this.node.password;
  }

  get sessionId() {
    return this.node.sessionId;
  }

  async patch(endpoint, body) {
    const rawRest = this.node.raw?.rest;
    if (rawRest?.patch) return rawRest.patch(endpoint, body);
    return this._request('PATCH', endpoint, body);
  }

  async updatePlayer({ guildId, data }) {
    return this.patch(`/v4/sessions/${this.sessionId}/players/${guildId}?noReplace=false`, data);
  }

  async _request(method, endpoint, body) {
    if (!this.url || !this.password) throw new Error('NodeLink REST is unavailable');
    const url = endpoint.startsWith('http') ? endpoint : `${this.url}${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: this.password },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { message: text }; }
    }
    if (!response.ok) return { status: response.status, error: response.statusText, ...(parsed || {}) };
    return parsed || { status: response.status, ok: true };
  }
}

class CompatNode {
  constructor(manager, raw, options = {}) {
    this.manager = manager;
    this.audioManager = manager;
    this.raw = raw;
    this.options = {
      name: raw?.identifier || options.name || options.identifier || options.host,
      host: raw?.host || options.host,
      port: raw?.port || options.port,
      secure: raw?.secure ?? options.secure ?? false,
    };
    this.password = raw?.password || options.password;
    this.secure = this.options.secure;
    this.rest = new CompatRest(this);
    this._nodeLinkCompat = true;
  }

  get identifier() { return this.raw?.identifier || this.options.name; }
  get sessionId() { return this.raw?.sessionId || this.raw?.rest?.sessionId; }
  get stats() { return this.raw?.stats || {}; }
  get ws() { return this.raw?.ws || this.raw?.websocket?.ws || this.raw?.socket; }
  get isConnected() { return !!(this.raw?.connected ?? this.raw?.isConnected); }
  get connected() { return this.isConnected; }
  get restURL() { return this.origin; }
  get origin() { return `http${this.options.secure ? 's' : ''}://${this.options.host}:${this.options.port}`; }

  connect() { return this.raw?.connect?.(); }
  reconnect() { return this.raw?.reconnect?.(); }
  destroy() { return this.raw?.destroy?.(); }
}

class CompatPlayer {
  constructor(manager, raw, options = {}) {
    this.manager = manager;
    this.raw = raw;
    this.guildId = options.guildId || raw.guildId;
    this.data = raw.data || {};
    raw.data = this.data;
    this.queue = new CompatQueue();
    this.currentTrack = null;
    this.isPlaying = !!raw.playing;
    this.isPaused = !!raw.paused;
    this.loop = legacyLoopMode(raw.loop);
    this.node = manager.wrapNode(raw.node || raw.currentNode || raw.nodeId);
  }

  get voiceChannel() { return this.raw.voiceChannelId || this.raw.voiceChannel || this.raw.voiceId; }
  set voiceChannel(value) { this.raw.voiceChannelId = value; this.raw.voiceChannel = value; }
  get voiceChannelId() { return this.voiceChannel; }
  set voiceChannelId(value) { this.voiceChannel = value; }
  get textChannel() { return this.raw.textChannelId || this.raw.textChannel; }
  set textChannel(value) { this.raw.textChannelId = value; this.raw.textChannel = value; }
  get textChannelId() { return this.textChannel; }
  set textChannelId(value) { this.textChannel = value; }
  get volume() { return this.raw.volume || 100; }
  set volume(value) { this.raw.volume = value; }
  get position() { return this.raw.position || this.raw.current?.position || this.data.lastPosition || 0; }

  async connect(options = {}) {
    if (options.voiceChannel) this.voiceChannel = options.voiceChannel;
    if (options.textChannel) this.textChannel = options.textChannel;
    return this.raw.connect?.({
      selfDeaf: options.deaf ?? options.selfDeaf ?? true,
      selfMute: options.mute ?? options.selfMute ?? false,
    });
  }

  async disconnect() { return this.raw.disconnect?.(); }

  async play(trackOrOptions) {
    let track = trackOrOptions?.track || trackOrOptions;
    if (!track || trackOrOptions?.noReplace) track = this.queue.shift();
    if (!track && this.queue.length) track = this.queue.shift();
    if (!track) return false;
    this.currentTrack = normalizeTrack(track);
    this.isPlaying = true;
    this.isPaused = false;
    const playable = denormalizeTrack(this.currentTrack);
    const result = await this.raw.play?.(trackOrOptions?.encoded ? trackOrOptions : playable);
    return result ?? true;
  }

  async resolveTrack(track) {
    if (track?.track || track?.encoded) return { track: track.track || track.encoded };
    const query = track?.info?.uri || track?.info?.title;
    if (!query) return null;
    const result = await this.manager.resolve({ query });
    const resolved = result?.tracks?.[0];
    return resolved ? { track: resolved.track || resolved.encoded } : null;
  }

  async pause(pause = true) {
    this.isPaused = !!pause;
    this.isPlaying = !pause && !!this.currentTrack;
    if (pause === false && this.raw.resume) return this.raw.resume();
    if (pause === false && this.raw.pause) return this.raw.pause(false);
    return this.raw.pause?.(pause);
  }

  async resume() { return this.pause(false); }

  async stop() {
    this.isPlaying = false;
    this.currentTrack = null;
    return this.raw.stop?.();
  }

  async skip(position) {
    if (Number.isInteger(position) && position > 0 && position < this.queue.length) {
      this.queue.splice(0, position);
    }
    const oldTrack = this.currentTrack;
    const nextTrack = this.queue.shift();
    if (oldTrack) this.manager.emit('trackEnd', this, oldTrack, { reason: 'REPLACED' });
    if (nextTrack) return this.play(nextTrack);
    await this.raw.skip?.().catch(() => this.raw.stop?.());
    this.isPlaying = false;
    this.currentTrack = null;
    this.manager.emit('queueEnd', this);
    return true;
  }

  async seek(position) { return this.raw.seek?.(position); }
  async seekTo(position) { return this.seek(position); }

  setVolume(volume) {
    this.volume = volume;
    const result = this.raw.setVolume?.(volume);
    return result ?? this;
  }

  setLoop(mode) {
    const normalized = normalizeLoopMode(mode);
    this.loop = legacyLoopMode(normalized);
    this.raw.setLoop?.(normalized);
    return this;
  }

  async destroy(reason) {
    this.manager.players.delete(this.guildId);
    return this.raw.destroy?.(reason);
  }
}

class NodeLinkCompatManager extends EventEmitter {
  constructor(client, nodes = [], options = {}) {
    super();
    const Moonlink = loadMoonlink();
    const Manager = Moonlink.Manager || Moonlink.MoonlinkManager;
    if (!Manager) throw new Error('moonlink.js did not export Manager/MoonlinkManager.');
    this.client = client;
    this.options = { ...options, defaultPlatform: options.defaultPlatform || 'ytsearch' };
    this._nodes = nodes.map(node => ({ ...node, identifier: node.name || node.identifier || node.host }));
    this.nodes = new Map();
    this.players = new Map();
    this.userId = client?.user?.id || null;
    this.isActivated = false;

    this.manager = new Manager({
      nodes: this._nodes,
      options: {
        clientName: options.clientName || 'Mume/NodeLink',
        reconnectAttempts: options.reconnectTries || 80,
        reconnectInterval: options.reconnectTimeout || 5000,
        resume: true,
        resumeTimeout: options.resumeTimeout || 600,
        NodeLinkFeatures: true,
      },
      send: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    });

    this._rawListener = packet => this.packetUpdate(packet);
    this._wireEvents();
  }

  get leastUsedNodes() {
    return [...this.nodes.values()].filter(node => node.isConnected);
  }

  packetUpdate(packet) {
    return this.manager.packetUpdate?.(packet);
  }

  async init(clientOrId = this.client) {
    this.userId = typeof clientOrId === 'string' ? clientOrId : (clientOrId?.user?.id || this.client?.user?.id || this.userId);
    if (!this.userId) throw new Error('Cannot initialize NodeLink before Discord client is ready.');
    if (!this._rawAttached && this.client?.on) {
      this.client.on('raw', this._rawListener);
      this._rawAttached = true;
    }
    this.isActivated = true;
    return this.manager.init(this.userId);
  }

  async addNode(options) {
    const nodeOptions = { ...options, identifier: options.name || options.identifier || options.host };
    if (this.manager.nodes?.add) return this.manager.nodes.add(nodeOptions);
    if (this.manager.nodes?.create) return this.manager.nodes.create(nodeOptions);
    throw new Error('Moonlink node manager does not support dynamic addNode');
  }

  async resolve(options = {}) {
    const result = await this.manager.search({
      query: options.query,
      source: options.source,
      requester: options.requester,
      node: options.node,
    });
    const tracks = (result?.tracks || []).map(track => normalizeTrack(track, options.requester)).filter(Boolean);
    return {
      ...result,
      loadType: normalizeLoadType(result?.loadType, result),
      tracks,
      playlistInfo: result?.playlistInfo || {
        name: result?.playlistName,
        url: result?.playlistUrl,
      },
    };
  }

  async createConnection(options = {}) {
    const raw = this.manager.players.create({
      guildId: options.guildId,
      voiceChannelId: options.voiceChannel || options.voiceChannelId,
      textChannelId: options.textChannel || options.textChannelId,
      volume: options.volume || 100,
    });
    const player = this.wrapPlayer(raw, options);
    await player.connect({ deaf: options.deaf, mute: options.mute });
    return player;
  }

  wrapNode(rawOrId) {
    if (!rawOrId) return null;
    const raw = typeof rawOrId === 'string' ? this.manager.nodes?.get?.(rawOrId) : rawOrId;
    const identifier = raw?.identifier || raw?.options?.name || raw?.host || rawOrId;
    if (this.nodes.has(identifier)) return this.nodes.get(identifier);
    const config = this._nodes.find(node => node.identifier === identifier || node.name === identifier || node.host === raw?.host) || {};
    const node = new CompatNode(this, raw, config);
    this.nodes.set(node.options.name, node);
    return node;
  }

  wrapPlayer(raw, options = {}) {
    if (!raw) return null;
    const guildId = raw.guildId || options.guildId;
    if (this.players.has(guildId)) {
      const existing = this.players.get(guildId);
      existing.raw = raw;
      existing.node = this.wrapNode(raw.node || raw.currentNode || raw.nodeId) || existing.node;
      return existing;
    }
    const player = new CompatPlayer(this, raw, { ...options, guildId });
    this.players.set(guildId, player);
    return player;
  }

  _wireEvents() {
    const m = this.manager;
    m.on?.('nodeCreate', node => this.wrapNode(node));
    m.on?.('nodeReady', node => this.emit('nodeConnect', this.wrapNode(node)));
    m.on?.('nodeConnected', node => this.emit('nodeConnect', this.wrapNode(node)));
    m.on?.('nodeReconnect', node => this.emit('nodeReconnect', this.wrapNode(node)));
    m.on?.('nodeDisconnect', (node, code, reason) => this.emit('nodeDisconnect', this.wrapNode(node), { code, reason }));
    m.on?.('nodeError', (node, err) => this.emit('nodeError', this.wrapNode(node), err));
    m.on?.('playerUpdate', (raw, track, payload) => this.emit('playerUpdate', this.wrapPlayer(raw), payload));
    m.on?.('trackStart', (raw, track) => {
      const player = this.wrapPlayer(raw);
      const wrapped = normalizeTrack(track);
      player.currentTrack = wrapped;
      player.isPlaying = true;
      player.isPaused = false;
      player.node = this.wrapNode(raw.node || raw.currentNode || raw.nodeId) || player.node;
      this.emit('trackStart', player, wrapped);
    });
    m.on?.('trackEnd', (raw, track, reason) => this._handleTrackEnd(raw, track, reason));
    m.on?.('queueEnd', raw => this.emit('queueEnd', this.wrapPlayer(raw)));
    m.on?.('trackStuck', (raw, track, threshold) => this.emit('trackStuck', this.wrapPlayer(raw), normalizeTrack(track), { thresholdMs: threshold }));
    m.on?.('trackException', (raw, track, exception) => this.emit('trackError', this.wrapPlayer(raw), normalizeTrack(track), exception));
    m.on?.('socketClosed', (raw, code, reason, remote) => this.emit('socketClosed', this.wrapPlayer(raw), { code, reason, remote }));
    m.on?.('debug', msg => { if (process.env.DEBUG_NODELINK) console.log(`[NodeLink] ${msg}`); });
  }

  async _handleTrackEnd(raw, track, reason) {
    const player = this.wrapPlayer(raw);
    const wrapped = normalizeTrack(track) || player.currentTrack;
    this.emit('trackEnd', player, wrapped, { reason: String(reason || '').toUpperCase() || 'FINISHED' });
    player.currentTrack = null;
    player.isPlaying = false;
    if (String(reason || '').toUpperCase().includes('REPLAC')) return;
    if (player.queue.length) {
      await player.play().catch(err => this.emit('trackError', player, player.queue[0], err));
    } else {
      this.emit('queueEnd', player);
    }
  }
}

module.exports = {
  NodeLinkCompatManager,
  normalizeTrack,
};
