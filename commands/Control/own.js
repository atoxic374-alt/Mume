'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');

const ROOT_OWNER_ID = '636930315503534110';
const CONFIG_PATH = path.join(process.cwd(), 'settings', 'config.json');

function parseUserId(raw) {
  const value = String(raw || '').trim();
  const mention = value.match(/^<@!?(\d{15,20})>$/);
  if (mention) return mention[1];
  return /^\d{15,20}$/.test(value) ? value : null;
}

function currentOwners() {
  return [...new Set((config.owners || []).map(String).filter(Boolean))];
}

function writeOwners(nextOwners) {
  const next = [...new Set(nextOwners.map(String).filter(Boolean))];
  const data = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  data.owners = next;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  if (Array.isArray(config.owners)) {
    config.owners.splice(0, config.owners.length, ...next);
  } else {
    config.owners = next;
  }

  return next;
}

function listText(owners) {
  if (!owners.length) return '**Owners:**\n`لا يوجد`';
  return [
    `**Owners (${owners.length})**`,
    owners.map((id, index) => `**${index + 1}.** <@${id}> \`${id}\``).join('\n'),
  ].join('\n');
}

module.exports = {
  name: 'own',
  aliases: ['owners'],
  async execute(client, message, args) {
    const owners = currentOwners();
    const isRoot = message.author.id === ROOT_OWNER_ID;
    const isConfigOwner = owners.includes(message.author.id);
    const sub = String(args[0] || '').toLowerCase();

    if (sub === 'list') {
      if (!isRoot && !isConfigOwner) return;
      return message.reply({ content: listText(owners), allowedMentions: { parse: [] } });
    }

    if (!isRoot) return;

    const targetId = parseUserId(args[0]);
    if (!targetId) {
      return message.reply('**Usage:** `own <userId|@user>` أو `own list`');
    }
    if (targetId === ROOT_OWNER_ID) {
      const next = owners.includes(ROOT_OWNER_ID) ? owners : writeOwners([...owners, ROOT_OWNER_ID]);
      return message.reply({ content: `**Owner Protected:** <@${ROOT_OWNER_ID}>\n\n${listText(next)}`, allowedMentions: { parse: [] } });
    }

    const exists = owners.includes(targetId);
    const next = exists
      ? writeOwners(owners.filter(id => id !== targetId))
      : writeOwners([...owners, targetId]);

    return message.reply({
      content: exists
        ? `**Owner Removed:** <@${targetId}>\n\n${listText(next)}`
        : `**Owner Added:** <@${targetId}>\n\n${listText(next)}`,
      allowedMentions: { parse: [] },
    });
  },
};
