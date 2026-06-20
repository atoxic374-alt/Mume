const fs = require('fs');
const path = require('path');
const ms = require('ms');
const axios = require('axios');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { owners } = require('../../config');
const store = require('../../utils/store');
const { check } = require('../../utils/rateLimit');
const { getEmbedColor } = require('../../utils/embedColor');
const {
  applyProfileToToken: applyProfileToTokenHelper,
  resolveProfileAssets,
} = require('../../utils/subBotProfile');
const {
  buildSubscriptionActivatedDm,
  buildOwnershipTransferredDm,
  buildServerUpdatedDm,
  buildSubscriptionBotsAddedDm,
  buildSubscriptionTimeUpdatedDm,
} = require('../../utils/subscriptionDm');

const AUTO_SETTINGS_FILE = path.join(process.cwd(), 'settings', 'automatic.json');
const REQUESTS_FILE = path.join(process.cwd(), 'settings', 'invoices.tmp.json');
const AUTO_IMAGE_PATH = path.join(process.cwd(), 'assets', 'image', 'Auto.png');
const AUTO_PROFILE_ASSET_DIR = path.join(process.cwd(), 'assets', 'automatic');
const RENEWAL_TTL_MS = 12 * 60 * 60 * 1000;

const MONTH_PRESETS = [
  { months: 1, ms: 30 * 24 * 60 * 60 * 1000, labelAr: 'شهر واحد',    labelEn: '1 Month',  days: 30,
    aliases: ['شهر', 'واحد', '1', 'one', '١', 'شهر واحد'] },
  { months: 2, ms: 60 * 24 * 60 * 60 * 1000, labelAr: 'شهرين',       labelEn: '2 Months', days: 60,
    aliases: ['شهرين', 'اثنين', '2', 'two', '٢'] },
  { months: 3, ms: 90 * 24 * 60 * 60 * 1000, labelAr: 'ثلاثة أشهر', labelEn: '3 Months', days: 90,
    aliases: ['ثلاثة', 'ثلاث', '3', 'three', '٣', '3 أشهر', 'ثلاثة أشهر'] },
];

function quickEmbed(client, user, type, description) {
  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(client))
    .setDescription(description)
    .setFooter({
      text: client?.user?.username || 'Mume Auto',
      iconURL: client?.user?.displayAvatarURL?.() || undefined,
    })
    .setTimestamp();
  const avatarUrl = user?.displayAvatarURL?.({ dynamic: true, size: 128 });
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}

function durationBuyRows(iid) {
  const styles = [ButtonStyle.Primary, ButtonStyle.Primary, ButtonStyle.Success];
  return [
    new ActionRowBuilder().addComponents(
      ...MONTH_PRESETS.map((p, i) =>
        new ButtonBuilder()
          .setCustomId(`auto_buy_dur_${p.months}_${iid}`)
          .setLabel(`${p.months} Month | ${p.labelAr}`)
          .setStyle(styles[i] ?? ButtonStyle.Primary),
      ),
    ),
  ];
}

function durationRenewRows(code, iid) {
  const styles = [ButtonStyle.Primary, ButtonStyle.Primary, ButtonStyle.Success];
  return [
    new ActionRowBuilder().addComponents(
      ...MONTH_PRESETS.map((p, i) =>
        new ButtonBuilder()
          .setCustomId(`auto_rdur_${p.months}_${code}_${String(iid).slice(-10)}`)
          .setLabel(`${p.months} Month | ${p.labelAr}`)
          .setStyle(styles[i] ?? ButtonStyle.Primary),
      ),
    ),
  ];
}
const installedClients = new WeakSet();
const PROFILE_IMAGE_TIMEOUT_MS = Math.max(3000, Number(process.env.PROFILE_IMAGE_TIMEOUT_MS || 10000));
const PROFILE_IMAGE_MAX_BYTES = Math.max(256 * 1024, Number(process.env.PROFILE_IMAGE_MAX_BYTES || 8 * 1024 * 1024));
const PROFILE_IMAGE_EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function automaticSettings() {
  return {
    requestMode: 'dm',
    requestChannelId: null,
    panelGuildId: null,
    panelChannelId: null,
    panelMessageId: null,
    panelUrl: null,
    botPrice: 0,
    currency: 'SAR',
    paymentMethods: null,
    subBotPrefix: 'music',
    subBotAvatar: null,
    subBotBanner: null,
    subBotStatus: null,
    ...readJson(AUTO_SETTINGS_FILE, {}),
  };
}

function subBotProfile() {
  const s = automaticSettings();
  return {
    prefix: s.subBotPrefix || 'music',
    avatar: s.subBotAvatar || null,
    banner: s.subBotBanner || null,
    status: s.subBotStatus || null,
  };
}

async function applyProfileToToken(token, profile, options = {}) {
  return applyProfileToTokenHelper(token, { profile, leaveGuilds: true, ...options });
}

function saveAutomaticSettings(next) {
  writeJson(AUTO_SETTINGS_FILE, { ...automaticSettings(), ...next });
}

function relativeAssetPath(filePath) {
  return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

function profileImageDisplay(value) {
  if (!value) return '`Not set | غير محدد`';
  if (/^https?:\/\//i.test(value)) return `[Saved Link | رابط محفوظ](${value})`;
  return `\`${value}\``;
}

async function saveProfileImageLocally(rawValue, kind) {
  const value = String(rawValue || '').trim();
  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    const filePath = path.isAbsolute(value) ? value : path.join(process.cwd(), value);
    if (!fs.existsSync(filePath)) throw new Error('ملف الصورة غير موجود.');
    return relativeAssetPath(filePath);
  }

  const response = await axios.get(value, {
    responseType: 'arraybuffer',
    timeout: PROFILE_IMAGE_TIMEOUT_MS,
    maxContentLength: PROFILE_IMAGE_MAX_BYTES,
    validateStatus: status => status >= 200 && status < 300,
  });
  const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = PROFILE_IMAGE_EXT_BY_MIME[contentType];
  if (!ext) throw new Error('الرابط ليس صورة مدعومة.');

  const buffer = Buffer.from(response.data);
  if (buffer.length > PROFILE_IMAGE_MAX_BYTES) {
    throw new Error(`الصورة كبيرة جداً. الحد ${Math.round(PROFILE_IMAGE_MAX_BYTES / 1024 / 1024)}MB.`);
  }

  fs.mkdirSync(AUTO_PROFILE_ASSET_DIR, { recursive: true });
  const filePath = path.join(AUTO_PROFILE_ASSET_DIR, `subbot-${kind}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return relativeAssetPath(filePath);
}

async function ensureProfileImagesLocal() {
  const settings = automaticSettings();
  const patch = {};

  if (/^https?:\/\//i.test(String(settings.subBotAvatar || ''))) {
    patch.subBotAvatar = await saveProfileImageLocally(settings.subBotAvatar, 'avatar');
  }
  if (/^https?:\/\//i.test(String(settings.subBotBanner || ''))) {
    patch.subBotBanner = await saveProfileImageLocally(settings.subBotBanner, 'banner');
  }

  if (Object.keys(patch).length) saveAutomaticSettings(patch);
  return { ...settings, ...patch };
}

function readRequests() {
  const raw = readJson(REQUESTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function saveRequests(requests) {
  writeJson(REQUESTS_FILE, requests);
}

function cleanupRequests() {
  const now = Date.now();
  const requests = readRequests().filter(req => {
    if (req.status === 'awaiting_invoice' && Number(req.expiresAt || 0) <= now) return false;
    if (['approved', 'rejected', 'expired'].includes(req.status) && now - Number(req.updatedAt || req.createdAt || 0) > 24 * 60 * 60 * 1000) return false;
    return true;
  });
  saveRequests(requests);
}

function updateRequest(id, patch) {
  const requests = readRequests();
  const index = requests.findIndex(req => req.id === id);
  if (index === -1) return null;
  requests[index] = { ...requests[index], ...patch, updatedAt: Date.now() };
  saveRequests(requests);
  return requests[index];
}

function randomId(size = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: size }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatDuration(msValue) {
  const value = Math.max(0, Number(msValue || 0));
  const d = Math.floor(value / 86400000);
  const h = Math.floor((value % 86400000) / 3600000);
  const m = Math.floor((value % 3600000) / 60000);
  const s = Math.floor((value % 60000) / 1000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && !h && s && `${s}s`].filter(Boolean).join(' ') || '0m';
}

function parsePrice(raw) {
  const normalized = String(raw || '').trim().replace(',', '.');
  const price = Number(normalized);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function formatMoney(amount, currency = automaticSettings().currency) {
  const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const clean = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${clean} ${String(currency || '').trim() || 'SAR'}`;
}

function userSubscriptions(userId) {
  return (store.get('time') || []).filter(entry => entry.user === userId);
}

function subscriptionTokens(code) {
  return (store.get('tokens') || []).filter(token => token.code === code);
}

function findSubscription(code, userId = null) {
  return (store.get('time') || []).find(entry => entry.code === code && (!userId || entry.user === userId));
}

function parseUserId(raw) {
  const value = String(raw || '').trim();
  const mention = value.match(/^<@!?(\d{15,20})>$/);
  if (mention) return mention[1];
  return /^\d{15,20}$/.test(value) ? value : null;
}

function panelLink(settings = automaticSettings()) {
  if (settings.panelUrl) return settings.panelUrl;
  if (settings.panelGuildId && settings.panelChannelId && settings.panelMessageId) {
    return `https://discord.com/channels/${settings.panelGuildId}/${settings.panelChannelId}/${settings.panelMessageId}`;
  }
  if (settings.panelGuildId && settings.panelChannelId) {
    return `https://discord.com/channels/${settings.panelGuildId}/${settings.panelChannelId}`;
  }
  return null;
}

function autoImagePayload(embed) {
  const settings = automaticSettings();
  if (settings.panelImageUrl) {
    embed.setImage(settings.panelImageUrl);
    return { embeds: [embed] };
  }
  if (!fs.existsSync(AUTO_IMAGE_PATH)) return { embeds: [embed] };
  embed.setImage('attachment://Auto.png');
  return { embeds: [embed], files: [AUTO_IMAGE_PATH] };
}

function publicPanelPayload(client) {
  const settings = automaticSettings();
  const components = publicPanelRows();
  const embed = publicPanelEmbed(client);
  if (settings.panelImageUrl) {
    embed.setImage(settings.panelImageUrl);
    return { embeds: [embed], components };
  }
  if (fs.existsSync(AUTO_IMAGE_PATH)) {
    embed.setImage('attachment://Auto.png');
    return { embeds: [embed], files: [AUTO_IMAGE_PATH], components };
  }
  return { embeds: [embed], components };
}

function buildOwnerEmbed(client, requester) {
  const stock = (store.get('bots') || []).length;
  const activeSubs = (store.get('time') || []).length;
  const activeBots = (store.get('tokens') || []).length;
  const pausedSubs = (store.get('time') || []).filter(entry => entry.pausedAt).length;
  const settings = automaticSettings();
  const target = settings.requestMode === 'channel' && settings.requestChannelId
    ? `<#${settings.requestChannelId}>`
    : 'Owners DM';
  const link = panelLink(settings);

  return new EmbedBuilder()
    .setColor(getEmbedColor(client))
    .setTitle('Automatic System | نظام الأوتوماتك')
    .setThumbnail(requester.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription([
      `**Stock | الستوك :** *\`${stock}\`*`,
      '',
      `**Active Bots | البوتات النشطة :** *\`${activeBots}\`*`,
      '',
      `**Subscriptions | الاشتراكات :** *\`${activeSubs}\`*`,
      '',
      `**Paused | المتوقفة :** *\`${pausedSubs}\`*`,
      '',
      `**Bot Price | سعر البوت :** *${formatMoney(settings.botPrice, settings.currency)}*`,
      '',
      `**Payment Methods | طرق الدفع :** *${settings.paymentMethods ? `\`${settings.paymentMethods}\`` : '`Not set | غير محددة`'}*`,
      '',
      `**Request Target | وجهة الطلبات :** *${target}*`,
      '',
      `**Customer Panel | لوحة العملاء :** *${link ? `[Open Panel | فتح اللوحة](${link})` : 'Not sent yet | لم يتم إرسالها بعد'}*`,
    ].join('\n'))
    .setFooter({ text: `${client.user?.username || 'Music'} | Automatic`, iconURL: client.user?.displayAvatarURL({ dynamic: true }) })
    .setTimestamp();
}

function ownerRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('auto_admin_target')
        .setLabel('Requests | الطلبات')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('auto_admin_pricing')
        .setLabel('Pricing | السعر')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('auto_admin_payment_methods')
        .setLabel('Payment Methods | طرق الدفع')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('auto_admin_send')
        .setLabel('Send Panel | إرسال')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('auto_admin_stock')
        .setLabel('Stock | الستوك')
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('auto_admin_image')
        .setLabel('Image | الصورة')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('auto_admin_profile')
        .setLabel('Bot Profile | مظهر البوت')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function publicPanelEmbed(client) {
  const settings = automaticSettings();
  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(client))
    .setTitle('Automatic Purchase | الشراء التلقائي')
    .setDescription([
      '**Buy | شراء**',
      '*حدد عدد البوتات وارسل الفاتورة في الخاص ثم انتظر قبول الإدارة.*',
      '',
      '**My Sub | اشتراكي**',
      '*عرض وإدارة اشتراكاتك الحالية.*',
      '',
      '**Renew | تجديد**',
      '*اطلب التجديد ثم ارسل صورة الفاتورة في الخاص خلال 12 ساعة.*',
      '',
      '**Pricing | الأسعار**',
      '*احسب سعر اشتراكك تلقائياً بناءً على عدد البوتات والمدة.*',
      '',
      '**Support | الدعم**',
      '*تواصل مع الإدارة مباشرة.*',
      '',
      `**Bot Price / Month | سعر البوت / شهر :** *${formatMoney(settings.botPrice, settings.currency)}*`,
    ].join('\n'))
    .setFooter({ text: `${client.user?.username || 'Music'} | Automatic`, iconURL: client.user?.displayAvatarURL({ dynamic: true }) });
  const thumb = client.user?.displayAvatarURL({ dynamic: true, size: 256 });
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}

function publicPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('auto_user_buy').setLabel('Buy | شراء').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('auto_user_my').setLabel('My Sub | اشتراكي').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('auto_user_renew').setLabel('Renew | تجديد').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('auto_user_links').setLabel('Links | روابط').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('auto_user_pause').setLabel('Pause/Resume | إيقاف/تشغيل').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('auto_user_pricing').setLabel('Pricing | الأسعار').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('auto_user_support').setLabel('Support | الدعم').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function subscriptionSelect(customId, subs, placeholder = 'Select Subscription') {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(subs.slice(0, 25).map(sub => ({
        label: `Music x${sub.botsCount}`,
        description: `Subscription ${sub.code}`,
        value: sub.code,
      }))),
  );
}

function subscriptionEmbed(client, user, entry) {
  const tokens = subscriptionTokens(entry.code);
  const paused = !!entry.pausedAt;
  const remaining = paused ? Math.max(0, entry.expirationTime - Number(entry.pausedAt || Date.now())) : entry.expirationTime - Date.now();

  return new EmbedBuilder()
    .setColor(paused ? 0xf1c40f : getEmbedColor(client))
    .setTitle('Subscription Info | معلومات الاشتراك')
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription([
      `**Subscription ID | رقم الاشتراك :** *\`${entry.code}\`*`,
      '',
      `**Bot Count | عدد البوتات :** *\`${entry.botsCount}\`*`,
      '',
      `**Active Bots | البوتات النشطة :** *\`${tokens.length}\`*`,
      '',
      `**Bot Price | سعر البوت :** *${formatMoney(automaticSettings().botPrice, automaticSettings().currency)}*`,
      '',
      `**Server | السيرفر :** *\`${entry.server || tokens[0]?.Server || 'غير محدد'}\`*`,
      '',
      `**Status | الحالة :** *${paused ? 'Paused | متوقف مؤقتا' : 'Active | نشط'}*`,
      '',
      `**Remaining | المتبقي :** *\`${formatDuration(remaining)}\`*`,
      '',
      `**Expires | ينتهي :** *<t:${Math.floor(entry.expirationTime / 1000)}:R>*`,
    ].join('\n'))
    .setFooter({ text: `${client.user?.username || 'Music'} | Subscription` });
}

function subscriptionRows(entry) {
  const paused = !!entry.pausedAt;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`auto_sub_add_${entry.code}`).setLabel('Add Bots | إضافة').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`auto_sub_renew_${entry.code}`).setLabel('Renew | تجديد').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`auto_sub_pause_${entry.code}`).setLabel(paused ? 'Resume | تشغيل' : 'Pause | إيقاف').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`auto_sub_control_${entry.code}`).setLabel('Manage | إدارة').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function controlEmbed(client, user, entry) {
  const tokens = subscriptionTokens(entry.code);
  return new EmbedBuilder()
    .setColor(getEmbedColor(client))
    .setTitle('Manage Subscription | إدارة الاشتراك')
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription([
      `**Subscription ID | رقم الاشتراك :** *\`${entry.code}\`*`,
      '',
      `**Owner | المالك :** *<@${entry.user}>*`,
      '',
      `**Bot Count | عدد البوتات :** *\`${entry.botsCount}\`*`,
      '',
      `**Server | السيرفر :** *\`${entry.server || tokens[0]?.Server || 'غير محدد'}\`*`,
      '',
      '**Transfer Ownership | نقل الملكية**',
      '*Move this subscription and its bots to another user.*',
      '',
      '**Move Server | تغيير السيرفر**',
      '*Move the subscription to another server and send bot links in DM.*',
      '',
      '**Bot Links | روابط البوتات**',
      '*Send all bot links or only bots outside the server.*',
    ].join('\n'))
    .setFooter({ text: `${client.user?.username || 'Music'} | Control` });
}

