const file = require('./settings/config.json');
const cfg = {
    Token:        process.env.Token        || file.Token        || '',
    prefix:       process.env.PREFIX       || file.prefix       || '!',
    Colors:       process.env.COLORS       || file.Colors       || '#7d8b7f',
    logChannelId: process.env.LOG_CHANNEL  || file.logChannelId || '',
    owners:       process.env.OWNERS
                    ? process.env.OWNERS.split(',').map(s => s.trim())
                    : file.owners          || [],
    statuses:     process.env.STATUSES
                    ? process.env.STATUSES.split(',').map(s => s.trim())
                    : file.statuses        || [],
    Botsname:     process.env.BOTSNAME
                    ? process.env.BOTSNAME.split(',').map(s => s.trim())
                    : file.Botsname        || [],
    TwitchUrl:    process.env.TWITCH_URL
                    ? process.env.TWITCH_URL.split(',').map(s => s.trim())
                    : file.TwitchUrl       || [],
    Email:        process.env.EMAIL        || file.Email        || '',
    mode:         process.env.MODE         || file.mode         || 'live',
    client_id:    process.env.CLIENT_ID    || file.client_id    || '',
    client_secret:process.env.CLIENT_SECRET|| file.client_secret|| '',
    emco:         process.env.EMCO         || file.emco         || '',
    Services:     process.env.SERVICES     || file.Services     || '',
    price:        process.env.PRICE        || file.price        || '',
};

module.exports = cfg;
