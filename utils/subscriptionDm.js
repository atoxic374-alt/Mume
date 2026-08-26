'use strict';

const { EmbedBuilder } = require('discord.js');
const { getEmbedColor } = require('./embedColor');

function asText(value, fallback = 'Not set | غير محدد') {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
}

function timestamp(value, style = 'F') {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return 'Not set | غير محدد';
    return `<t:${Math.floor(time / 1000)}:${style}>`;
}

function field(en, ar, value, inline = true) {
    return {
        name: `${en} | ${ar}`,
        value: asText(value),
        inline,
    };
}

function baseEmbed(client, title, description, thumbnailUrl = null) {
    const embed = new EmbedBuilder()
        .setColor(getEmbedColor(client))
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: 'Subscription Notice | اشعار الاشتراك' })
        .setTimestamp();
    const thumb = thumbnailUrl || client?.user?.displayAvatarURL?.({ dynamic: true, size: 256 });
    if (thumb) embed.setThumbnail(thumb);
    return embed;
}

function buildSubscriptionActivatedDm(client, data = {}) {
    return baseEmbed(
        client,
        'Subscription Activated | تم تفعيل الاشتراك',
        [
            'Your music subscription has been activated successfully.',
            'تم تفعيل اشتراك الموسيقى الخاص بك بنجاح.',
        ].join('\n')
    , data.thumbnailUrl).addFields(
        field('Subscription ID', 'رقم الاشتراك', `\`${data.code}\``),
        field('Bot Count', 'عدد البوتات', `\`${data.botCount}\``),
        field('Duration', 'المدة', `\`${data.duration}\``),
        field('Server ID', 'ايدي السيرفر', `\`${data.serverId}\``),
        field('Expires At', 'ينتهي في', `${timestamp(data.expiresAt, 'F')}\n${timestamp(data.expiresAt, 'R')}`, false),
    );
}

function buildSubscriptionTimeUpdatedDm(client, data = {}) {
    return baseEmbed(
        client,
        'Subscription Updated | تم تحديث الاشتراك',
        [
            'Time has been added to your music subscription.',
            'تمت إضافة وقت إلى اشتراك الموسيقى الخاص بك.',
        ].join('\n')
    , data.thumbnailUrl).addFields(
        field('Subscription ID', 'رقم الاشتراك', `\`${data.code}\``),
        field('Added Time', 'الوقت المضاف', `\`${data.addedTime}\``),
        field('Previous Expiry', 'الانتهاء السابق', timestamp(data.previousExpiry, 'F'), false),
        field('New Expiry', 'الانتهاء الجديد', `${timestamp(data.newExpiry, 'F')}\n${timestamp(data.newExpiry, 'R')}`, false),
    );
}

function buildSubscriptionBotsAddedDm(client, data = {}) {
    return baseEmbed(
        client,
        'Subscription Updated | تم تحديث الاشتراك',
        [
            'Bots have been added to your music subscription.',
            'تمت إضافة بوتات إلى اشتراك الموسيقى الخاص بك.',
        ].join('\n')
    , data.thumbnailUrl).addFields(
        field('Subscription ID', 'رقم الاشتراك', `\`${data.code}\``),
        field('Added Bots', 'البوتات المضافة', `\`${data.addedBots || 0}\``),
        field('Total Bots', 'اجمالي البوتات', `\`${data.totalBots || 0}\``),
    );
}

function buildSubscriptionRemovedDm(client, data = {}) {
    return baseEmbed(
        client,
        'Subscription Removed | تم الغاء الاشتراك',
        [
            'Your music subscription has been removed.',
            'تم الغاء اشتراك الموسيقى الخاص بك.',
        ].join('\n')
    , data.thumbnailUrl).addFields(
        field('Subscription ID', 'رقم الاشتراك', `\`${data.code}\``),
        field('Bot Count', 'عدد البوتات', `\`${data.botCount}\``),
        field('Server ID', 'ايدي السيرفر', data.serverId ? `\`${data.serverId}\`` : undefined),
    );
}

function buildOwnershipTransferredDm(client, data = {}) {
    return baseEmbed(
        client,
        'Ownership Transferred | تم نقل الملكية',
        [
            'The subscription ownership has been updated.',
            'تم تحديث ملكية الاشتراك.',
        ].join('\n')
    , data.thumbnailUrl).addFields(
        field('Old Owner', 'المالك السابق', data.oldOwnerId ? `<@${data.oldOwnerId}>` : undefined),
        field('New Owner', 'المالك الجديد', data.newOwnerId ? `<@${data.newOwnerId}>` : undefined),
        field('Subscriptions', 'الاشتراكات', Array.isArray(data.codes) ? data.codes.map(code => `\`${code}\``).join(', ') : undefined, false),
        field('Bot Count', 'عدد البوتات', `\`${data.botCount || 0}\``),
    );
}

function buildServerUpdatedDm(client, data = {}) {
    return baseEmbed(
        client,
        'Server Updated | تم تحديث السيرفر',
        [
            'The subscription server has been updated. Bot channels were reset for setup in the new server.',
            'تم تحديث سيرفر الاشتراك. تم تصفير رومات البوتات لتجهيزها في السيرفر الجديد.',
        ].join('\n')
    , data.thumbnailUrl).addFields(
        field('New Server ID', 'ايدي السيرفر الجديد', `\`${data.serverId}\``),
        field('Subscriptions', 'الاشتراكات', Array.isArray(data.codes) ? data.codes.map(code => `\`${code}\``).join(', ') : undefined, false),
        field('Moved Bots', 'عدد البوتات المنقولة', `\`${data.movedBots || 0}\``),
        field('Bot Links', 'روابط البوتات', data.linksSent ? 'Sent in DM | تم ارسالها في الخاص' : 'Not sent | لم يتم ارسالها', false),
    );
}

module.exports = {
    buildSubscriptionActivatedDm,
    buildSubscriptionTimeUpdatedDm,
    buildSubscriptionBotsAddedDm,
    buildSubscriptionRemovedDm,
    buildOwnershipTransferredDm,
    buildServerUpdatedDm,
};