function controlRows(entry) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`auto_control_owner_${entry.code}`).setLabel('Owner | المالك').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`auto_control_server_${entry.code}`).setLabel('Move Server | سيرفر').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`auto_control_links_all_${entry.code}`).setLabel('All Links | الكل').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`auto_control_links_off_${entry.code}`).setLabel('Outside | خارج').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`auto_control_back_${entry.code}`).setLabel('Back | رجوع').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function requestTargetLabel() {
  const settings = automaticSettings();
  return settings.requestMode === 'channel' && settings.requestChannelId
    ? `<#${settings.requestChannelId}>`
    : 'Owners DM';
}

async function sendToRequestTarget(client, payload) {
  const settings = automaticSettings();
  if (settings.requestMode === 'channel' && settings.requestChannelId) {
    const channel = await client.channels.fetch(settings.requestChannelId).catch(() => null);
    if (channel?.send) return channel.send(payload).catch(() => null);
  }

  const sent = [];
  for (const ownerId of owners) {
    const owner = await client.users.fetch(ownerId).catch(() => null);
    if (!owner) continue;
    const msg = await owner.send(payload).catch(() => null);
    if (msg) sent.push(msg);
  }
  return sent[0] || null;
}

async function refreshSavedPublicPanel(client) {
  const settings = automaticSettings();
  if (!settings.panelChannelId || !settings.panelMessageId) return;
  const channel = await client.channels.fetch(settings.panelChannelId).catch(() => null);
  const message = await channel?.messages?.fetch(settings.panelMessageId).catch(() => null);
  if (!message?.edit) return;
  await message.edit({
    embeds: [],
    files: [],
    ...publicPanelPayload(client),
  }).catch(() => {});
}

function buildAddBotsRequestEmbed(client, req) {
  const stock = (store.get('bots') || []).length;
  const entry = findSubscription(req.code);
  const settings = automaticSettings();
  const unitPrice = req.unitPrice ?? settings.botPrice;
  const currency = req.currency || settings.currency;
  const totalPrice = req.totalPrice ?? (Number(unitPrice || 0) * Number(req.count || 0));
  return new EmbedBuilder()
    .setColor(getEmbedColor(client))
    .setTitle('Add Bots Request')
    .setDescription([
      `**Customer :** *<@${req.userId}>*`,
      '',
      `**Subscription :** *\`${req.code}\`*`,
      '',
      `**Requested Bots :** *\`${req.count}\` بوت مطلوب إضافته*`,
      '',
      `**Unit Price :** *${formatMoney(unitPrice, currency)}*`,
      '',
      `**Total Price :** *${formatMoney(totalPrice, currency)}*`,
      '',
      `**Current Stock :** *\`${stock}\` بوت متوفر في المخزون*`,
      '',
      `**Subscription Bots :** *\`${entry?.botsCount || 0}\` بوت قبل التنفيذ*`,
      '',
      `**Status :** *${req.status || 'pending'}*`,
    ].join('\n'))
    .setTimestamp();
}

function addBotsRequestRows(reqId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`auto_req_tokens_${reqId}`).setLabel('Add Tokens | توكنات').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`auto_req_add_${reqId}`).setLabel('Approve | قبول').setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`auto_req_reject_${reqId}`).setLabel('Reject | رفض').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];
}

function buildRenewRequestEmbed(client, req) {
  return new EmbedBuilder()
    .setColor(getEmbedColor(client))
    .setTitle('Renewal Request | طلب تجديد')
    .setDescription([
      `**Customer :** *<@${req.userId}>*`,
      '',
      `**Subscription :** *\`${req.code}\`*`,
      '',
      `**Duration | المدة :** *\`${req.durationLabel || 'غير محدد'}\` (${req.durationDays || '?'} يوم)*`,
      '',
      `**Invoice :** *${req.invoiceUrl ? `[فتح الصورة](${req.invoiceUrl})` : 'بانتظار الصورة'}*`,
      '',
      `**Status :** *${req.status || 'pending'}*`,
    ].join('\n'))
    .setImage(req.invoiceUrl || null)
    .setTimestamp();
}

function buildPurchaseRequestEmbed(client, req) {
  const stock = (store.get('bots') || []).length;
  const settings = automaticSettings();
  const unitPrice = req.unitPrice ?? settings.botPrice;
  const currency = req.currency || settings.currency;
  const totalPrice = req.totalPrice ?? (Number(unitPrice || 0) * Number(req.count || 0));
  return new EmbedBuilder()
    .setColor(getEmbedColor(client))
    .setTitle('Purchase Request | طلب شراء')
    .setDescription([
      `**Customer :** *<@${req.userId}>*`,
      '',
      `**Requested Bots :** *\`${req.count}\` بوت*`,
      '',
      `**Duration | المدة :** *\`${req.durationLabel || 'غير محدد'}\` (${req.durationDays || '?'} يوم)*`,
      '',
      `**Server ID :** *\`${req.serverId || 'غير محدد'}\`*`,
      '',
      `**Unit Price :** *${formatMoney(unitPrice, currency)}*`,
      '',
      `**Total Price :** *${formatMoney(totalPrice, currency)}*`,
      '',
      `**Current Stock :** *\`${stock}\` بوت متوفر في المخزون*`,
      '',
      `**Invoice :** *${req.invoiceUrl ? `[فتح الصورة](${req.invoiceUrl})` : 'بانتظار الصورة'}*`,
      '',
      `**Status :** *${req.status || 'pending'}*`,
      req.code ? `\n**Subscription :** *\`${req.code}\`*` : null,
    ].filter(Boolean).join('\n'))
    .setImage(req.invoiceUrl || null)
    .setTimestamp();
}

