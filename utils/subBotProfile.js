'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ActivityType, Client, GatewayIntentBits } = require('discord.js');
const { TwitchUrl } = require('../config');
const { liftDiscordClientLimits } = require('./discordClientTuning');

const AUTO_SETTINGS_FILE = path.join(process.cwd(), 'settings', 'automatic.json');
const IMAGE_TIMEOUT_MS = Math.max(3000, Number(process.env.PROFILE_IMAGE_TIMEOUT_MS || 10000));
const IMAGE_MAX_BYTES = Math.max(256 * 1024, Number(process.env.PROFILE_IMAGE_MAX_BYTES || 8 * 1024 * 1024));
const PROFILE_MAX_RETRIES = 4;
const PROFILE_MAX_WAIT_MS = 90_000;

/** Extract retry-after ms from a discord.js or axios 429 error. Returns null if not a rate-limit. */
function profileExtractRetryAfterMs(err) {
  const djsRa = err?.rawError?.retry_after ?? err?.retryAfter;
  if (djsRa != null) return Math.min(Math.ceil(Number(djsRa) * 1000) + 1500, PROFILE_MAX_WAIT_MS);
  if (err?.response?.status === 429) {
    const ra = err?.response?.data?.retry_after
      ?? err?.response?.headers?.['retry-after']
      ?? err?.response?.headers?.['x-ratelimit-reset-after'];
    return Math.min(Math.ceil(Number(ra ?? 5) * 1000) + 1500, PROFILE_MAX_WAIT_MS);
  }
  if (err?.status === 429 || err?.httpStatus === 429) {
    const ra = String(err?.message || '').match(/(\d+(?:\.\d+)?)\s*second/i)?.[1];
    return ra ? Math.min(Math.ceil(parseFloat(ra) * 1000) + 1500, PROFILE_MAX_WAIT_MS) : 5_000;
  }
  return null;
}

