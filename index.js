'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const api = require('./lib/api');
const store = require('./lib/store');
const bans = require('./lib/bans');

const PREFIX = '!';
// Admin who must approve every ban request (receives the DM + buttons).
const ADMIN_ID = String(process.env.ADMIN_USER_ID || '1286240448775720962');

// Colors
const C_INFO = 0x3498db;
const C_PENDING = 0xf1c40f;
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

// ---------------------------------------------------------------------------
// Embed helpers — every bot message is an embed.
// ---------------------------------------------------------------------------
function msgEmbed(color, title, desc) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title);
  if (desc) e.setDescription(desc);
  return e;
}

function durLabel(ms) {
  if (!ms) return 'One-time';
  return api.fmtDur(ms) + ' (repeats every 5 min)';
}

/** The pending-approval DM embed (shown to the admin). */
function reqEmbed(r) {
  return new EmbedBuilder()
    .setTitle('New Ban Request')
    .setColor(C_PENDING)
    .setDescription('A ban request needs your approval. It stays here until you Approve or Deny.')
    .addFields(
      { name: 'Requested by', value: '<@' + r.requesterId + '> (' + r.requesterId + ')', inline: false },
      { name: 'UID', value: String(r.uid), inline: true },
      { name: 'Player', value: r.playerName || 'Unknown', inline: true },
      { name: 'Duration', value: durLabel(r.durationMs), inline: true }
    )
    .setFooter({ text: 'Click Approve or Deny below.' });
}

/**
 * Rebuild the decision embed from the ORIGINAL DM embed so nothing is lost
 * (player name, requester, etc.). Works even after a restart.
 */
function decidedEmbed(source, state) {
  let e;
  try {
    e = source ? EmbedBuilder.from(source) : new EmbedBuilder();
  } catch (_) {
    e = new EmbedBuilder();
  }
  if (state === 'approved') e.setTitle('Ban Approved').setColor(C_OK);
  else e.setTitle('Ban Denied').setColor(C_BAD);
  e.setFooter({ text: 'Request ' + state + '.' });
  return e;
}

/**
 * Button customId carries the execution data (uid, duration, requester, reqId)
 * so the request NEVER expires — approval still works after a restart even if
 * the local store file was wiped.
 */
function buttons(req) {
  const customId = ['ban', req.uid, req.durationMs || 0, req.requesterId || '', req.id].join(':');
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId + ':approve').setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(customId + ':deny').setLabel('Deny').setStyle(ButtonStyle.Danger)
  );
}

/** Parse a customId -> { action, uid, durationMs, requesterId, reqId } or null. */
function parseCustomId(raw) {
  // Format: ban:<uid>:<durationMs>:<requesterId>:<reqId>:<approve|deny>
  const p = String(raw || '').split(':');
  if (p[0] !== 'ban') return null;
  const action = p[5];
  if (action !== 'approve' && action !== 'deny') return null;
  return {
    action,
    uid: p[1],
    durationMs: parseInt(p[2], 10) || 0,
    requesterId: p[3] || null,
    reqId: p[4] || null,
  };
}

/** Best-effort edit of the channel confirmation message. */
async function editChannelMsg(r, embed) {
  try {
    if (!r || !r.channelId || !r.channelMsgId) return;
    const ch = await client.channels.fetch(r.channelId);
    const msg = await ch.messages.fetch(r.channelMsgId);
    await msg.edit({ embeds: [embed], components: [] });
  } catch (_) {}
}

/** Fire the ban once. If a duration is set, also schedule local 5-min repeats. */
async function executeBan(r) {
  const out = await api.fetchBanDev(r.uid);
  if (out.error) return out;
  if (r.durationMs) {
    // Local repeat: already fired once above; next fire in 5 min, then every
    // 5 min until `until`. Lives in-process + data/bans.json.
    bans.put(r.uid, {
      name: r.playerName || null,
      until: Date.now() + r.durationMs,
      repeat: bans.REPEAT_MS,
      nextAt: Date.now() + bans.REPEAT_MS,
      durationMs: r.durationMs,
    });
  }
  return out;
}