function purchaseRequestRows(reqId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`auto_purchase_accept_${reqId}`).setLabel('Accept Purchase | قبول').setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`auto_purchase_reject_${reqId}`).setLabel('Reject | رفض').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];
}

function renewRequestRows(reqId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`auto_renew_accept_${reqId}`).setLabel('Accept Renewal | قبول').setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`auto_renew_reject_${reqId}`).setLabel('Reject | رفض').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];
}

async function startPurchase(interaction, count, serverId, durationMs, durationLabel, durationDays) {
  const stock = (store.get('bots') || []).length;
  if (stock < count) {
    return interaction.reply({
      embeds: [quickEmbed(interaction.client, interaction.user, 'error',
        `**Stock | المخزون**\nالمخزون غير كافي. المتاح الآن : \`${stock}\` بوت وطلبك \`${count}\` بوت.`)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const existing = readRequests().find(r =>
    r.type === 'purchase' &&
    r.userId === interaction.user.id &&
    ['awaiting_invoice', 'pending_owner'].includes(r.status) &&
    Number(r.expiresAt || 0) > Date.now(),
  );
  if (existing) {
    const desc = existing.status === 'awaiting_invoice'
      ? '**طلب معلق**\nلديك طلب شراء بانتظار الفاتورة. أرسل صورة الفاتورة في الخاص أو انتظر انتهاء مهلة الـ 12 ساعة.'
      : '**طلب قيد المراجعة**\nطلبك وصل للإدارة وبانتظار الرد. يرجى الانتظار.';
    return interaction.reply({
      embeds: [quickEmbed(interaction.client, interaction.user, 'warning', desc)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const settings = automaticSettings();
  const unitPrice = Number(settings.botPrice || 0);
  const currency = settings.currency || 'SAR';
  const totalPrice = unitPrice * count * (durationMs / MONTH_PRESETS[0].ms);
  const req = {
    id: randomId(10),
    type: 'purchase',
    status: 'awaiting_invoice',
    userId: interaction.user.id,
    count,
    serverId,
    unitPrice,
    totalPrice,
    currency,
    durationMs,
    durationLabel,
    durationDays,
    createdAt: Date.now(),
    expiresAt: Date.now() + RENEWAL_TTL_MS,
  };
  const requests = readRequests().filter(item => !(item.type === 'purchase' && item.userId === req.userId && ['awaiting_invoice'].includes(item.status)));
  requests.push(req);
  saveRequests(requests);

  const { paymentMethods: pmPurchase } = automaticSettings();
  const userThumb = interaction.user.displayAvatarURL({ dynamic: true, size: 256 });
  const dmEmbed = new EmbedBuilder()
    .setColor(getEmbedColor(interaction.client))
    .setTitle('Purchase Invoice | فاتورة الشراء')
    .setThumbnail(userThumb)
    .setFooter({ text: interaction.client?.user?.username || 'Mume Auto', iconURL: interaction.client?.user?.displayAvatarURL?.() || undefined })
    .setTimestamp()
    .addFields(
      { name: 'Bot Count | عدد البوتات', value: `\`${count}\``, inline: true },
      { name: 'Duration | المدة', value: `\`${durationLabel}\` (${durationDays} يوم)`, inline: true },
      { name: 'Server ID | ايدي السيرفر', value: `\`${serverId}\``, inline: false },
      { name: 'Total Price | الإجمالي', value: formatMoney(totalPrice, currency), inline: true },
      ...(pmPurchase ? [{ name: 'Payment Methods | طرق الدفع', value: pmPurchase, inline: false }] : []),
      { name: 'Required | المطلوب', value: 'أرسل صورة الفاتورة هنا في الخاص حتى تصل للإدارة', inline: false },
      { name: 'Timeout | المهلة', value: 'لديك **12 ساعة** قبل حذف الطلب تلقائياً', inline: false },
    );

  const dmOk = await interaction.user.send({ embeds: [dmEmbed] }).then(() => true).catch(() => false);
  return interaction.reply({
    embeds: [quickEmbed(interaction.client, interaction.user, dmOk ? 'success' : 'error',
      dmOk
        ? '**تم إرسال الفاتورة في الخاص**\nأرسل صورة الفاتورة هناك خلال **12 ساعة**.'
        : '**تعذّر إرسال الخاص**\nافتح رسائل الخاص (Privacy Settings) ثم اضغط Buy مجدداً.')],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function showSubscription(interaction, code) {
  const entry = findSubscription(code, interaction.user.id);
  if (!entry) {
    return interaction.reply({ content: '**Subscription :** *لم أجد هذا الاشتراك.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const payload = {
    embeds: [subscriptionEmbed(interaction.client, interaction.user, entry)],
    components: subscriptionRows(entry),
  };
  if (interaction.replied || interaction.deferred) return interaction.editReply(payload).catch(() => {});
  if (interaction.isStringSelectMenu()) return interaction.update(payload).catch(() => {});
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function showControlPanel(interaction, code) {
  const entry = findSubscription(code, interaction.user.id);
  if (!entry) {
    return interaction.reply({ content: '**Subscription :** *لم أجد هذا الاشتراك.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const payload = {
    embeds: [controlEmbed(interaction.client, interaction.user, entry)],
    components: controlRows(entry),
  };
  if (interaction.replied || interaction.deferred) return interaction.editReply(payload).catch(() => {});
  if (interaction.isStringSelectMenu() || interaction.isButton()) return interaction.update(payload).catch(() => {});
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function showSubscriptionPicker(interaction, action) {
  const subs = userSubscriptions(interaction.user.id);
  if (!subs.length) return interaction.reply({ embeds: [quickEmbed(interaction.client, interaction.user, 'error', '**لا يوجد لديك اشتراك حالياً**\nاضغط Buy لشراء اشتراك جديد.')], flags: MessageFlags.Ephemeral }).catch(() => {});
  if (subs.length === 1) {
    if (action === 'renew') return startRenewal(interaction, subs[0].code);
    if (action === 'pause') return togglePause(interaction, subs[0].code);
    if (action === 'control') return showControlPanel(interaction, subs[0].code);
    if (action === 'links_all') return sendLinks(interaction, subs[0].code, 'all');
    return showSubscription(interaction, subs[0].code);
  }

  const customId = `auto_select_${action}_${randomId(5)}`;
  return interaction.reply({
    content: '**Subscription :** *اختر الاشتراك المطلوب من القائمة.*',
    components: [subscriptionSelect(customId, subs)],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function requestAddBots(interaction, code, count) {
  const entry = findSubscription(code, interaction.user.id);
  if (!entry) return interaction.reply({ content: '**Subscription :** *لم أجد هذا الاشتراك.*', flags: MessageFlags.Ephemeral }).catch(() => {});

  // Anti-spam: block duplicate pending add_bots requests within 24 hours
  const existing = readRequests().find(r =>
    r.type === 'add_bots' &&
    r.userId === interaction.user.id &&
    r.code === code &&
    r.status === 'pending' &&
    Date.now() - Number(r.createdAt || 0) < 24 * 60 * 60 * 1000,
  );
  if (existing) {
    return interaction.reply({
      embeds: [quickEmbed(interaction.client, interaction.user, 'warning', '**طلب إضافة بوتات معلق**\nلديك طلب إضافة بوتات قيد المراجعة. انتظر قبوله أو رفضه قبل إرسال طلب جديد.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const settings = automaticSettings();
  const unitPrice = Number(settings.botPrice || 0);
  const currency = settings.currency || 'SAR';
  const totalPrice = unitPrice * count;

  const req = {
    id: randomId(10),
    type: 'add_bots',
    status: 'pending',
    userId: interaction.user.id,
    code,
    count,
    unitPrice,
    totalPrice,
    currency,
    createdAt: Date.now(),
  };
  const requests = readRequests();
  requests.push(req);
  saveRequests(requests);

  const msg = await sendToRequestTarget(interaction.client, {
    embeds: [buildAddBotsRequestEmbed(interaction.client, req)],
    components: addBotsRequestRows(req.id),
  });
  if (msg?.id) {
    updateRequest(req.id, {
      requestMessageId: msg.id,
      requestChannelId: msg.channelId,
      requestGuildId: msg.guildId || null,
    });
  }

  return interaction.reply({
    embeds: [quickEmbed(interaction.client, interaction.user, 'success', [
      `**تم إرسال طلب إضافة \`${count}\` بوت**`,
      '',
      `**سعر البوت الواحد :** *${formatMoney(unitPrice, currency)}*`,
      `**الإجمالي :** *${formatMoney(totalPrice, currency)}*`,
      '',
      `**الوجهة :** *${requestTargetLabel()}*`,
    ].join('\n'))],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function addTokensToStock(raw) {
  const inputTokens = String(raw || '')
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(Boolean);
  if (!inputTokens.length) return { added: 0, invalid: 0, duplicate: 0 };

  const bots = store.get('bots') || [];
  const tokens = store.get('tokens') || [];
  const known = new Set([...bots.map(b => b.token), ...tokens.map(t => t.token)].filter(Boolean));
  let added = 0;
  let invalid = 0;
  let duplicate = 0;
  await ensureProfileImagesLocal().catch(() => {});
  const profile = subBotProfile();
  let assets = null;
  try {
    assets = await resolveProfileAssets(profile);
  } catch {
    assets = { avatarData: null, bannerData: null };
  }
  for (const token of inputTokens) {
    if (known.has(token)) {
      duplicate++;
      continue;
    }
    try {
      await applyProfileToTokenHelper(token, { profile, assets, leaveGuilds: true });
    } catch {
      invalid++;
      continue;
    }
    bots.push({ token });
    known.add(token);
    added++;
  }
  store.set('bots', bots);
  return { added, invalid, duplicate };
}

async function approveAddBots(interaction, reqId) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
  const req = readRequests().find(item => item.id === reqId);
  if (!req || req.status !== 'pending') return interaction.reply({ content: '**Request :** *الطلب غير موجود أو تم التعامل معه.*', flags: MessageFlags.Ephemeral });

  const entry = findSubscription(req.code, req.userId);
  if (!entry) return interaction.reply({ content: '**Subscription :** *الاشتراك غير موجود.*', flags: MessageFlags.Ephemeral });

  const bots = store.get('bots') || [];
  if (bots.length < req.count) {
    return interaction.reply({ content: `**Stock :** *المخزون غير كافي. المتاح الآن: \`${bots.length}\` بوت.*`, flags: MessageFlags.Ephemeral });
  }

  const given = bots.splice(0, req.count);
  const tokens = store.get('tokens') || [];
  const defaultStatus = automaticSettings().subBotStatus || null;
  const paused = !!entry.pausedAt;
  given.forEach(bot => tokens.push({
    token: bot.token,
    Server: entry.server,
    channel: null,
    chat: null,
    status: defaultStatus,
    client: req.userId,
    code: req.code,
    paused,
  }));
  entry.botsCount = Number(entry.botsCount || 0) + req.count;
  store.set('bots', bots);
  store.set('tokens', tokens);
  store.set('time', store.get('time') || []);

  const updated = updateRequest(req.id, { status: 'approved' });
  await interaction.update({
    embeds: [buildAddBotsRequestEmbed(interaction.client, updated)],
    components: addBotsRequestRows(req.id, true),
  }).catch(() => {});

  const user = await interaction.client.users.fetch(req.userId).catch(() => null);
  if (user) {
    user.send({
      embeds: [buildSubscriptionBotsAddedDm(interaction.client, {
        code: req.code,
        addedBots: req.count,
        totalBots: entry.botsCount,
      })],
    }).catch(() => {});
  }
}

async function rejectRequest(client, reqMessage, reqId, type = 'add', reason = '') {
  const req = updateRequest(reqId, { status: 'rejected', rejectionReason: reason || null });
  if (!req) return;
  const embed = type === 'renew'
    ? buildRenewRequestEmbed(client, req)
    : type === 'purchase'
      ? buildPurchaseRequestEmbed(client, req)
      : buildAddBotsRequestEmbed(client, req);
  const rows = type === 'renew'
    ? renewRequestRows(reqId, true)
    : type === 'purchase'
      ? purchaseRequestRows(reqId, true)
      : addBotsRequestRows(reqId, true);
  await reqMessage?.edit({ embeds: [embed], components: rows }).catch(() => {});
  const user = await client.users.fetch(req.userId).catch(() => null);
  if (user) {
    let typeDesc = type === 'purchase'
      ? `**تم رفض طلب الشراء**\n${req.count || '?'} بوت — ${req.durationLabel || ''}\nيمكنك المحاولة مجدداً عبر قائمة الاشتراك.`
      : type === 'renew'
        ? `**تم رفض طلب التجديد**\nالاشتراك : \`${req.code || ''}\`\nيمكنك المحاولة مجدداً عبر قائمة اشتراكاتك.`
        : `**تم رفض طلب إضافة البوتات**\nالاشتراك : \`${req.code || ''}\``;
    if (reason) typeDesc += `\n\n**السبب :** *${reason}*`;
    user.send({ embeds: [quickEmbed(client, user, 'error', typeDesc)] }).catch(() => {});
  }
}

async function startRenewal(interaction, code) {
  const entry = findSubscription(code, interaction.user.id);
  if (!entry) {
    const ep = { embeds: [quickEmbed(interaction.client, interaction.user, 'error', '**الاشتراك غير موجود**\nلم أجد اشتراكاً بهذا الرمز.')], flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) return interaction.editReply(ep).catch(() => {});
    return interaction.reply(ep).catch(() => {});
  }

  // منع الطلبات المكررة بينما طلب معلّق
  const existing = readRequests().find(r =>
    r.type === 'renewal' && r.userId === interaction.user.id && r.code === code &&
    ['awaiting_invoice', 'pending_owner'].includes(r.status) &&
    Number(r.expiresAt || 0) > Date.now(),
  );
  if (existing) {
    const desc = existing.status === 'awaiting_invoice'
      ? '**طلب تجديد معلق**\nلديك طلب تجديد بانتظار الفاتورة. أرسل صورة الفاتورة في الخاص أو انتظر انتهاء مهلة الـ 12 ساعة.'
      : '**طلب قيد المراجعة**\nطلب تجديدك وصل للإدارة وبانتظار الرد. يرجى الانتظار.';
    const ep = { embeds: [quickEmbed(interaction.client, interaction.user, 'warning', desc)], flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) return interaction.editReply(ep).catch(() => {});
    const _isEphSrc1 = interaction.message?.flags?.has?.(MessageFlags.Ephemeral);
    if (interaction.isStringSelectMenu() || (interaction.isButton() && _isEphSrc1)) return interaction.update(ep).catch(() => {});
    return interaction.reply(ep).catch(() => {});
  }

  // اختر المدة أولاً
  const settings = automaticSettings();
  const price = Number(settings.botPrice || 0);
  const currency = settings.currency || 'SAR';
  const botsCount = Number(entry.botsCount || 0);
  const priceLines = MONTH_PRESETS.map(p =>
    `**${p.months} Month | ${p.labelAr} :** ${formatMoney(price * botsCount * p.months, currency)}`,
  ).join('\n');
  const durEmbed = quickEmbed(
    interaction.client, interaction.user, 'info',
    `**Renewal | تجديد الاشتراك \`${code}\`**\n*اختر مدة التجديد :*\n\n${priceLines}`,
  );
  const payload = { embeds: [durEmbed], components: durationRenewRows(code, interaction.id), flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) return interaction.editReply(payload).catch(() => {});
  const _isEphSrc2 = interaction.message?.flags?.has?.(MessageFlags.Ephemeral);
  if (interaction.isStringSelectMenu() || (interaction.isButton() && _isEphSrc2)) return interaction.update(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

async function doStartRenewal(interaction, code, durationMs, durationLabel, durationDays) {
  const req = {
    id: randomId(10),
    type: 'renewal',
    status: 'awaiting_invoice',
    userId: interaction.user.id,
    code,
    durationMs,
    durationLabel,
    durationDays,
    createdAt: Date.now(),
    expiresAt: Date.now() + RENEWAL_TTL_MS,
  };
  const requests = readRequests().filter(item => !(item.userId === req.userId && item.code === code && item.status === 'awaiting_invoice'));
  requests.push(req);
  saveRequests(requests);

  const { paymentMethods: pmRenewal } = automaticSettings();
  const settings = automaticSettings();
  const price = Number(settings.botPrice || 0);
  const entry = findSubscription(code, interaction.user.id);
  const totalPrice = price * (entry?.botsCount || 0) * (durationMs / MONTH_PRESETS[0].ms);
  const currency = settings.currency || 'SAR';
  const userThumbR = interaction.user.displayAvatarURL({ dynamic: true, size: 256 });

  const dmEmbed = new EmbedBuilder()
    .setColor(getEmbedColor(interaction.client))
    .setTitle('Renewal Invoice | فاتورة التجديد')
    .setThumbnail(userThumbR)
    .setFooter({ text: interaction.client?.user?.username || 'Mume Auto', iconURL: interaction.client?.user?.displayAvatarURL?.() || undefined })
    .setTimestamp()
    .addFields(
      { name: 'Subscription | الاشتراك', value: `\`${code}\``, inline: true },
      { name: 'Duration | المدة', value: `\`${durationLabel}\` (${durationDays} يوم)`, inline: true },
      { name: 'Total Price | الإجمالي', value: formatMoney(totalPrice, currency), inline: true },
      ...(pmRenewal ? [{ name: 'Payment Methods | طرق الدفع', value: pmRenewal, inline: false }] : []),
      { name: 'Required | المطلوب', value: 'أرسل صورة الفاتورة هنا في الخاص حتى تصل للإدارة', inline: false },
      { name: 'Timeout | المهلة', value: 'لديك **12 ساعة** قبل حذف الطلب تلقائياً', inline: false },
    );

  const dmOk = await interaction.user.send({ embeds: [dmEmbed] }).then(() => true).catch(() => false);
  const confirmEmbed = quickEmbed(
    interaction.client, interaction.user, dmOk ? 'success' : 'error',
    dmOk
      ? '**تم إرسال الفاتورة في الخاص**\nأرسل صورة الفاتورة هناك خلال **12 ساعة**.'
      : '**تعذّر إرسال الخاص**\nافتح رسائل الخاص (Privacy Settings) ثم اضغط Renew مجدداً.',
  );
  const confirmPayload = { embeds: [confirmEmbed], components: [], flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) return interaction.editReply(confirmPayload).catch(() => {});
  return interaction.update(confirmPayload).catch(() => {});
}

async function handleInvoiceDm(client, message) {
  if (message.author.bot || message.guild) return;
  if (!message.attachments?.size) return;
  cleanupRequests();

  const requests = readRequests();
  const req = requests
    .filter(item => ['renewal', 'purchase'].includes(item.type) && item.userId === message.author.id && item.status === 'awaiting_invoice' && Number(item.expiresAt || 0) > Date.now())
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
  if (!req) return;

  const attachment = message.attachments.first();
  req.status = 'pending_owner';
  req.invoiceUrl = attachment.url;
  req.updatedAt = Date.now();
  saveRequests(requests);

  const sent = await sendToRequestTarget(client, req.type === 'purchase'
    ? {
        embeds: [buildPurchaseRequestEmbed(client, req)],
        components: purchaseRequestRows(req.id),
      }
    : {
        embeds: [buildRenewRequestEmbed(client, req)],
        components: renewRequestRows(req.id),
      });
  if (sent?.id) {
    updateRequest(req.id, {
      requestMessageId: sent.id,
      requestChannelId: sent.channelId,
      requestGuildId: sent.guildId || null,
    });
  }

  await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(getEmbedColor(client))
      .setTitle('Invoice Received | تم استلام الفاتورة')
      .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 128 }))
      .setDescription('**وصلت فاتورتك للإدارة وجاري المراجعة.**\nسيتم التواصل معك بمجرد اتخاذ القرار.')
      .setFooter({ text: client?.user?.username || 'Mume Auto', iconURL: client?.user?.displayAvatarURL?.() || undefined })
      .setTimestamp()],
  }).catch(() => {});
}

async function acceptPurchase(interaction, reqId) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
  const req = readRequests().find(item => item.id === reqId);
  if (!req || req.status !== 'pending_owner' || req.type !== 'purchase') {
    return interaction.reply({ content: '**Request :** *الطلب غير موجود أو غير جاهز.*', flags: MessageFlags.Ephemeral });
  }

  const durationMs = Number(req.durationMs || 0);
  const durationLabel = req.durationLabel || `${req.durationDays || '?'} يوم`;
  if (!durationMs || durationMs <= 0) {
    return interaction.reply({ content: '**Duration :** *المدة غير محددة في الطلب. اطلب من المستخدم إعادة الطلب.*', flags: MessageFlags.Ephemeral });
  }

  const bots = store.get('bots') || [];
  if (bots.length < req.count) {
    return interaction.reply({ content: `**Stock :** *المخزون غير كافي. المتاح الآن: \`${bots.length}\` بوت.*`, flags: MessageFlags.Ephemeral });
  }

  const code = `#${randomId(5)}`;
  const expirationTime = Date.now() + durationMs;
  const timeArray = store.get('time') || [];
  timeArray.push({
    user: req.userId,
    server: req.serverId,
    botsCount: req.count,
    subscriptionTime: durationLabel,
    expirationTime,
    code,
  });

  const given = bots.splice(0, req.count);
  const tokens = store.get('tokens') || [];
  const defaultStatus = automaticSettings().subBotStatus || null;
  given.forEach(bot => tokens.push({
    token: bot.token,
    Server: req.serverId,
    channel: null,
    chat: null,
    status: defaultStatus,
    client: req.userId,
    code,
  }));

  store.set('time', timeArray);
  store.set('tokens', tokens);
  store.set('bots', bots);

  // ── تشغيل البوتات فوراً مثل madd-sub بدون انتظار الـ manager ──────────────
  try {
    const { runsys } = require('../../music');
    for (const bot of given) {
      runsys(bot.token, req.serverId).catch(e =>
        console.error('[acceptPurchase] runsys error:', e?.message || e),
      );
    }
  } catch (e) {
    console.error('[acceptPurchase] failed to trigger bots:', e?.message || e);
  }
  // ──────────────────────────────────────────────────────────────────────────

  const updated = updateRequest(reqId, { status: 'approved', duration: durationLabel, code });
  await interaction.reply({
    embeds: [quickEmbed(interaction.client, interaction.user, 'success',
      `**تم قبول الشراء وتفعيل الاشتراك**\nكود الاشتراك : \`${code}\`\nالمدة : **${durationLabel}** (${req.durationDays || '?'} يوم)\nالمستخدم : <@${req.userId}>`)],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
  await interaction.message.edit({
    embeds: [buildPurchaseRequestEmbed(interaction.client, updated)],
    components: purchaseRequestRows(reqId, true),
  }).catch(() => {});

  const user = await interaction.client.users.fetch(req.userId).catch(() => null);
  if (user) {
    user.send({
      embeds: [buildSubscriptionActivatedDm(interaction.client, {
        code,
        botCount: req.count,
        duration: formatDuration(durationMs),
        serverId: req.serverId,
        expiresAt: expirationTime,
      })],
    }).catch(() => {});
  }
}

async function acceptRenewal(interaction, reqId) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
  const req = readRequests().find(item => item.id === reqId);
  if (!req || req.status !== 'pending_owner') return interaction.reply({ content: '**Request :** *الطلب غير موجود أو غير جاهز.*', flags: MessageFlags.Ephemeral });

  const durationMs = Number(req.durationMs || 0);
  const durationLabel = req.durationLabel || `${req.durationDays || '?'} يوم`;
  if (!durationMs || durationMs <= 0) {
    return interaction.reply({ content: '**Duration :** *المدة غير محددة في الطلب. اطلب من المستخدم إعادة الطلب.*', flags: MessageFlags.Ephemeral });
  }

  const timeArray = store.get('time') || [];
  const entry = timeArray.find(item => item.code === req.code && item.user === req.userId);
  if (!entry) return interaction.reply({ content: '**Subscription :** *الاشتراك غير موجود في قاعدة البيانات.*', flags: MessageFlags.Ephemeral });

  const prevExpiry = entry.expirationTime;
  entry.expirationTime += durationMs;
  store.set('time', timeArray);

  const updated = updateRequest(reqId, { status: 'approved', duration: durationLabel });
  await interaction.reply({
    embeds: [quickEmbed(interaction.client, interaction.user, 'success',
      `**تم قبول التجديد**\nالاشتراك : \`${req.code}\`\nمضاف : **${durationLabel}** (${req.durationDays || '?'} يوم)\nالمستخدم : <@${req.userId}>`)],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
  await interaction.message.edit({
    embeds: [buildRenewRequestEmbed(interaction.client, updated)],
    components: renewRequestRows(reqId, true),
  }).catch(() => {});

  const user = await interaction.client.users.fetch(req.userId).catch(() => null);
  if (user) {
    user.send({
      embeds: [buildSubscriptionTimeUpdatedDm(interaction.client, {
        code: req.code,
        addedTime: durationLabel,
        previousExpiry: prevExpiry,
        newExpiry: entry.expirationTime,
      })],
    }).catch(() => {});
  }
}

async function togglePause(interaction, code) {
  const timeArray = store.get('time') || [];
  const entry = timeArray.find(item => item.code === code && item.user === interaction.user.id);
  if (!entry) return interaction.reply({ content: '**Subscription :** *لم أجد هذا الاشتراك.*', flags: MessageFlags.Ephemeral }).catch(() => {});

  const tokens = store.get('tokens') || [];
  const subTokens = tokens.filter(token => token.code === code && token.client === interaction.user.id);

  if (entry.pausedAt) {
    const pausedFor = Date.now() - Number(entry.pausedAt || Date.now());
    entry.expirationTime += Math.max(0, pausedFor);
    delete entry.pausedAt;
    subTokens.forEach(token => { delete token.paused; });
    store.set('time', timeArray);
    store.set('tokens', tokens);
    return interaction.reply({
      embeds: [quickEmbed(interaction.client, interaction.user, 'success', [
        `**تم استئناف الاشتراك \`${code}\`**`,
        '',
        `**الوقت المُعاد :** *\`${formatDuration(Math.max(0, pausedFor))}\`*`,
        `**ينتهي الآن :** *<t:${Math.floor(entry.expirationTime / 1000)}:R>*`,
      ].join('\n'))],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  entry.pausedAt = Date.now();
  subTokens.forEach(token => { token.paused = true; });
  store.set('time', timeArray);
  store.set('tokens', tokens);

  try {
    const { runningBots, botLastActivity } = require('../../music');
    for (const token of subTokens) {
      const bot = runningBots.get(token.token);
      if (!bot) continue;
      await bot.destroy().catch(() => {});
      runningBots.delete(token.token);
      botLastActivity?.delete(token.token);
    }
  } catch {}

  return interaction.reply({
    embeds: [quickEmbed(interaction.client, interaction.user, 'warning', [
      `**تم إيقاف الاشتراك \`${code}\` مؤقتاً**`,
      '',
      `**البوتات :** *تم فصلها — ستُعاد عند الاستئناف.*`,
      `**الوقت :** *موقوف الآن ولن يُحسب حتى تستأنف.*`,
    ].join('\n'))],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function botInviteInfo(tokenData, mode) {
  let running = null;
  try { running = require('../../music').runningBots?.get(tokenData.token); } catch {}

  const build = (botClient) => {
    const guild = tokenData.Server ? botClient.guilds.cache.get(tokenData.Server) : null;
    if (mode === 'off' && guild) return null;
    return {
      name: botClient.user?.username || 'Unknown',
      url: `https://discord.com/api/oauth2/authorize?client_id=${botClient.user?.id}&permissions=0&scope=bot`,
    };
  };

  if (running?.isReady?.()) return build(running);

  const temp = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await temp.login(tokenData.token);
    return build(temp);
  } catch {
    return null;
  } finally {
    temp.destroy().catch(() => {});
  }
}

async function collectSubscriptionLinks(code, userId, mode = 'all') {
  const tokens = subscriptionTokens(code).filter(token => token.client === userId);
  const infos = [];
  for (const token of tokens) {
    const info = await botInviteInfo(token, mode);
    if (info) infos.push(info);
  }
  return infos;
}

async function sendSubscriptionLinksToUser(client, user, code, infos, mode = 'all') {
  if (!infos.length) return 0;
  const chunks = [];
  for (let i = 0; i < infos.length; i += 10) chunks.push(infos.slice(i, i + 10));
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const embed = new EmbedBuilder()
      .setColor(getEmbedColor(client))
      .setTitle(mode === 'off' ? 'Outside Server Links' : 'Bot Links')
      .setDescription(chunk.map((info, i) => `**Bot ${chunkIndex * 10 + i + 1} :** *\`${info.name}\`*\n\n${info.url}`).join('\n\n'))
      .setFooter({ text: `SuID ${code}` });
    await user.send({ embeds: [embed] }).catch(() => {});
  }
  return infos.length;
}

async function sendLinks(interaction, code, mode = 'all') {
  const entry = findSubscription(code, interaction.user.id);
  if (!entry) return interaction.reply({ content: '**Subscription :** *لم أجد هذا الاشتراك.*', flags: MessageFlags.Ephemeral }).catch(() => {});

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  const infos = await collectSubscriptionLinks(code, interaction.user.id, mode);

  if (!infos.length) {
    return interaction.editReply(mode === 'off' ? '**Bot Links :** *كل البوتات موجودة داخل السيرفر.*' : '**Bot Links :** *لم أستطع تجهيز روابط البوتات.*').catch(() => {});
  }

  const sentCount = await sendSubscriptionLinksToUser(interaction.client, interaction.user, code, infos, mode);

  return interaction.editReply(`**Bot Links :** *تم إرسال \`${sentCount}\` رابط في الخاص.*`).catch(() => {});
}

async function disconnectSubscriptionBots(subTokens) {
  try {
    const { runningBots, botLastActivity } = require('../../music');
    for (const token of subTokens) {
      const bot = runningBots.get(token.token);
      if (!bot) continue;
      await bot.destroy().catch(() => {});
      runningBots.delete(token.token);
      botLastActivity?.delete(token.token);
    }
  } catch {}
}

async function transferSubscriptionOwnership(interaction, code, rawUser) {
  const newUserId = parseUserId(rawUser);
  if (!newUserId) {
    return interaction.reply({ content: '**Transfer Ownership :** *ارسل منشن أو ايدي مستخدم صحيح.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (newUserId === interaction.user.id) {
    return interaction.reply({ content: '**Transfer Ownership :** *الاشتراك مملوك لك بالفعل.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const timeArray = store.get('time') || [];
  const entry = timeArray.find(item => item.code === code && item.user === interaction.user.id);
  if (!entry) return interaction.reply({ content: '**Subscription :** *لم أجد هذا الاشتراك.*', flags: MessageFlags.Ephemeral }).catch(() => {});

  const newUser = await interaction.client.users.fetch(newUserId).catch(() => null);
  if (!newUser) {
    return interaction.reply({ content: '**Transfer Ownership :** *لم أستطع العثور على المستخدم الجديد.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  entry.user = newUserId;
  const tokens = store.get('tokens') || [];
  const subTokens = tokens.filter(token => token.code === code);
  subTokens.forEach(token => { token.client = newUserId; });
  store.set('time', timeArray);
  store.set('tokens', tokens);

  await interaction.reply({
    content: `**Transfer Ownership :** *تم نقل ملكية الاشتراك \`${code}\` إلى <@${newUserId}>.*`,
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});

  await newUser.send({
    embeds: [buildOwnershipTransferredDm(interaction.client, {
      oldOwnerId: interaction.user.id,
      newOwnerId,
      codes: [code],
      botCount: entry.botsCount || subTokens.length,
    })],
  }).catch(() => {});
}

async function moveSubscriptionServer(interaction, code, rawServerId) {
  const newServerId = String(rawServerId || '').trim();
  if (!/^\d{15,20}$/.test(newServerId)) {
    return interaction.reply({ content: '**Move Server :** *اكتب ايدي سيرفر صحيح.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const timeArray = store.get('time') || [];
  const entry = timeArray.find(item => item.code === code && item.user === interaction.user.id);
  if (!entry) return interaction.reply({ content: '**Subscription :** *لم أجد هذا الاشتراك.*', flags: MessageFlags.Ephemeral }).catch(() => {});

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  const oldServerId = entry.server;
  entry.server = newServerId;

  const tokens = store.get('tokens') || [];
  const subTokens = tokens.filter(token => token.code === code);
  subTokens.forEach(token => {
    token.Server = newServerId;
    token.channel = null;
    token.chat = null;
    token.status = null;
  });
  store.set('time', timeArray);
  store.set('tokens', tokens);

  const infos = await collectSubscriptionLinks(code, interaction.user.id, 'all');
  const sentCount = await sendSubscriptionLinksToUser(interaction.client, interaction.user, code, infos, 'all');
  await disconnectSubscriptionBots(subTokens);

  await interaction.user.send({
    embeds: [buildServerUpdatedDm(interaction.client, {
      serverId: newServerId,
      codes: [code],
      movedBots: subTokens.length,
      linksSent: sentCount > 0,
    })],
  }).catch(() => {});

  return interaction.editReply([
    `**Move Server :** *تم نقل اشتراك \`${code}\` إلى السيرفر الجديد.*`,
    '',
    `**Old Server :** *\`${oldServerId || 'غير محدد'}\`*`,
    '',
    `**New Server :** *\`${newServerId}\`*`,
    '',
    `**Bot Links :** *تم إرسال \`${sentCount}\` رابط في الخاص لإضافة البوتات للسيرفر الجديد.*`,
  ].join('\n')).catch(() => {});
}

async function handleAdminTarget(interaction) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
  const modal = new ModalBuilder().setCustomId('auto_target_modal').setTitle('Request Target');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('mode')
        .setLabel('Mode')
        .setPlaceholder('dm or channel')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('channel')
        .setLabel('Channel ID')
        .setPlaceholder('Leave empty when mode is dm')
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
  );
  await interaction.showModal(modal);

  const submit = await interaction.awaitModalSubmit({
    filter: i => i.customId === 'auto_target_modal' && i.user.id === interaction.user.id,
    time: 60000,
  }).catch(() => null);
  if (!submit) return;

  const mode = submit.fields.getTextInputValue('mode').trim().toLowerCase();
  const channelId = submit.fields.getTextInputValue('channel').trim();
  if (!['dm', 'channel'].includes(mode)) return submit.reply({ content: '**Mode :** *اكتب `dm` أو `channel` فقط.*', flags: MessageFlags.Ephemeral });
  if (mode === 'channel' && !/^\d{17,20}$/.test(channelId)) return submit.reply({ content: '**Channel ID :** *ايدي الروم غير صحيح.*', flags: MessageFlags.Ephemeral });

  saveAutomaticSettings({ requestMode: mode, requestChannelId: mode === 'channel' ? channelId : null });
  await submit.reply({ content: '**Request Target :** *تم تحديث مكان استقبال الطلبات بنجاح.*', flags: MessageFlags.Ephemeral });
  await interaction.message?.edit({
    ...autoImagePayload(buildOwnerEmbed(interaction.client, interaction.user)),
    components: ownerRows(),
  }).catch(() => {});
}

async function handleAdminPricing(interaction) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
  const settings = automaticSettings();
  const modal = new ModalBuilder().setCustomId('auto_pricing_modal').setTitle('Pricing Settings');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('price')
        .setLabel('Bot Price')
        .setPlaceholder('Example: 15')
        .setValue(String(settings.botPrice || 0))
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('currency')
        .setLabel('Currency')
        .setPlaceholder('Example: SAR')
        .setValue(String(settings.currency || 'SAR'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);

  const submit = await interaction.awaitModalSubmit({
    filter: i => i.customId === 'auto_pricing_modal' && i.user.id === interaction.user.id,
    time: 60000,
  }).catch(() => null);
  if (!submit) return;

  const price = parsePrice(submit.fields.getTextInputValue('price'));
  const currency = submit.fields.getTextInputValue('currency').trim().slice(0, 12) || 'SAR';
  if (price === null) return submit.reply({ content: '**Bot Price :** *اكتب سعر صحيح مثل `15` أو `15.5`.*', flags: MessageFlags.Ephemeral });

  saveAutomaticSettings({ botPrice: price, currency });
  await submit.reply({
    content: `**Bot Price :** *تم حفظ سعر البوت الواحد: ${formatMoney(price, currency)}.*`,
    flags: MessageFlags.Ephemeral,
  });
  await interaction.message?.edit({
    ...autoImagePayload(buildOwnerEmbed(interaction.client, interaction.user)),
    components: ownerRows(),
  }).catch(() => {});
  await refreshSavedPublicPanel(interaction.client);
}

async function handleAdminPaymentMethods(interaction) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });

  const settings = automaticSettings();
  const current = settings.paymentMethods;

  // أرسل رسالة مؤقتة في نفس الشات تطلب منه الكتابة
  const prompt = await interaction.reply({
    content: [
      '**Payment Methods | طرق الدفع**',
      '*اكتب طرق الدفع في رسالة واحدة وأرسلها الآن.*',
      '',
      current
        ? `**الحالي الآن :**\n\`\`\`\n${current}\n\`\`\``
        : '*لا توجد طرق دفع محفوظة حالياً.*',
      '',
      '**مثال على الشكل الصحيح :**',
      '```',
      'STCPay: 0500000000',
      'PayPal: example@email.com',
      'Bank Transfer: SA0000000000000',
      '```',
      '',
      '*لإلغاء العملية أرسل: `cancel`*',
      '*لديك 2 دقيقة.*',
    ].join('\n'),
    fetchReply: true,
  }).catch(() => null);

  if (!prompt) return;

  // انتظر رسالة من نفس الشخص في نفس الشات
  const collected = await interaction.channel.awaitMessages({
    filter: m => m.author.id === interaction.user.id,
    max: 1,
    time: 2 * 60 * 1000,
    errors: ['time'],
  }).catch(() => null);

  // احذف رسالة الطلب بعد الرد
  prompt.delete?.().catch(() => {});

  if (!collected || collected.size === 0) {
    return interaction.followUp({ content: '**Payment Methods :** *انتهى الوقت. لم يتم حفظ أي تغييرات.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const msg = collected.first();
  const raw = msg.content.trim();

  // احذف رسالة المستخدم تنظيفاً للشات
  msg.delete?.().catch(() => {});

  // تحقق من الإلغاء
  if (raw.toLowerCase() === 'cancel') {
    return interaction.followUp({ content: '**Payment Methods :** *تم الإلغاء. لم يتم حفظ أي تغييرات.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // فحص أن النص ليس فارغاً
  if (!raw) {
    return interaction.followUp({ content: '**Payment Methods :** *الرسالة فارغة. لم يتم حفظ أي شيء.*', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // فحص الحد الأقصى للطول
  if (raw.length > 1000) {
    return interaction.followUp({ content: `**Payment Methods :** *النص طويل جداً (${raw.length}/1000 حرف). قصّره ثم أعد المحاولة.*`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // حفظ طرق الدفع
  saveAutomaticSettings({ paymentMethods: raw });

  await interaction.followUp({
    content: [
      '**Payment Methods :** *تم الحفظ بنجاح ✓*',
      '',
      '**ستظهر هكذا في رسائل الفاتورة للعملاء :**',
      '```',
      raw,
      '```',
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});

  await interaction.message?.edit({
    ...autoImagePayload(buildOwnerEmbed(interaction.client, interaction.user)),
    components: ownerRows(),
  }).catch(() => {});
}

async function sendPublicPanel(interaction) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });

  // Step 1: Ask owner which channel to send the panel to
  const selectRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('auto_panel_channel_select')
      .setPlaceholder('اختر الروم لإرسال البانل')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('auto_panel_cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({
    content: '**اختر الروم الذي تريد إرسال البانل فيه:**',
    embeds: [],
    files: [],
    components: [selectRow, cancelRow],
  });
}

async function handlePanelChannelSelect(interaction) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });

  const targetChannelId = interaction.values[0];
  const targetChannel = await interaction.client.channels.fetch(targetChannelId).catch(() => null);

  if (!targetChannel?.send) {
    return interaction.update({
      content: '**Channel :** *لم أستطع الوصول للروم، تأكد من الصلاحيات.*',
      embeds: [],
      files: [],
      components: ownerRows(),
    });
  }

  const msg = await targetChannel.send({ embeds: [], files: [], ...publicPanelPayload(interaction.client) });
  saveAutomaticSettings({
    panelGuildId: msg.guildId,
    panelChannelId: msg.channelId,
    panelMessageId: msg.id,
    panelUrl: msg.url,
  });

  return interaction.update({
    content: '',
    ...autoImagePayload(buildOwnerEmbed(interaction.client, interaction.user)),
    components: ownerRows(),
  });
}

async function handleAdminImage(interaction) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });

  const settings = automaticSettings();
  const modal = new ModalBuilder().setCustomId('auto_image_modal').setTitle('Panel Image');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('image_url')
        .setLabel('رابط الصورة (فارغ = استخدم الافتراضية)')
        .setPlaceholder('https://...')
        .setValue(settings.panelImageUrl || '')
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
  );
  await interaction.showModal(modal);

  const submit = await interaction.awaitModalSubmit({
    filter: i => i.customId === 'auto_image_modal' && i.user.id === interaction.user.id,
    time: 60000,
  }).catch(() => null);
  if (!submit) return;

  const url = submit.fields.getTextInputValue('image_url').trim();
  saveAutomaticSettings({ panelImageUrl: url || null });

  await submit.reply({
    content: url
      ? `**Panel Image :** *تم حفظ رابط الصورة الجديد.*`
      : `**Panel Image :** *تم المسح — سيتم استخدام الصورة الافتراضية.*`,
    flags: MessageFlags.Ephemeral,
  });
  await interaction.message?.edit({
    embeds: [],
    files: [],
    ...autoImagePayload(buildOwnerEmbed(interaction.client, interaction.user)),
    components: ownerRows(),
  }).catch(() => {});
  await refreshSavedPublicPanel(interaction.client);
}

async function handleAdminProfile(interaction) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });

  await ensureProfileImagesLocal().catch(() => {});
  const profile = subBotProfile();
  const allBots = store.get('bots') || [];
  const activeSubs = new Set((store.get('tokens') || []).map(t => t.token));
  const freeStock = allBots.filter(b => !activeSubs.has(b.token)).length;
  const inSubs    = allBots.length - freeStock;

  const profileEmbed = new EmbedBuilder()
    .setColor(getEmbedColor(interaction.client))
    .setTitle('Sub-Bot Profile | مظهر البوتات')
    .setThumbnail(interaction.client.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription([
      'Sub-bot appearance settings. These settings apply to new stock tokens and can be applied to free stock bots.',
      'إعدادات مظهر البوتات الفرعية. تطبق على التوكنات الجديدة ويمكن تطبيقها على بوتات الستوك الحرة.',
      '',
      `**Prefix | بادئة الاسم :** *\`${profile.prefix}\`*`,
      '',
      `**Avatar | الصورة :** *${profileImageDisplay(profile.avatar)}*`,
      '',
      `**Banner | البنر :** *${profileImageDisplay(profile.banner)}*`,
      '',
      `**Streaming | حالة الستريمنق :** *\`${profile.status || 'Not set | غير محدد'}\`*`,
      '',
      `**Free Stock | الستوك الحر :** *\`${freeStock}\`*`,
      `**In Subscriptions | داخل اشتراكات :** *\`${inSubs}\`*`,
    ].join('\n'))
    .setFooter({ text: `${interaction.client.user.username} | Sub-Bot Profile`, iconURL: interaction.client.user.displayAvatarURL({ dynamic: true }) });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('auto_profile_botsname').setLabel('Prefix | الاسم').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('auto_profile_avatar').setLabel('Avatar | الصورة').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('auto_profile_banner').setLabel('Banner | البنر').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('auto_profile_streaming').setLabel('Streaming | الحالة').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('auto_profile_applyall').setLabel('Apply | تطبيق').setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('auto_profile_back').setLabel('Back | رجوع').setStyle(ButtonStyle.Primary),
  );

  return interaction.update({ embeds: [profileEmbed], components: [row1, row2] });
}

async function handleProfileAction(interaction, action) {
  if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });

  if (action === 'botsname') {
    await ensureProfileImagesLocal().catch(() => {});
    const profile = subBotProfile();
    const modal = new ModalBuilder().setCustomId('auto_profile_modal_botsname').setTitle('Sub-Bot Name Prefix');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('botsname')
        .setLabel('Prefix')
        .setPlaceholder('مثال: music')
        .setValue(profile.prefix)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20),
    ));
    await interaction.showModal(modal);
    const submit = await interaction.awaitModalSubmit({ filter: i => i.customId === 'auto_profile_modal_botsname' && i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
    if (!submit) return;
    const val = submit.fields.getTextInputValue('botsname').trim();
    saveAutomaticSettings({ subBotPrefix: val });
    return submit.reply({ content: `**Prefix :** *تم حفظ البادئة \`${val}\` — ستُطبَّق على البوتات الجديدة عند إضافتها.*`, flags: MessageFlags.Ephemeral });
          }
        
          if (action === 'avatar') {
            await ensureProfileImagesLocal().catch(() => {});
            const profile = subBotProfile();
    const modal = new ModalBuilder().setCustomId('auto_profile_modal_avatar').setTitle('Sub-Bot Avatar URL');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('url')
        .setLabel('Avatar Image URL')
        .setPlaceholder('https://...')
        .setValue(profile.avatar || '')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ));
    await interaction.showModal(modal);
    const submit = await interaction.awaitModalSubmit({ filter: i => i.customId === 'auto_profile_modal_avatar' && i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
    if (!submit) return;
    const val = submit.fields.getTextInputValue('url').trim();
    try {
      const savedPath = await saveProfileImageLocally(val, 'avatar');
      saveAutomaticSettings({ subBotAvatar: savedPath });
      return submit.reply({ content: `**Avatar :** *تم حفظ الصورة محلياً في \`${savedPath}\` — ستُطبَّق على البوتات الجديدة عند إضافتها.*`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      return submit.reply({ content: `**Avatar :** *فشل حفظ الصورة محلياً: ${error.message || 'Unknown error'}*`, flags: MessageFlags.Ephemeral });
    }
  }

  if (action === 'banner') {
    const profile = subBotProfile();
    const modal = new ModalBuilder().setCustomId('auto_profile_modal_banner').setTitle('Sub-Bot Banner URL');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('url')
        .setLabel('Banner Image URL')
        .setPlaceholder('https://...')
        .setValue(profile.banner || '')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ));
    await interaction.showModal(modal);
    const submit = await interaction.awaitModalSubmit({ filter: i => i.customId === 'auto_profile_modal_banner' && i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
    if (!submit) return;
    const val = submit.fields.getTextInputValue('url').trim();
    try {
      const savedPath = await saveProfileImageLocally(val, 'banner');
      saveAutomaticSettings({ subBotBanner: savedPath });
      return submit.reply({ content: `**Banner :** *تم حفظ البنر محلياً في \`${savedPath}\` — سيُطبَّق على البوتات الجديدة عند إضافتها.*`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      return submit.reply({ content: `**Banner :** *فشل حفظ البنر محلياً: ${error.message || 'Unknown error'}*`, flags: MessageFlags.Ephemeral });
    }
  }

  if (action === 'streaming') {
    const profile = subBotProfile();
    const modal = new ModalBuilder().setCustomId('auto_profile_modal_streaming').setTitle('Sub-Bot Streaming Status');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('status')
        .setLabel('Streaming Status Text')
        .setPlaceholder('النص الظاهر في حالة البوتات الفرعية')
        .setValue(profile.status || '')
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ));
    await interaction.showModal(modal);
    const submit = await interaction.awaitModalSubmit({ filter: i => i.customId === 'auto_profile_modal_streaming' && i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
    if (!submit) return;
    const val = submit.fields.getTextInputValue('status').trim();
    saveAutomaticSettings({ subBotStatus: val || null });
    return submit.reply({ content: `**Streaming :** *تم حفظ الحالة \`${val || '(فارغة)'}\` — ستُطبَّق على البوتات الجديدة.*`, flags: MessageFlags.Ephemeral });
  }

          if (action === 'applyall') {
            const allBots = store.get('bots') || [];
            const activeSubs = new Set((store.get('tokens') || []).map(t => t.token));
            const stockBots = allBots.filter(b => !activeSubs.has(b.token));

            if (stockBots.length === 0) return interaction.reply({ content: '**Apply :** *لا توجد بوتات حرة في الستوك (كلهم في اشتراكات).*', flags: MessageFlags.Ephemeral });
        
            const secs = stockBots.length * 5;
            const timeStr = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
            await interaction.reply({ content: `**Apply :** *جاري تطبيق الإعدادات على \`${stockBots.length}\` بوت حر في الستوك — الوقت المتوقع ~${timeStr} دقيقة.*`, flags: MessageFlags.Ephemeral });
        
            await ensureProfileImagesLocal().catch(() => {});
            const profile = subBotProfile();
    let assets = null;
    try {
      assets = await resolveProfileAssets(profile);
    } catch {
      assets = { avatarData: null, bannerData: null };
    }
    let done = 0;
    let failed = 0;
    for (const bot of stockBots) {
      try {
        await applyProfileToToken(bot.token, profile, { assets });
        done++;
      } catch {
        failed++;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    return interaction.followUp({ content: `**Apply Done | تم التطبيق**\nSuccess: \`${done}\`\nFailed: \`${failed}\`\nالبوتات الموجودة داخل اشتراكات لم يتم تعديلها.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

async function showStockDetails(interaction) {
  if (!owners.includes(interaction.user.id)) {
    return interaction.reply({ embeds: [quickEmbed(interaction.client, interaction.user, 'error', '**Permission :** *هذا الزر للأونرات فقط.*')], flags: MessageFlags.Ephemeral });
  }
  const allBots = store.get('bots') || [];
  const allTokens = store.get('tokens') || [];
  const timeArray = store.get('time') || [];
  const activeTokenSet = new Set(allTokens.map(t => t.token));
  const freeStock = allBots.filter(b => !activeTokenSet.has(b.token)).length;
  const pausedCount = timeArray.filter(e => e.pausedAt).length;
  const activeCount = timeArray.length - pausedCount;
  const lines = timeArray.slice(0, 15).map(entry => {
    const tks = allTokens.filter(t => t.code === entry.code).length;
    const paused = !!entry.pausedAt;
    const remaining = paused
      ? Math.max(0, entry.expirationTime - Number(entry.pausedAt || Date.now()))
      : Math.max(0, entry.expirationTime - Date.now());
    const days = Math.floor(remaining / 86400000);
    return `\`${entry.code}\` — \`${tks}\` بوت — ${days}d — ${paused ? 'متوقف' : 'نشط'}`;
  });
  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(interaction.client))
    .setTitle('Stock Details | تفاصيل الستوك')
    .setDescription([
      `**Free Stock | الستوك المتاح :** *\`${freeStock}\`*`,
      '',
      `**In Subscriptions | داخل اشتراكات :** *\`${allTokens.length}\`*`,
      '',
      `**Active Subs | اشتراكات نشطة :** *\`${activeCount}\`*`,
      `**Paused Subs | اشتراكات متوقفة :** *\`${pausedCount}\`*`,
      '',
      lines.length ? `**Subscriptions :**\n${lines.join('\n')}` : '*لا توجد اشتراكات.*',
    ].join('\n'))
    .setFooter({ text: `${interaction.client.user?.username || 'Mume'} | Stock`, iconURL: interaction.client.user?.displayAvatarURL({ dynamic: true }) })
    .setTimestamp();
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function handleContactSupport(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('auto_support_modal')
    .setTitle('Contact Support | تواصل مع الدعم');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('message')
        .setLabel('Message | الرسالة')
        .setPlaceholder('اكتب استفسارك أو مشكلتك هنا...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000),
    ),
  );
  await interaction.showModal(modal);
  const submit = await interaction.awaitModalSubmit({
    filter: i => i.customId === 'auto_support_modal' && i.user.id === interaction.user.id,
    time: 120000,
  }).catch(() => null);
  if (!submit) return;
  const msg = submit.fields.getTextInputValue('message').trim();
  const supportEmbed = new EmbedBuilder()
    .setColor(getEmbedColor(interaction.client))
    .setTitle('Support Request | طلب دعم')
    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 128 }))
    .setDescription([
      `**User | المستخدم :** *<@${interaction.user.id}> (\`${interaction.user.tag || interaction.user.username}\`)*`,
      '',
      `**Message | الرسالة :**\n${msg}`,
    ].join('\n'))
    .setFooter({ text: `User ID : ${interaction.user.id}` })
    .setTimestamp();
  let sent = false;
  for (const ownerId of owners) {
    const owner = await interaction.client.users.fetch(ownerId).catch(() => null);
    if (!owner) continue;
    const ok = await owner.send({ embeds: [supportEmbed] }).then(() => true).catch(() => false);
    if (ok) sent = true;
  }
  return submit.reply({
    embeds: [quickEmbed(interaction.client, interaction.user, sent ? 'success' : 'error',
      sent
        ? '**تم إرسال رسالتك للدعم**\nسيتم التواصل معك قريباً.'
        : '**تعذّر إرسال الرسالة**\nحدث خطأ، حاول مرة أخرى لاحقاً.')],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function handlePricingCalculator(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('auto_pricing_modal')
    .setTitle('Price Calculator | حاسبة السعر');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('count')
        .setLabel('Bot Count | عدد البوتات')
        .setPlaceholder('مثال : 5')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('months')
        .setLabel('Months | الأشهر (1 أو 2 أو 3)')
        .setPlaceholder('1 أو 2 أو 3')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(1),
    ),
  );
  await interaction.showModal(modal);
  const submit = await interaction.awaitModalSubmit({
    filter: i => i.customId === 'auto_pricing_modal' && i.user.id === interaction.user.id,
    time: 120000,
  }).catch(() => null);
  if (!submit) return;
  const count = parseInt(submit.fields.getTextInputValue('count').trim(), 10);
  const months = parseInt(submit.fields.getTextInputValue('months').trim(), 10);
  if (!Number.isInteger(count) || count <= 0) {
    return submit.reply({ embeds: [quickEmbed(interaction.client, interaction.user, 'error', '**عدد البوتات غير صحيح**\nاكتب رقماً صحيحاً أكبر من صفر.')], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (![1, 2, 3].includes(months)) {
    return submit.reply({ embeds: [quickEmbed(interaction.client, interaction.user, 'error', '**عدد الأشهر غير صحيح**\nاكتب 1 أو 2 أو 3 فقط.')], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const s = automaticSettings();
  const pricePerBot = Number(s.botPrice || 0);
  const currency = s.currency || 'SAR';
  const totalPrice = pricePerBot * count * months;
  const preset = MONTH_PRESETS.find(p => p.months === months);
  return submit.reply({
    embeds: [new EmbedBuilder()
      .setColor(getEmbedColor(interaction.client))
      .setTitle('Price Calculation | حساب السعر')
      .setDescription([
        `**Bot Count | عدد البوتات :** *\`${count}\`*`,
        '',
        `**Duration | المدة :** *${preset?.labelAr || months + ' شهر'} (${preset?.days || months * 30} يوم)*`,
        '',
        `**Price / Bot / Month | سعر البوت / شهر :** *${formatMoney(pricePerBot, currency)}*`,
        '',
        `**Total Price | الإجمالي :** *${formatMoney(totalPrice, currency)}*`,
      ].join('\n'))
      .setFooter({ text: interaction.client?.user?.username || 'Mume Auto', iconURL: interaction.client?.user?.displayAvatarURL?.() || undefined })
      .setTimestamp()],
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('auto_')) return;
  cleanupRequests();

  if (interaction.isButton()) {
    if (id === 'auto_admin_target') return handleAdminTarget(interaction);
    if (id === 'auto_admin_pricing') return handleAdminPricing(interaction);
    if (id === 'auto_admin_payment_methods') return handleAdminPaymentMethods(interaction);
    if (id === 'auto_admin_send') return sendPublicPanel(interaction);
    if (id === 'auto_admin_image') return handleAdminImage(interaction);
    if (id === 'auto_panel_cancel') {
      if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
      return interaction.update({
        content: '',
        ...autoImagePayload(buildOwnerEmbed(interaction.client, interaction.user)),
        components: ownerRows(),
      });
    }
    if (id === 'auto_admin_profile') return handleAdminProfile(interaction);
    if (id === 'auto_profile_back') {
      if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
      return interaction.update({ ...autoImagePayload(buildOwnerEmbed(interaction.client, interaction.user)), components: ownerRows() });
    }
    if (id === 'auto_profile_botsname') return handleProfileAction(interaction, 'botsname');
    if (id === 'auto_profile_avatar') return handleProfileAction(interaction, 'avatar');
    if (id === 'auto_profile_banner') return handleProfileAction(interaction, 'banner');
    if (id === 'auto_profile_streaming') return handleProfileAction(interaction, 'streaming');
    if (id === 'auto_profile_applyall') return handleProfileAction(interaction, 'applyall');
    if (id === 'auto_user_buy') {
      // منع الطلبات المكررة قبل عرض أزرار المدة
      const existingBuy = readRequests().find(r =>
        r.type === 'purchase' && r.userId === interaction.user.id &&
        ['awaiting_invoice', 'pending_owner'].includes(r.status) &&
        Number(r.expiresAt || 0) > Date.now(),
      );
      if (existingBuy) {
        const blockedDesc = existingBuy.status === 'awaiting_invoice'
          ? '**طلب معلق**\nلديك طلب شراء بانتظار الفاتورة. أرسل صورة الفاتورة في الخاص أو انتظر انتهاء مهلة الـ 12 ساعة.'
          : '**طلب قيد المراجعة**\nطلبك وصل للإدارة وبانتظار الرد. يرجى الانتظار.';
        return interaction.reply({
          embeds: [quickEmbed(interaction.client, interaction.user, 'warning', blockedDesc)],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      const s = automaticSettings();
      const price = Number(s.botPrice || 0);
      const cur = s.currency || 'SAR';
      const priceLines = MONTH_PRESETS.map(p =>
        `**${p.months} Month | ${p.labelAr} :** ${formatMoney(price * p.months, cur)} / بوت`,
      ).join('\n');
      return interaction.reply({
        embeds: [quickEmbed(interaction.client, interaction.user, 'info',
          `**Buy Subscription | شراء اشتراك**\n*اختر مدة الاشتراك :*\n\n${priceLines}`)],
        components: durationBuyRows(interaction.id),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    // Duration selection for Buy: auto_buy_dur_{months}_{origIid}
    if (/^auto_buy_dur_[123]_/.test(id)) {
      const months = parseInt(id.split('_')[3], 10);
      const preset = MONTH_PRESETS.find(p => p.months === months);
      if (!preset) return;
      const modal = new ModalBuilder().setCustomId(`auto_buy_modal_${interaction.id}`).setTitle('Buy Subscription');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('count')
            .setLabel('Bot Count | عدد البوتات')
            .setPlaceholder('مثال: 2')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('server_id')
            .setLabel('Server ID | ايدي السيرفر')
            .setPlaceholder('مثال: 123456789012345678')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(15)
            .setMaxLength(20),
        ),
      );
      await interaction.showModal(modal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_buy_modal_${interaction.id}` && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);
      if (!submit) return;
      const count = parseInt(submit.fields.getTextInputValue('count').trim(), 10);
      const serverId = submit.fields.getTextInputValue('server_id').trim();
      if (!Number.isInteger(count) || count <= 0) return submit.reply({ content: '**Bot Count :** *اكتب عدد صحيح أكبر من صفر.*', flags: MessageFlags.Ephemeral });
      if (!/^\d{15,20}$/.test(serverId)) return submit.reply({ content: '**Server ID :** *اكتب ايدي سيرفر صحيح.*', flags: MessageFlags.Ephemeral });
      return startPurchase(submit, count, serverId, preset.ms, preset.labelAr, preset.days);
    }

    // Duration selection for Renewal: auto_rdur_{months}_{code}_{iid_last10}
    if (/^auto_rdur_[123]_/.test(id)) {
      const parts = id.split('_');
      const months = parseInt(parts[2], 10);
      const preset = MONTH_PRESETS.find(p => p.months === months);
      if (!preset) return;
      // code is parts[3] (e.g. "#AB12C"), everything before last segment
      const code = parts.slice(3, -1).join('_');
      return doStartRenewal(interaction, code, preset.ms, preset.labelAr, preset.days);
    }
    if (id === 'auto_admin_stock') return showStockDetails(interaction);
    if (id === 'auto_user_pricing') return handlePricingCalculator(interaction);
    if (id === 'auto_user_support') return handleContactSupport(interaction);
    if (id === 'auto_user_my') return showSubscriptionPicker(interaction, 'my');
    if (id === 'auto_user_renew') return showSubscriptionPicker(interaction, 'renew');
    if (id === 'auto_user_links') return showSubscriptionPicker(interaction, 'links_all');
    if (id === 'auto_user_pause') return showSubscriptionPicker(interaction, 'pause');

    if (id.startsWith('auto_sub_control_')) return showControlPanel(interaction, id.slice('auto_sub_control_'.length));
    if (id.startsWith('auto_control_back_')) return showSubscription(interaction, id.slice('auto_control_back_'.length));

    if (id.startsWith('auto_control_owner_')) {
      const code = id.slice('auto_control_owner_'.length);
      const modal = new ModalBuilder().setCustomId(`auto_owner_modal_${code}`).setTitle('Transfer Ownership');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('new_owner')
          .setLabel('New Owner ID')
          .setPlaceholder('User ID or mention')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ));
      await interaction.showModal(modal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_owner_modal_${code}` && i.user.id === interaction.user.id,
        time: 60000,
      }).catch(() => null);
      if (!submit) return;
      return transferSubscriptionOwnership(submit, code, submit.fields.getTextInputValue('new_owner'));
    }

    if (id.startsWith('auto_control_server_')) {
      const code = id.slice('auto_control_server_'.length);
      const modal = new ModalBuilder().setCustomId(`auto_server_modal_${code}`).setTitle('Move Server');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('server_id')
          .setLabel('New Server ID')
          .setPlaceholder('Example: 123456789012345678')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ));
      await interaction.showModal(modal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_server_modal_${code}` && i.user.id === interaction.user.id,
        time: 60000,
      }).catch(() => null);
      if (!submit) return;
      return moveSubscriptionServer(submit, code, submit.fields.getTextInputValue('server_id'));
    }

    if (id.startsWith('auto_control_links_all_')) return sendLinks(interaction, id.slice('auto_control_links_all_'.length), 'all');
    if (id.startsWith('auto_control_links_off_')) return sendLinks(interaction, id.slice('auto_control_links_off_'.length), 'off');

    if (id.startsWith('auto_sub_add_')) {
      const code = id.slice('auto_sub_add_'.length);
      const modal = new ModalBuilder().setCustomId(`auto_addbots_modal_${code}`).setTitle('Add Bots');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('count').setLabel('Bot Count').setPlaceholder('Example: 2').setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_addbots_modal_${code}` && i.user.id === interaction.user.id,
        time: 60000,
      }).catch(() => null);
      if (!submit) return;
      const count = parseInt(submit.fields.getTextInputValue('count').trim(), 10);
      if (!Number.isInteger(count) || count <= 0) return submit.reply({ content: '**Bot Count :** *اكتب عدد صحيح أكبر من صفر.*', flags: MessageFlags.Ephemeral });
      return requestAddBots(submit, code, count);
    }

    if (id.startsWith('auto_sub_renew_')) return startRenewal(interaction, id.slice('auto_sub_renew_'.length));
    if (id.startsWith('auto_sub_pause_')) return togglePause(interaction, id.slice('auto_sub_pause_'.length));
    if (id.startsWith('auto_sub_links_all_')) return sendLinks(interaction, id.slice('auto_sub_links_all_'.length), 'all');
    if (id.startsWith('auto_sub_links_off_')) return sendLinks(interaction, id.slice('auto_sub_links_off_'.length), 'off');

    if (id.startsWith('auto_req_tokens_')) {
      if (!owners.includes(interaction.user.id)) return interaction.reply({ content: '**Permission :** *هذا الزر للأونرات فقط.*', flags: MessageFlags.Ephemeral });
      const reqId = id.slice('auto_req_tokens_'.length);
      const modal = new ModalBuilder().setCustomId(`auto_addtokens_modal_${reqId}`).setTitle('Add Tokens');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tokens').setLabel('Tokens').setPlaceholder('One token per line, or separated by spaces').setStyle(TextInputStyle.Paragraph).setRequired(true),
      ));
      await interaction.showModal(modal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_addtokens_modal_${reqId}` && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);
      if (!submit) return;
      const result = await addTokensToStock(submit.fields.getTextInputValue('tokens'));
      const req = readRequests().find(item => item.id === reqId);
      await submit.reply({
        content: [
          `**Stock :** *تم إضافة \`${result.added}\` توكن للمخزون.*`,
          `**Invalid :** *\`${result.invalid}\`*`,
          `**Duplicate :** *\`${result.duplicate}\`*`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      if (req) {
        await interaction.message.edit({
          embeds: [buildAddBotsRequestEmbed(interaction.client, req)],
          components: addBotsRequestRows(reqId),
        }).catch(() => {});
      }
      return;
    }

    if (id.startsWith('auto_req_add_')) return approveAddBots(interaction, id.slice('auto_req_add_'.length));
    if (id.startsWith('auto_req_reject_')) {
      const reqId = id.slice('auto_req_reject_'.length);
      const savedMsg = interaction.message;
      const reasonModal = new ModalBuilder()
        .setCustomId(`auto_reject_reason_modal_${reqId}`)
        .setTitle('Reject Reason | سبب الرفض');
      reasonModal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason | السبب')
          .setPlaceholder('اكتب سبب الرفض...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ));
      await interaction.showModal(reasonModal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_reject_reason_modal_${reqId}` && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);
      if (!submit) return;
      const reason = submit.fields.getTextInputValue('reason').trim();
      await rejectRequest(interaction.client, savedMsg, reqId, 'add', reason);
      return submit.reply({ embeds: [quickEmbed(interaction.client, interaction.user, 'success', '**تم رفض الطلب وإشعار المستخدم.**')], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (id.startsWith('auto_renew_accept_')) return acceptRenewal(interaction, id.slice('auto_renew_accept_'.length));
    if (id.startsWith('auto_renew_reject_')) {
      const reqId = id.slice('auto_renew_reject_'.length);
      const savedMsg = interaction.message;
      const reasonModal = new ModalBuilder()
        .setCustomId(`auto_reject_reason_modal_${reqId}`)
        .setTitle('Reject Reason | سبب الرفض');
      reasonModal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason | السبب')
          .setPlaceholder('اكتب سبب الرفض...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ));
      await interaction.showModal(reasonModal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_reject_reason_modal_${reqId}` && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);
      if (!submit) return;
      const reason = submit.fields.getTextInputValue('reason').trim();
      await rejectRequest(interaction.client, savedMsg, reqId, 'renew', reason);
      return submit.reply({ embeds: [quickEmbed(interaction.client, interaction.user, 'success', '**تم رفض طلب التجديد وإشعار المستخدم.**')], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (id.startsWith('auto_purchase_accept_')) return acceptPurchase(interaction, id.slice('auto_purchase_accept_'.length));
    if (id.startsWith('auto_purchase_reject_')) {
      const reqId = id.slice('auto_purchase_reject_'.length);
      const savedMsg = interaction.message;
      const reasonModal = new ModalBuilder()
        .setCustomId(`auto_reject_reason_modal_${reqId}`)
        .setTitle('Reject Reason | سبب الرفض');
      reasonModal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason | السبب')
          .setPlaceholder('اكتب سبب الرفض...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ));
      await interaction.showModal(reasonModal);
      const submit = await interaction.awaitModalSubmit({
        filter: i => i.customId === `auto_reject_reason_modal_${reqId}` && i.user.id === interaction.user.id,
        time: 120000,
      }).catch(() => null);
      if (!submit) return;
      const reason = submit.fields.getTextInputValue('reason').trim();
      await rejectRequest(interaction.client, savedMsg, reqId, 'purchase', reason);
      return submit.reply({ embeds: [quickEmbed(interaction.client, interaction.user, 'success', '**تم رفض طلب الشراء وإشعار المستخدم.**')], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (id.startsWith('auto_select_my_')) return showSubscription(interaction, interaction.values[0]);
    if (id.startsWith('auto_select_renew_')) return startRenewal(interaction, interaction.values[0]);
    if (id.startsWith('auto_select_pause_')) return togglePause(interaction, interaction.values[0]);
    if (id.startsWith('auto_select_links_all_')) return sendLinks(interaction, interaction.values[0], 'all');
  }

  if (interaction.isChannelSelectMenu()) {
    if (id === 'auto_panel_channel_select') return handlePanelChannelSelect(interaction);
  }
}

function installAutomaticHandlers(client) {
  if (installedClients.has(client)) return;
  installedClients.add(client);
  client.on('interactionCreate', interaction => {
    handleInteraction(interaction).catch(err => console.error('[automatic:interaction]', err));
  });
  client.on('messageCreate', message => {
    handleInvoiceDm(client, message).catch(err => console.error('[automatic:dm]', err));
  });
  setInterval(cleanupRequests, 10 * 60 * 1000).unref();
}

module.exports = {
  name: 'automatic',
  aliases: ['auto', 'autopurchase', 'اوتوماتيك', 'تلقائي', 'ظبط'],
  description: 'Automatic purchase panel',
  async execute(client, message) {
    if (!owners.includes(message.author.id)) return;
    installAutomaticHandlers(client);
    await refreshSavedPublicPanel(client).catch(() => {});

    try {
      const payload = {
        ...autoImagePayload(buildOwnerEmbed(client, message.author)),
        components: ownerRows(),
      };
      await message.channel.send(payload);
    } catch (error) {
      console.error(error);
      await message.reply('**Automatic**\nAn error occurred while running the command.\nحدث خطأ أثناء تنفيذ الأمر.');
    }
  },
  installAutomaticHandlers,
  automaticSettings,
};
