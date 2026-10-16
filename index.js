'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require('discord.js');

const api = require('./lib/api');
const bans = require('./lib/bans');

const PREFIX = '!';
// Owner who gets a DM notification (with details) on every !bandev use.
const OWNER_ID = String(process.env.OWNER_ID || '1286240448775720962');

// Colors
const C_INFO = 0x3498db;
const C_OK = 0x2ecc71;
const C_BAD = 0xe74c3c;
const C_ALERT = 0xe67e22;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

function msgEmbed(color, title, desc) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title);
  if (desc) e.setDescription(desc);
  return e;
}

/**
 * Send an embed as a NEW message in the channel.
 * Never uses message.reply() — that would Mention/Reference the command author.
 */
async function respond(message, embed) {
  try {
    await message.channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    console.log('Send failed: ' + (err && err.message));
    return false;
  }
}

/**
 * DM the owner a notification that someone used !bandev, with full details.
 * Best-effort — if DMs are closed, just log it.
 */
async function notifyOwner(clientRef, payload) {
  try {
    const owner = await clientRef.users.fetch(OWNER_ID);
    await owner.send(payload);
    return true;
  } catch (err) {
    console.log('Owner DM failed: ' + (err && err.message));
    return false;
  }
}

client.once('clientReady', (c) => {
  console.log('Logged in as ' + c.user.tag + ' | immediate exec + local 3-min repeat');
});

