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

function durLabel(ms) {
  if (!ms) return 'One-time';
  return api.fmtDur(ms) + ' (repeats every 5 min)';
}

function reqEmbed(r, state) {
  const e = new EmbedBuilder();
  if (state === 'approved') {
    e.setTitle('Ban Approved').setColor(C_OK);
  } else if (state === 'denied') {
    e.setTitle('Ban Denied').setColor(C_BAD);
  } else {
    e.setTitle('New Ban Request').setColor(C_PENDING);
    e.setDescription('A ban request needs your approval.');
  }
  e.addFields(
    { name: 'Requested by', value: '<@' + r.requesterId + '> (' + r.requesterId + ')', inline: false },
    { name: 'UID', value: String(r.uid), inline: true },
    { name: 'Player', value: r.playerName || 'Unknown', inline: true },
    { name: 'Duration', value: durLabel(r.durationMs), inline: true }
  );
  if (state === 'approved') e.addFields({ name: 'Status', value: 'Ban is now active.' });
  if (state === 'denied') e.addFields({ name: 'Status', value: 'Request rejected. No ban was applied.' });
  if (state === 'pending') e.setFooter({ text: 'Click Approve or Deny below.' });
  return e;
}

function buttons(reqId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ban_approve:' + reqId).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ban_deny:' + reqId).setLabel('Deny').setStyle(ButtonStyle.Danger)
  );
}

/** Best-effort edit of the channel confirmation message. */
async function editChannelMsg(r, content) {
  try {
    if (!r.channelId || !r.channelMsgId) return;
    const ch = await client.channels.fetch(r.channelId);
    const msg = await ch.messages.fetch(r.channelMsgId);
    await msg.edit({ content });
  } catch (_) {}
}

/** Execute an approved ban (single fire, or schedule if duration). */
async function executeBan(r) {
  // Duration ban.
  if (r.durationMs) {
    if (api.LOOP_ENABLED) {
      // Repeat lives in Cloudflare KV + Cron (survives restarts).
      return await api.fetchBanDevLoop(r.uid, Math.round(r.durationMs / 1000));
    }
    // Fallback: fire once now + schedule locally (lost on redeploy).
    const out = await api.fetchBanDev(r.uid);
    if (out.error) return out;
    bans.put(r.uid, {
      name: r.playerName || null,
      until: Date.now() + r.durationMs,
      repeat: bans.REPEAT_MS,
      nextAt: Date.now() + bans.REPEAT_MS,
      durationMs: r.durationMs,
    });
    return out;
  }
  // One-time ban.
  return await api.fetchBanDev(r.uid);
}

client.once('clientReady', (c) => {
  console.log('Logged in as ' + c.user.tag + ' | loop=' + (api.LOOP_ENABLED ? 'cloudflare' : 'local-fallback'));
});