/** Retry an async fn up to maxRetries. On 429 waits retry_after; otherwise exponential backoff. */
async function profileWithRetry(fn, maxRetries = PROFILE_MAX_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries) break;
      const waitMs = profileExtractRetryAfterMs(err) ?? Math.min(1500 * attempt, 10_000);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function readAutomaticSettings() {
  try {
    if (!fs.existsSync(AUTO_SETTINGS_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(AUTO_SETTINGS_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function getSubBotProfile() {
  const saved = readAutomaticSettings();
  return {
    prefix: saved.subBotPrefix || 'music',
    avatar: saved.subBotAvatar || null,
    banner: saved.subBotBanner || null,
    status: saved.subBotStatus || null,
  };
}

function assertHttpUrl(value, label = 'URL') {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label} غير صحيح.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} يجب أن يبدأ بـ http أو https.`);
  }
  return parsed.toString();
}

async function fetchImageDataUri(rawUrl, label = 'Image') {
  const value = String(rawUrl || '').trim();
  if (value.startsWith('data:image/')) return value;

  if (!/^https?:\/\//i.test(value)) {
    const filePath = path.isAbsolute(value) ? value : path.join(process.cwd(), value);
    if (!fs.existsSync(filePath)) throw new Error(`${label} غير موجود محلياً.`);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = IMAGE_MIME_BY_EXT[ext];
    if (!contentType) throw new Error(`${label} ليس بصيغة صورة مدعومة.`);
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > IMAGE_MAX_BYTES) {
      throw new Error(`${label} كبير جداً. الحد ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB.`);
    }
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  const url = assertHttpUrl(value, label);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: IMAGE_TIMEOUT_MS,
    maxContentLength: IMAGE_MAX_BYTES,
    validateStatus: status => status >= 200 && status < 300,
  });
  const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`${label} ليس ملف صورة.`);
  const buffer = Buffer.from(response.data);
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw new Error(`${label} كبير جداً. الحد ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB.`);
  }
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function resolveProfileAssets(profile = getSubBotProfile()) {
  const assets = { avatarData: null, bannerData: null };
  if (profile.avatar) assets.avatarData = await fetchImageDataUri(profile.avatar, 'Avatar');
  if (profile.banner) assets.bannerData = await fetchImageDataUri(profile.banner, 'Banner');
  return assets;
}

function buildSubBotName(profile = getSubBotProfile(), number = null) {
  const num = number || Math.floor(1000 + Math.random() * 9000);
  return `${profile.prefix || 'music'}-${num}`.slice(0, 32);
}

function twitchUrl() {
  return Array.isArray(TwitchUrl) ? TwitchUrl[0] : TwitchUrl;
}

async function patchCurrentApplication(token, payload) {
  const request = async (body) => profileWithRetry(() => axios.patch('https://discord.com/api/v10/applications/@me', body, {
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    timeout: IMAGE_TIMEOUT_MS,
    validateStatus: status => status >= 200 && status < 300,
  }));

  const primary = {};
  if (payload.name) primary.name = String(payload.name).slice(0, 32);
  if (payload.icon) primary.icon = payload.icon;

  let changed = false;
  if (Object.keys(primary).length) {
    await request(primary);
    changed = true;
  }

  if (payload.cover_image) {
    await request({ cover_image: payload.cover_image }).then(() => { changed = true; }).catch(() => {});
  }
  return changed;
}

async function patchBotBanner(token, bannerData) {
  if (!bannerData) return false;
  await profileWithRetry(() => axios.patch('https://discord.com/api/v10/users/@me', { banner: bannerData }, {
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    timeout: IMAGE_TIMEOUT_MS,
    validateStatus: status => status >= 200 && status < 300,
  }));
  return true;
}

async function applyProfileToClient(botClient, token, options = {}) {
  const profile = options.profile || getSubBotProfile();
  const assets = options.assets || await resolveProfileAssets(profile);
  const botName = options.name || buildSubBotName(profile, options.number);
  const result = { name: botName, username: false, avatar: false, banner: false, app: false, status: false };

  if (botClient?.user) {
    await profileWithRetry(() => botClient.user.setUsername(botName))
      .then(() => { result.username = true; }).catch(() => {});
    if (assets.avatarData) {
      await profileWithRetry(() => botClient.user.setAvatar(assets.avatarData))
        .then(() => { result.avatar = true; }).catch(() => {});
    }
    if (profile.status) {
      botClient.user.setPresence({
        activities: [{
          name: String(profile.status),
          type: ActivityType.Streaming,
          url: twitchUrl() || 'https://www.twitch.tv/tnbeh',
        }],
        status: 'online',
      });
      result.status = true;
    }
  }

  if (token && assets.bannerData) {
    await patchBotBanner(token, assets.bannerData).then(() => { result.banner = true; }).catch(() => {});
  }

  if (token) {
    await patchCurrentApplication(token, {
      name: botName,
      icon: assets.avatarData || null,
      cover_image: assets.bannerData || null,
    }).then(() => { result.app = true; }).catch(async () => {
      try {
        const appPayload = { name: botName };
        if (assets.avatarData) appPayload.icon = assets.avatarData;
        await botClient?.application?.edit?.(appPayload);
        result.app = true;
      } catch {}
    });
  }

  return result;
}

async function applyProfileToToken(token, options = {}) {
  const botClient = new Client({ intents: [GatewayIntentBits.Guilds] });
  liftDiscordClientLimits(botClient);
  try {
    await botClient.login(token);
    if (options.leaveGuilds) {
      for (const guild of botClient.guilds.cache.values()) {
        await guild.leave().catch(() => {});
      }
    }
    return await applyProfileToClient(botClient, token, options);
  } finally {
    await botClient.destroy().catch(() => {});
  }
}

module.exports = {
  getSubBotProfile,
  readAutomaticSettings,
  fetchImageDataUri,
  resolveProfileAssets,
  buildSubBotName,
  applyProfileToClient,
  applyProfileToToken,
};
