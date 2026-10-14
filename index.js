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

// Colors
const C_INFO = 0x3498db;
const C_OK = 0x2ecc71;
const C_BAD = 0xe74c3c;

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
 * Reply WITHOUT posting publicly in the channel.
 * In a server -> DM the requester. In a DM -> reply directly (already private).
 * If DMs are closed, we just log it — never fall back to a public reply.
 */
async function respond(message, embed) {
  try {
    if (message.guild) {
      await message.author.send({ embeds: [embed] });
    } else {
      await message.reply({ embeds: [embed] });
    }
    return true;
  } catch (err) {
    console.log('DM failed for ' + message.author.id + ': ' + (err && err.message));
    return false;
  }
}

client.once('clientReady', (c) => {
  console.log('Logged in as ' + c.user.tag + ' | immediate exec + local 5-min repeat');
});

// ---------------------------------------------------------------------------
// Command handling (all embeds, replies go to DM — never public)
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
          '`!bandev <UID> [duration]` — Ban a UID. Duration: `1day`, `5m`, `2hours`. Repeats every 5 min until it ends.\n' +
            '`!unban <UID>` — Stop an active ban.\n' +
            '`!bandevlist` — List active bans.\n' +
            '`!debug` — Scheduler status.\n' +
            '`!help` — Show this message.\n\n' +
            '_Replies are sent via DM — nothing is posted in the channel._'
        )
      );
      return;
    }

    // ---- !bandev : public, fires immediately + schedules 5-min repeats
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

      let durationMs = null;
      if (args[1]) {
        durationMs = api.parseDur(args[1]);
        if (!durationMs) {
          await respond(message, msgEmbed(C_BAD, 'Unknown Duration', 'Could not read `' + args[1] + '`.\nUse `5m`, `1hour`, `1day`, `2days`.'));
          return;
        }
      }

      // 1) Fire the FIRST request immediately.
      const out = await api.fetchBanDev(uid);
      if (out.error) {
        await respond(message, msgEmbed(C_BAD, 'Ban Failed', out.error));
        return;
      }

      // 2) If a duration is set, schedule local repeats every 5 min until it ends.
      if (durationMs) {
        bans.put(uid, {
          until: Date.now() + durationMs,
          repeat: bans.REPEAT_MS,
          nextAt: Date.now() + bans.REPEAT_MS,
          durationMs,
        });
      }

      // Player name is nice-to-have for the DM (fetched AFTER the fire).
      const playerName = await api.fetchPlayerName(uid);
      const durTxt = durationMs ? ' for ' + api.fmtDur(durationMs) + ' (repeats every 5 min)' : ' (one-time)';

      const embed = new EmbedBuilder()
        .setColor(C_OK)
        .setTitle('Ban Sent')
        .setDescription('Ban request sent for UID ' + uid + durTxt + '.')
        .addFields(
          { name: 'UID', value: String(uid), inline: true },
          { name: 'Duration', value: durationMs ? api.fmtDur(durationMs) : 'One-time', inline: true },
          { name: 'Player', value: playerName || 'Unknown', inline: true }
        );
      await respond(message, embed);
      return;
    }

    // ---- !unban : public, stops a ban
    if (cmd === 'unban') {
      const uin = args[0];
      if (!uin) {
        await respond(message, msgEmbed(C_BAD, 'Invalid Format', 'Usage: `!unban <UID>`'));
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await respond(message, msgEmbed(C_BAD, 'Invalid UID', 'Use 8, 9, or 10 digits.'));
        return;
      }
      if (!bans.get(uid)) {
        await respond(message, msgEmbed(C_BAD, 'No Active Ban', 'No active ban for UID ' + uid + '.'));
        return;
      }
      bans.remove(uid);
      await respond(message, msgEmbed(C_OK, 'Ban Stopped', 'Repeat stopped for UID ' + uid + '. Removed from the active list.'));
      return;
    }

    // ---- !bandevlist : public, lists active bans
    if (cmd === 'bandevlist') {
      const entries = bans.all();
      if (!entries.length) {
        await respond(message, msgEmbed(C_INFO, 'Active Bans', 'Ban list is empty.'));
        return;
      }
      const lines = entries.map((e) => '• `' + e.uin + '` — until <t:' + Math.round(e.until / 1000) + ':R>');
      await respond(message, msgEmbed(C_INFO, 'Active Bans (' + entries.length + ')', lines.join('\n')));
      return;
    }

    // ---- !debug : show scheduler state (read-only)
    if (cmd === 'debug') {
      const now = Date.now();
      const entries = bans.all();
      const schedLines = entries.length
        ? entries.map((e) => {
            const nextIn = e.nextAt ? Math.round((e.nextAt - now) / 1000) + 's' : '-';
            const untilIn = e.until ? Math.round((e.until - now) / 1000) + 's' : '-';
            return '• `' + e.uin + '` → next fire in ' + nextIn + ', ends in ' + untilIn;
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
            '**Active schedules (' + entries.length + '):**\n' + schedLines.join('\n')
        )
      );
      return;
    }
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ---------------------------------------------------------------------------
// Local scheduler — fires due bans every minute (silent), repeats every 5 min
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