// ---------------------------------------------------------------------------
// Command handling (all embeds; bot sends NEW messages, never reply/mention)
// ---------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    const content = (message.content || '').trim();
    if (!content.startsWith(PREFIX)) return;
    const parts = content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const args = parts;

    if (cmd === 'help') {
      await respond(
        message,
        msgEmbed(
          C_INFO,
          'Bandev Bot — Commands',
          '`!bandev <UID> [duration]` — Ban a UID. Duration: `1day`, `5m`, `2hours`. Repeats every 2 min until it ends.\n' +
            '`!unbandev <UID>` — Remove a UID from the bandev list. Only the original requester (or the owner) can unban.\n' +
            '`!bandevlist` — List active bans with player, requester, and ban time.\n' +
            '`!debug` — Scheduler status.\n' +
            '`!help` — Show this message.\n\n' +
            '_A UID already on the list cannot be banned again._'
        )
      );
      return;
    }

    // ---- !bandev : public, fires immediately + schedules 3-min repeats
    if (cmd === 'bandev') {
      const uin = args[0];
      if (!uin) {
        await respond(message, msgEmbed(C_BAD, 'Invalid Format', 'Usage: `!bandev <UID> [duration]`\nExample: `!bandev 1000 1day`'));
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await respond(message, msgEmbed(C_BAD, 'Invalid UID', 'Use 8, 9, or 10 digits.'));
        return;
      }

      // Protection: a UID already on the bandev list cannot be banned again.
      if (bans.get(uid)) {
        await respond(message, msgEmbed(C_BAD, 'Already Banned', 'This UID is already on the bandev list and cannot be banned again.'));
        return;
      }

      let durationMs = null;
      if (args[1]) {
        durationMs = api.parseDur(args[1]);
        if (!durationMs) {
          await respond(message, msgEmbed(C_BAD, 'Unknown Duration', 'Could not read `' + args[1] + '`.\nUse `5m`, `1hour`, `1day`, `2days`.'));
          return;
        }
      }

      // 1) Send a plain "Request Ban.." status message (a NEW message, not a reply).
      let statusMsg = null;
      try {
        statusMsg = await message.channel.send({ embeds: [msgEmbed(C_INFO, 'Request Ban..', 'Sending ban request for UID ' + uid + '...')] });
      } catch (err) {
        console.log('Status send failed: ' + (err && err.message));
      }

      // 2) Fire the FIRST request immediately.
      const out = await api.fetchBanDev(uid);
      if (out.error) {
        if (statusMsg) {
          try { await statusMsg.edit({ embeds: [msgEmbed(C_BAD, 'Ban Failed', out.error)] }); return; } catch (_) {}
        }
        await respond(message, msgEmbed(C_BAD, 'Ban Failed', out.error));
        return;
      }

      // Player name is nice-to-have for the record + notification (fetched AFTER the fire).
      const playerName = await api.fetchPlayerName(uid);

      // 3) Record on the list (with requester + timestamp) so duplicates are blocked
      //    and !unbandev knows who to allow. Duration bans also schedule repeats.
      bans.put(uid, {
        playerName: playerName || 'Unknown',
        requestedBy: message.author.id,
        requestedByName: message.author.tag,
        bannedAt: Date.now(),
        until: durationMs ? Date.now() + durationMs : null,
        repeat: durationMs ? bans.REPEAT_MS : null,
        nextAt: durationMs ? Date.now() + bans.REPEAT_MS : null,
        durationMs,
      });

      const durTxt = durationMs ? ' for ' + api.fmtDur(durationMs) + ' (repeats every 2 min)' : ' (one-time)';

      // Success embed — EDIT the "Request Ban.." message into it.
      const confirm = new EmbedBuilder()
        .setColor(C_OK)
        .setTitle('Ban Sent')
        .setDescription('Ban request sent for UID ' + uid + durTxt + '.')
        .addFields(
          { name: 'UID', value: String(uid), inline: true },
          { name: 'Duration', value: durationMs ? api.fmtDur(durationMs) : 'One-time', inline: true },
          { name: 'Player', value: playerName || 'Unknown', inline: true },
          { name: 'Requested by', value: message.author.tag, inline: true }
        );
      if (statusMsg) {
        try { await statusMsg.edit({ embeds: [confirm] }); } catch (_) { await respond(message, confirm); }
      } else {
        await respond(message, confirm);
      }

      // DM the owner with full details of who ran it + what got banned.
      const notif = new EmbedBuilder()
        .setColor(C_ALERT)
        .setTitle('!bandev Used')
        .setDescription('<@' + message.author.id + '> just used `!bandev`.')
        .addFields(
          { name: 'Requested by', value: '<@' + message.author.id + '> (' + message.author.id + ')', inline: false },
          { name: 'Target UID', value: String(uid), inline: true },
          { name: 'Player banned', value: playerName || 'Unknown', inline: true },
          { name: 'Duration', value: durationMs ? api.fmtDur(durationMs) : 'One-time', inline: true }
        )
        .setFooter({ text: 'Server: ' + (message.guild ? message.guild.name : 'DM') });
      await notifyOwner(client, { embeds: [notif] });
      return;
    }

    // ---- !unbandev : only the original requester (or the owner) may unban
    if (cmd === 'unbandev' || cmd === 'unban') {
      const uin = args[0];
      if (!uin) {
        await respond(message, msgEmbed(C_BAD, 'Invalid Format', 'Usage: `!unbandev <UID>`'));
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await respond(message, msgEmbed(C_BAD, 'Invalid UID', 'Use 8, 9, or 10 digits.'));
        return;
      }
      const entry = bans.get(uid);
      if (!entry) {
        await respond(message, msgEmbed(C_BAD, 'No Active Ban', 'No active ban for UID ' + uid + '.'));
        return;
      }
      const isOwner = message.author.id === OWNER_ID;
      const isRequester = entry.requestedBy && entry.requestedBy === message.author.id;
      if (!isOwner && !isRequester) {
        await respond(
          message,
          msgEmbed(
            C_BAD,
            'Not Allowed',
            'Only the user who requested this ban can unban UID ' + uid + '.\n' +
              'Banned by: ' + (entry.requestedByName || 'Unknown') +
              (isOwner ? '' : '\nOwner can override with `!unbandev`.')
          )
        );
        return;
      }
      bans.remove(uid);
      await respond(message, msgEmbed(C_OK, 'Ban Stopped', 'Repeat stopped for UID ' + uid + '. Removed from the active list.'));
      return;
    }

    // ---- !bandevlist : public, lists active bans with full details
    if (cmd === 'bandevlist') {
      const entries = bans.all();
      if (!entries.length) {
        await respond(message, msgEmbed(C_INFO, 'Active Bans', 'Ban list is empty.'));
        return;
      }
      const fmtTs = (ms) => (ms ? '<t:' + Math.round(ms / 1000) + ':f>' : '-');
      const lines = entries.map(
        (e) =>
          '**UID:** `' + e.uin + '`\n' +
          '**Player:** ' + (e.playerName || 'Unknown') + '\n' +
          '**Banned by:** ' + (e.requestedByName || 'Unknown') + '\n' +
          '**Banned at:** ' + fmtTs(e.bannedAt) +
          (e.until ? '\n**Ends:** <t:' + Math.round(e.until / 1000) + ':R>' : '')
      );
      await respond(message, msgEmbed(C_INFO, 'Active Bans (' + entries.length + ')', lines.join('\n\n')));
      return;
    }

    // ---- !debug : show scheduler state + full ban details (read-only)
    if (cmd === 'debug') {
      const now = Date.now();
      const entries = bans.all();
      const fmtTs = (ms) => (ms ? '<t:' + Math.round(ms / 1000) + ':f>' : '-');
      const schedLines = entries.length
        ? entries.map((e) => {
            const nextIn = e.nextAt ? Math.round((e.nextAt - now) / 1000) + 's' : '-';
            const untilIn = e.until ? Math.round((e.until - now) / 1000) + 's' : 'one-time';
            return (
              '**UID:** `' + e.uin + '` | **Player:** ' + (e.playerName || 'Unknown') + '\n' +
              '**Banned by:** ' + (e.requestedByName || 'Unknown') + ' | **Banned at:** ' + fmtTs(e.bannedAt) + '\n' +
              '_next fire in ' + nextIn + ', ends in ' + untilIn + '_'
            );
          })
        : ['(no active schedules)'];
      const uptimeSec = Math.round(process.uptime());
      await respond(
        message,
        msgEmbed(
          C_INFO,
          'Scheduler Debug',
          '**Process uptime:** ' + uptimeSec + 's\n' +
            '**Scheduler tick:** every 60s | **Repeat:** every ' + Math.round(bans.REPEAT_MS / 60000) + 'min\n' +
            '**Active schedules (' + entries.length + '):**\n' + schedLines.join('\n\n')
        )
      );
      return;
    }
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ---------------------------------------------------------------------------
// Local scheduler — fires due bans every minute (silent), repeats every 2 min
// until `until`, then expires. Each call hits the single-fire backend.
// ---------------------------------------------------------------------------
setInterval(() => {
  try {
    const now = Date.now();
    for (const e of bans.due(now)) {
      if (e.until && e.until <= now) {
        bans.remove(e.uin);
        continue;
      }
      api.fetchBanDev(e.uin)
        .then((r) => console.log(r.error ? 'BANDEV err ' + e.uin + ' ' + r.error : 'BANDEV repeat ' + e.uin))
        .catch((err) => console.log('BANDEV err ' + e.uin, err && err.message));
      bans.put(e.uin, { nextAt: now + (e.repeat || bans.REPEAT_MS) });
    }
  } catch (err) {
    console.error('scheduler error:', err);
  }
}, 60000);

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err && err.message);
  process.exit(1);
});