// ---------------------------------------------------------------------------
// Command handling
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
      await message.reply(
        '**Available commands**\n' +
          '`!bandev <UID> [duration]` — Request a ban (needs admin approval). Duration example: `1day`, `5m`, `2hours`.\n' +
          '`!unban <UID>` — Stop an active ban.\n' +
          '`!bandevlist` — List active bans.\n' +
          '`!help` — Show this message.'
      );
      return;
    }

    // ---- !bandev : public, creates a PENDING request (never executes directly)
    if (cmd === 'bandev') {
      const uin = args[0];
      if (!uin) {
        await message.reply('Format: `!bandev <UID> [duration]`\nExample: `!bandev 1000 1day`');
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await message.reply('Invalid UID. Use 8/9/10 digits.');
        return;
      }

      let durationMs = null;
      if (args[1]) {
        durationMs = api.parseDur(args[1]);
        if (!durationMs) {
          await message.reply('Unknown duration: `' + args[1] + '`.\nUse `5m`, `1hour`, `1day`, `2days`.');
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

      // Ask admin for approval via DM.
      let dmOk = true;
      try {
        const admin = await client.users.fetch(ADMIN_ID);
        const dm = await admin.send({ embeds: [reqEmbed(req, 'pending')], components: [buttons(req.id)] });
        store.update(req.id, { dmChannelId: dm.channel.id, dmMsgId: dm.id });
      } catch (err) {
        dmOk = false;
        console.error('DM to admin failed:', err && err.message);
      }

      // Confirm in the channel + remember the message so we can edit it later.
      const durTxt = durationMs ? ' (' + api.fmtDur(durationMs) + ')' : ' (one-time)';
      const reply = await message.reply({
        content: dmOk
          ? '⏳ Ban request for UID ' + uid + durTxt + ' submitted — waiting for admin approval.'
          : '⚠️ Ban request for UID ' + uid + durTxt + ' recorded, but I could not DM the admin. They must allow DMs from server members.',
        fetchReply: true,
      });
      if (reply) store.update(req.id, { channelMsgId: reply.id });
      return;
    }

    // ---- !unban : public, stops a ban
    if (cmd === 'unban') {
      const uin = args[0];
      if (!uin) {
        await message.reply('Format: `!unban <UID>`');
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await message.reply('Invalid UID. Use 8/9/10 digits.');
        return;
      }
      if (api.LOOP_ENABLED) {
        const out = await api.unbanBanDev(uid);
        if (out.error) {
          await message.reply('❌ ' + out.error);
          return;
        }
        await message.reply('✅ Ban stopped for UID ' + uid + '. Removed from the active list.');
        return;
      }
      if (!bans.get(uid)) {
        await message.reply('❌ No active ban for UID ' + uid + '.');
        return;
      }
      bans.remove(uid);
      await message.reply('✅ Ban stopped for UID ' + uid + '. Removed from the active list.');
      return;
    }

    // ---- !bandevlist : public, lists active bans
    if (cmd === 'bandevlist') {
      if (api.LOOP_ENABLED) {
        const r = await api.listBanDev();
        if (r.error) {
          await message.reply('❌ ' + r.error);
          return;
        }
        if (!r.entries.length) {
          await message.reply('Ban list is empty.');
          return;
        }
        const lines = r.entries.map((e) => '• `' + e.uid + '` — until <t:' + Math.round(e.until / 1000) + ':R>');
        await message.reply('**Active bans** (' + r.entries.length + ')\n' + lines.join('\n'));
        return;
      }
      const entries = bans.all();
      if (!entries.length) {
        await message.reply('Ban list is empty.');
        return;
      }
      const lines = entries.map((e) => '• `' + e.uin + '` — until <t:' + Math.round(e.until / 1000) + ':R>');
      await message.reply('**Active bans** (' + entries.length + ')\n' + lines.join('\n'));
      return;
    }
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ---------------------------------------------------------------------------
// Approve / Deny buttons (only the admin can decide)
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const [action, reqId] = String(interaction.customId).split(':');
    if (action !== 'ban_approve' && action !== 'ban_deny') return;

    // Only the admin may approve/deny.
    if (interaction.user.id !== ADMIN_ID) {
      await interaction.reply({ content: '⛔ Only the admin can approve or deny ban requests.', ephemeral: true });
      return;
    }

    const req = store.get(reqId);
    if (!req) {
      await interaction.reply({ content: 'This request no longer exists.', ephemeral: true });
      return;
    }
    if (req.status !== 'pending') {
      await interaction.reply({ content: 'This request was already ' + req.status + '.', ephemeral: true });
      return;
    }

    const approve = action === 'ban_approve';

    if (!approve) {
      store.update(reqId, { status: 'denied', decidedAt: Date.now() });
      // Update DM embed, drop buttons.
      try {
        await interaction.update({ embeds: [reqEmbed(req, 'denied')], components: [] });
      } catch (_) {}
      await editChannelMsg(req, '❌ Ban request for UID ' + req.uid + ' was denied by the admin.');
      return;
    }

    // Execute the ban.
    await interaction.deferReply({ ephemeral: true });
    const out = await executeBan(req);
    if (out.error) {
      store.update(reqId, { status: 'approved', decidedAt: Date.now(), error: out.error });
      await interaction.editReply({ content: 'Approved, but the ban call failed: ' + out.error });
      try {
        const dmCh = await client.channels.fetch(req.dmChannelId);
        const dmMsg = await dmCh.messages.fetch(req.dmMsgId);
        await dmMsg.edit({ embeds: [reqEmbed(req, 'approved')], components: [] });
      } catch (_) {}
      await editChannelMsg(req, '⚠️ Ban request for UID ' + req.uid + ' approved, but the API call failed: ' + out.error);
      return;
    }

    store.update(reqId, { status: 'approved', decidedAt: Date.now() });
    await interaction.editReply({ content: '✅ Ban executed for UID ' + req.uid + '.' });
    // Update the DM embed, remove buttons.
    try {
      const dmCh = await client.channels.fetch(req.dmChannelId);
      const dmMsg = await dmCh.messages.fetch(req.dmMsgId);
      await dmMsg.edit({ embeds: [reqEmbed(req, 'approved')], components: [] });
    } catch (_) {}
    const durTxt = req.durationMs ? ' (' + api.fmtDur(req.durationMs) + ')' : ' (one-time)';
    await editChannelMsg(req, '✅ Ban request for UID ' + req.uid + durTxt + ' approved — ban is now active.');
  } catch (err) {
    console.error('interactionCreate error:', err);
  }
});

// ---------------------------------------------------------------------------
// Local scheduler (only used when Cloudflare loop is NOT configured).
// Fires due bans every minute; silent (no channel spam); expires on `until`.
// ---------------------------------------------------------------------------
if (!api.LOOP_ENABLED) {
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
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err && err.message);
  process.exit(1);
});