client.once('clientReady', (c) => {
  console.log('Logged in as ' + c.user.tag + ' | single-fire backend + local 5-min repeat');
});

// ---------------------------------------------------------------------------
// Command handling (every reply is an embed)
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
      await message.reply({
        embeds: [
          msgEmbed(
            C_INFO,
            'Bandev Bot — Commands',
            '`!bandev <UID> [duration]` — Request a ban (needs admin approval). Duration: `1day`, `5m`, `2hours`.\n' +
              '`!unban <UID>` — Stop an active ban.\n' +
              '`!bandevlist` — List active bans.\n' +
              '`!help` — Show this message.'
          ),
        ],
      });
      return;
    }

    // ---- !bandev : public, creates a PENDING request (never executes directly)
    if (cmd === 'bandev') {
      const uin = args[0];
      if (!uin) {
        await message.reply({
          embeds: [msgEmbed(C_BAD, 'Invalid Format', 'Usage: `!bandev <UID> [duration]`\nExample: `!bandev 1000 1day`')],
        });
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await message.reply({ embeds: [msgEmbed(C_BAD, 'Invalid UID', 'Use 8, 9, or 10 digits.')] });
        return;
      }

      let durationMs = null;
      if (args[1]) {
        durationMs = api.parseDur(args[1]);
        if (!durationMs) {
          await message.reply({
            embeds: [msgEmbed(C_BAD, 'Unknown Duration', 'Could not read `' + args[1] + '`.\nUse `5m`, `1hour`, `1day`, `2days`.')],
          });
          return;
        }
      }

      const playerName = await api.fetchPlayerName(uid);
      const req = store.create({
        requesterId: message.author.id,
        requesterTag: message.author.tag,
        channelId: message.channel.id,
        uid,
        playerName,
        durationMs,
      });

      // Ask admin for approval via DM. The request stays until they decide.
      let dmOk = true;
      try {
        const admin = await client.users.fetch(ADMIN_ID);
        const dm = await admin.send({ embeds: [reqEmbed(req)], components: [buttons(req)] });
        store.update(req.id, { dmChannelId: dm.channel.id, dmMsgId: dm.id });
      } catch (err) {
        dmOk = false;
        console.error('DM to admin failed:', err && err.message);
      }

      // Confirm in the channel (embed) + remember the message so we can edit it.
      const durTxt = durationMs ? ' (' + api.fmtDur(durationMs) + ')' : ' (one-time)';
      const pend = new EmbedBuilder()
        .setColor(dmOk ? C_PENDING : C_BAD)
        .setTitle(dmOk ? 'Ban Request Submitted' : 'Request Recorded (DM Failed)')
        .setDescription(
          dmOk
            ? 'Ban request for UID ' + uid + durTxt + ' is waiting for admin approval.'
            : 'Ban request for UID ' + uid + durTxt + ' was recorded, but I could not DM the admin. They must allow DMs from server members.'
        )
        .addFields(
          { name: 'UID', value: String(uid), inline: true },
          { name: 'Duration', value: durationMs ? api.fmtDur(durationMs) : 'One-time', inline: true },
          { name: 'Player', value: playerName || 'Unknown', inline: true }
        );

      const reply = await message.reply({ embeds: [pend], fetchReply: true });
      if (reply) store.update(req.id, { channelMsgId: reply.id });
      return;
    }

    // ---- !unban : public, stops a ban
    if (cmd === 'unban') {
      const uin = args[0];
      if (!uin) {
        await message.reply({ embeds: [msgEmbed(C_BAD, 'Invalid Format', 'Usage: `!unban <UID>`')] });
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await message.reply({ embeds: [msgEmbed(C_BAD, 'Invalid UID', 'Use 8, 9, or 10 digits.')] });
        return;
      }
      if (!bans.get(uid)) {
        await message.reply({ embeds: [msgEmbed(C_BAD, 'No Active Ban', 'No active ban for UID ' + uid + '.')] });
        return;
      }
      bans.remove(uid);
      await message.reply({ embeds: [msgEmbed(C_OK, 'Ban Stopped', 'Ban stopped for UID ' + uid + '. Removed from the active list.')] });
      return;
    }

    // ---- !bandevlist : public, lists active bans
    if (cmd === 'bandevlist') {
      const entries = bans.all();
      if (!entries.length) {
        await message.reply({ embeds: [msgEmbed(C_INFO, 'Active Bans', 'Ban list is empty.')] });
        return;
      }
      const lines = entries.map((e) => '• `' + e.uin + '` — until <t:' + Math.round(e.until / 1000) + ':R>');
      await message.reply({ embeds: [msgEmbed(C_INFO, 'Active Bans (' + entries.length + ')', lines.join('\n'))] });
      return;
    }
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ---------------------------------------------------------------------------
// Approve / Deny buttons (only the admin can decide).
// The request NEVER expires: execution data is read from the customId, so it
// still works after a restart even if the local store file was wiped.
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    const { action, uid, durationMs, requesterId, reqId } = parsed;

    // Only the admin may approve/deny.
    if (interaction.user.id !== ADMIN_ID) {
      await interaction.reply({
        embeds: [msgEmbed(C_BAD, 'Not Allowed', 'Only the admin can approve or deny ban requests.')],
        ephemeral: true,
      });
      return;
    }

    if (!uid) {
      await interaction.reply({
        embeds: [msgEmbed(C_BAD, 'Invalid Request', 'This request is malformed.')],
        ephemeral: true,
      });
      return;
    }

    const stored = reqId ? store.get(reqId) : null;
    if (stored && stored.status && stored.status !== 'pending') {
      await interaction.reply({
        embeds: [msgEmbed(C_INFO, 'Already Handled', 'This request was already ' + stored.status + '.')],
        ephemeral: true,
      });
      return;
    }

    const approve = action === 'approve';

    if (!approve) {
      if (stored) store.update(reqId, { status: 'denied', decidedAt: Date.now() });
      try {
        await interaction.update({ embeds: [decidedEmbed(interaction.message.embeds[0], 'denied')], components: [] });
      } catch (_) {}
      await editChannelMsg(stored, msgEmbed(C_BAD, 'Ban Denied', 'Ban request for UID ' + uid + ' was denied by the admin.'));
      return;
    }

    // Approve -> execute the ban.
    await interaction.deferReply({ ephemeral: true });
    const req = stored || { uid, durationMs, playerName: null, requesterId };
    const out = await executeBan(req);

    // Ephemeral result for the admin.
    try {
      await interaction.editReply({
        embeds: [
          out.error
            ? msgEmbed(C_BAD, 'Ban Failed', out.error)
            : msgEmbed(C_OK, 'Ban Executed', 'Ban executed for UID ' + uid + '.'),
        ],
      });
    } catch (_) {}

    // Update the DM embed (green) + drop the buttons.
    try {
      await interaction.message.edit({ embeds: [decidedEmbed(interaction.message.embeds[0], 'approved')], components: [] });
    } catch (_) {}

    if (stored) store.update(reqId, { status: 'approved', decidedAt: Date.now() });

    const durTxt = durationMs ? ' (' + api.fmtDur(durationMs) + ')' : ' (one-time)';
    await editChannelMsg(
      stored,
      out.error
        ? msgEmbed(C_BAD, 'Ban Failed', 'Ban request for UID ' + uid + ' approved, but the API call failed: ' + out.error)
        : msgEmbed(C_OK, 'Ban Approved', 'Ban request for UID ' + uid + durTxt + ' approved — ban is now active.')
    );
  } catch (err) {
    console.error('interactionCreate error:', err);
  }
});

// ---------------------------------------------------------------------------
// Local scheduler — fires due bans every minute (silent), repeats every 5 min
// until `until`, then expires. Single-fire backend handles each call.
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
