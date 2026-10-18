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

// Retry for "Player not found" (target offline) errors.
const RETRY_DELAY_MS = 3 * 60 * 1000; // jeda beberapa menit sebelum retry
const MAX_RETRIES = 5; // give up + DM owner setelah N error beruntun

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

/** Embed DM'd to the owner when a ban gives up after MAX_RETRIES "Player not found". */
function buildGaveUpEmbed(uin, entry, errorMsg, retryCount) {
  return new EmbedBuilder()
    .setColor(C_BAD)
    .setTitle('Ban Gave Up — ' + uin)
    .setDescription(
      'Stopped retrying the device ban for UID ' + uin + ' after **' + retryCount +
        '** consecutive "Player not found" errors.\nThe target is likely offline (the ban API needs them online to target the device).'
    )
    .addFields(
      { name: 'UID', value: String(uin), inline: true },
      { name: 'Player', value: (entry && entry.playerName) || 'Unknown', inline: true },
      { name: 'Requested by', value: (entry && entry.requestedByName) || 'Unknown', inline: true },
      { name: 'Last error', value: String(errorMsg).slice(0, 200), inline: false }
    )
    .setFooter({ text: 'Run !unbandev then !bandev to retry once they are online.' });
}

/**
 * Record one ban fire's result and schedule the next.
 *  - success                -> reset retries, normal repeat
 *  - "Player not found"     -> bounded retry (target offline); give up + DM after MAX_RETRIES
 *  - other error            -> keep normal repeat (transient)
 */
function recordFire(uin, errorMsg, okMsg) {
  const prev = bans.get(uin);
  if (!prev) return; // unbanned mid-flight
  const now = Date.now();
  const normalNext = now + (prev.repeat || bans.REPEAT_MS);

  if (!errorMsg) {
    bans.put(uin, { lastFiredAt: now, lastResult: 'OK: ' + (okMsg || 'Done'), retryCount: 0, fireCount: (prev.fireCount || 0) + 1, nextAt: normalNext });
    console.log('BANDEV repeat ' + uin);
    return;
  }

  if (!/player not found/i.test(errorMsg)) {
    // transient error — keep normal schedule
    bans.put(uin, { lastFiredAt: now, lastResult: 'ERR: ' + errorMsg, fireCount: (prev.fireCount || 0) + 1, nextAt: normalNext });
    console.log('BANDEV err ' + uin + ' ' + errorMsg);
    return;
  }

  // "Player not found" — target offline. Retry a few times.
  const retryCount = (prev.retryCount || 0) + 1;
  const fc = (prev.fireCount || 0) + 1;
  if (retryCount >= MAX_RETRIES) {
    bans.put(uin, { lastFiredAt: now, lastResult: 'ERR: ' + errorMsg, retryCount, fireCount: fc, gaveUp: true, repeat: null, nextAt: null });
    notifyOwner(client, { embeds: [buildGaveUpEmbed(uin, prev, errorMsg, retryCount)] });
    console.log('BANDEV gave up ' + uin + ' after ' + retryCount + ' retries: ' + errorMsg);
  } else {
    bans.put(uin, {
      lastFiredAt: now,
      lastResult: 'ERR: ' + errorMsg + ' — retry ' + retryCount + '/' + MAX_RETRIES,
      retryCount,
      fireCount: fc,
      nextAt: now + RETRY_DELAY_MS,
    });
    console.log('BANDEV retry ' + uin + ' (' + retryCount + '/' + MAX_RETRIES + ') in ' + Math.round(RETRY_DELAY_MS / 60000) + 'm');
  }
}

// --- !checkinfo helpers -----------------------------------------------------
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const GENDER = { 1: 'Male', 2: 'Female', 0: 'Hidden' };

/** Unix seconds -> Discord timestamp; 0/undefined -> "-". */
function dts(sec, style = 'f') {
  const n = Number(sec);
  if (!n) return '-';
  return '<t:' + Math.floor(n) + ':' + style + '>';
}

/** LastLoginIP datang sebagai angka32-bit unsigned -> dotted quad. */
function intToIp(n) {
  const x = Math.floor(Number(n) || 0) >>> 0;
  return [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');
}

/** Escape karakter markdown Discord (* _ ~ ` | >) biar nickname/mood aman. */
function esc(s) {
  return String(s == null ? '' : s).replace(/([*_`~|>\\])/g, '\\$1');
}

/** Nilai -> teks aman untuk embed. */
function v(val, dflt = '-') {
  if (val === undefined || val === null || val === '') return dflt;
  return esc(String(val));
}

/**
 * !checkinfo -> Embed. Data akun lengkap (account, avatar, device, facebook).
 * Kredensial (auth_pwd, DeviceToken, FB token) TIDAK pernah ditampilkan.
 */
function buildInfoEmbed(d) {
  if (d.error) return msgEmbed(C_BAD, 'Check Info Failed', d.error);

  const x = d.data;
  const prof = d.prof;
  const role = d.role;
  const extra = d.extra;
  const pRole = isObj(prof.RoleInfo) ? prof.RoleInfo : {};
  const nick = (role && role.NickName) || (pRole && pRole.NickName) || '-';

  const e = new EmbedBuilder()
    .setColor(C_INFO)
    .setTitle('Player Info — ' + esc(nick).slice(0, 180))
    .setDescription('**UID:** `' + d.uin + '`  •  **Level:** ' + v(x.level) + '  •  **Source:** ' + v(x.source))
    .addFields(
      { name: 'Account', value: [
        '**Nickname:** ' + v(nick),
        '**Created:** ' + dts(x.CreateTime),
        '**Last Login:** ' + dts(x.LastLoginTime),
        '**Login IP:** ' + intToIp(x.LastLoginIP),
        '**Email:** ' + v(x.Email),
        '**Phone:** ' + v(x.Phone, '(empty)'),
        '**Bind:** ' + v(x.bind_country) + ' • ' + dts(x.AccountBindTime),
      ].join('\n'), inline: false },
      { name: 'Profile', value: [
        '**Model / Skin:** ' + v(role && role.Model) + ' / ' + v(role && role.SkinID),
        '**Gender:** ' + v(GENDER[prof.gender] !== undefined ? GENDER[prof.gender] : prof.gender),
        '**Country / Lang:** ' + v(prof.country) + ' / ' + v(prof.lang),
        '**Show Country:** ' + v(prof.show_country !== undefined ? (prof.show_country ? 'Yes' : 'No') : '-'),
        '**Mood:** ' + v(prof.mood_icon, '') + ' ' + v(prof.mood_text),
        '**Map Downloads:** ' + v(prof.all_download_count),
        '**Profile Update:** ' + dts(prof._t_),
      ].join('\n'), inline: false },
      { name: 'Avatar', value: [
        '**Head ID:** ' + v(pRole.head_id) + '  •  **Frame:** ' + v(prof.head_frame_id),
        '**Has Avatar:** ' + v(pRole.HasAvatar !== undefined ? (pRole.HasAvatar ? 'Yes' : 'No') : '-'),
        '**Skin Parts:** ' + (Array.isArray(pRole.AvatarSkin) ? pRole.AvatarSkin.length : 0),
      ].join('\n'), inline: false },
      { name: 'Currency', value: [
        '**Mini Bean:** ' + v(x.minibean, '0'),
        '**Mini Coin:** ' + v(x.minicoin, '0'),
        '**Coin Total:** ' + v(x.MiniCoinTotal, '0'),
        '**Uin Flag:** ' + v(x.UinFlag),
      ].join('\n'), inline: true },
      { name: 'Status', value: [
        '**Developer:** ' + v(x.isdeveloper !== undefined ? (x.isdeveloper ? 'Yes' : 'No') : '-'),
        '**Frozen:** ' + v(x.isfreeze !== undefined ? (x.isfreeze ? 'Yes' : 'No') : '-'),
        '**ID Card Auth:** ' + v(x.idcard_authed !== undefined ? (x.idcard_authed ? 'Yes' : 'No') : '-'),
        '**Safe Verify:** ' + v(x.isloginsafeverify !== undefined ? (x.isloginsafeverify ? 'Yes' : 'No') : '-'),
      ].join('\n'), inline: true },
      { name: 'Device', value: [
        '**System:** ' + v(extra.DeviceSystem),
        '**Vendor:** ' + v(extra.DeviceVender),
        '**Model:** ' + v(extra.DeviceModel),
        '**Device ID:** ' + v(extra.DeviceID, '(empty)'),
        '**Country:** ' + v(extra.Country) + '  •  **Lang:** ' + v(extra.CltLang),
        '**API / Client:** ' + v(extra.CltApiID) + ' / ' + v(x.cltversion),
      ].join('\n'), inline: false }
    );

  // Facebook hanya kalau memang tertaut.
  const fb = isObj(extra.facebook) ? extra.facebook : null;
  if (fb) {
    e.addFields({
      name: 'Facebook',
      value: [
        '**FB ID:** ' + v(fb.id),
        '**Nickname:** ' + v(fb.nickname),
        '**Platform:** ' + v(fb.platform) + ' • src: ' + v(fb.src),
        '_Session token withheld for privacy._',
      ].join('\n'),
      inline: false,
    });
  }

  const pkg = Array.isArray(x.pkg) ? x.pkg : [];
  if (pkg.length) {
    e.addFields({ name: 'Packages (' + pkg.length + ')', value: pkg.map((s) => '`' + esc(s) + '`').join('\n').slice(0, 1000), inline: false });
  }

  // auth_pwd & DeviceToken adalah kredensial login — tidak pernah ditampilkan.
  if (x.auth_pwd || extra.DeviceToken) {
    e.setFooter({ text: 'Credentials (password/token) withheld for privacy.' });
  }

  if (d.avatar) e.setThumbnail(d.avatar);
  return e;
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
            '`!checkinfo <UID>` — Full account info: profile, avatar, device, currency, login.\n' +
            '`!checkinfo <UID>` — Full account info (level, device, login, coins).\n' +
            '`!debug` — Scheduler status.\n' +
            '`!help` — Show this message.\n\n' +
            '_A UID already on the list cannot be banned again._'
        )
      );
      return;
    }

    // ---- !checkinfo : full account info via the getinfo API (always an embed)
    if (cmd === 'checkinfo' || cmd === 'getinfo' || cmd === 'info') {
      const uin = args[0];
      if (!uin) {
        await respond(message, msgEmbed(C_BAD, 'Invalid Format', 'Usage: `!checkinfo <UID>`\nExample: `!checkinfo 1320454366`'));
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await respond(message, msgEmbed(C_BAD, 'Invalid UID', 'Use 8, 9, or 10 digits.'));
        return;
      }

      // Loading message — a NEW message, never a reply/mention.
      let statusMsg = null;
      try {
        statusMsg = await message.channel.send({ embeds: [msgEmbed(C_INFO, 'Fetching Info..', 'Loading account info for UID ' + uid + '...')] });
      } catch (err) {
        console.log('Status send failed: ' + (err && err.message));
      }
      const finish = async (embed) => {
        if (statusMsg) {
          try { await statusMsg.edit({ embeds: [embed] }); return; } catch (_) {}
        }
        await respond(message, embed);
      };

      const out = await api.fetchInfo(uid);
      if (out.error) return await finish(msgEmbed(C_BAD, 'Info Failed', out.error));

      const x = out.data || {};
      const prof = out.prof || {};
      const role = out.role || {};
      const extra = out.extra || {};

      // block-scoped display helpers
      const dash = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));
      const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : dash(v));
      const clip = (v, n) => { const s = dash(v).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
      const tshow = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? '<t:' + Math.round(n) + ':F>' : '-'; };
      const ip = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.') : '-'; };
      const devModel = (v) => {
        if (v == null || v === '') return '-';
        const s = String(v).trim();
        if (s === '[]' || s === '{}' || s === 'null') return '-';
        try {
          const j = JSON.parse(s);
          if (Array.isArray(j)) return j.length ? j.length + ' item(s)' : '-';
          if (j && typeof j === 'object') { const ks = Object.keys(j); return ks.length ? ks.map((k) => k + '=' + j[k]).join(', ') : '-'; }
        } catch (_) {}
        return s;
      };

      const nick = role.NickName != null && role.NickName !== '' ? role.NickName : prof.NickName;
      const country = [prof.country, extra.Country, x.bind_country].find((v) => v != null && v !== '') || '-';
      const GENDER = { 1: 'Male', 2: 'Female', 0: 'Hidden' };

      const F = (name, value, inline) => ({ name, value: clip(value, 1024), inline: inline !== false });
      const fields = [
        F('UID', '`' + dash(out.uin) + '`'),
        F('Nickname', nick),
        F('Country', country),
        F('Level', dash(x.level)),
        F('Gender', GENDER[prof.gender] || (prof.gender === 0 ? 'Hidden' : '-')),
        F('Minicoin', dash(x.minicoin)),
        F('Beans', dash(x.minibean)),
        F('Lifetime Coins', dash(x.MiniCoinTotal)),
        F('Created', tshow(x.CreateTime)),
        F('Last Login', tshow(x.LastLoginTime)),
        F('Login IP', ip(x.LastLoginIP)),
        F('Bind Time', tshow(x.AccountBindTime)),
        F('Bound To', x.bind && x.bind.uname ? x.bind.uname : '-'),
        F('Email', x.Email),
        F('Phone', x.Phone),
        F('Device System', extra.DeviceSystem),
        F('Device ID', extra.DeviceID),
        F('Device Vendor', extra.DeviceVender),
        F('Device Model', devModel(extra.DeviceModel)),
        F('Model / Skin', dash(role.Model) + ' / ' + dash(role.SkinID)),
        F('Head Frame', dash(prof.head_frame_id)),
        F('Map Downloads', dash(prof.all_download_count) + (prof.all_download_st ? ' (since ' + tshow(prof.all_download_st) + ')' : '')),
        F('Flags', 'Developer: ' + yn(x.isdeveloper) + '  •  Frozen: ' + yn(x.isfreeze) + '  •  ID Card: ' + yn(x.idcard_authed) + '  •  Safe Verify: ' + yn(x.isloginsafeverify) + (prof.creator && prof.creator.level ? '  •  Creator Lv' + prof.creator.level : ''), false),
      ];

      // Facebook link — nickname/id/platform only.
      // extra.facebook.authinfo.token and .sign are credentials: NEVER surfaced.
      const fb = extra.facebook && typeof extra.facebook === 'object' ? extra.facebook : {};
      fields.push(
        F('Facebook', (fb.nickname || fb.id)
          ? 'Name: ' + dash(fb.nickname) + '  •  ID: ' + dash(fb.id) + '  •  ' + dash(fb.platform)
          : 'Not linked', false)
      );

      // Mood + icon + language combined to stay within Discord's 25-field cap.
      const moodBits = [];
      if (prof.mood_icon) moodBits.push('Icon: ' + prof.mood_icon);
      if (prof.lang != null) moodBits.push('Lang: ' + prof.lang);
      if (prof.mood_text) moodBits.push(String(prof.mood_text));
      if (moodBits.length) fields.push(F('Mood', moodBits.join('\n'), false));

      const embed = new EmbedBuilder()
        .setColor(C_OK)
        .setTitle('Account Info — ' + uid)
        .addFields(fields)
        .setFooter({ text: 'GetInfo API' })
        .setTimestamp();
      // Discord rejects http:// embed images — upgrade to https for the thumbnail.
      if (out.avatar) embed.setThumbnail(String(out.avatar).replace(/^http:\/\//i, 'https://'));

      return await finish(embed);
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
        lastFiredAt: Date.now(),
        lastResult: 'OK: ' + (out.msg || 'Done'),
        fireCount: 1,
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

    // ---- !checkinfo : full account info via the getinfo API
    if (cmd === 'checkinfo' || cmd === 'getinfo') {
      const uin = args[0];
      if (!uin) {
        await respond(message, msgEmbed(C_BAD, 'Invalid Format', 'Usage: `!checkinfo <UID>`\nExample: `!checkinfo 1137790884`'));
        return;
      }
      const uid = api.fixUin(uin);
      if (!uid) {
        await respond(message, msgEmbed(C_BAD, 'Invalid UID', 'Use 8, 9, or 10 digits.'));
        return;
      }

      let statusMsg = null;
      try {
        statusMsg = await message.channel.send({ embeds: [msgEmbed(C_INFO, 'Fetching data..', 'Getting account info for UID ' + uid + '...')] });
      } catch (err) {
        console.log('Status send failed: ' + (err && err.message));
      }

      const out = await api.fetchInfo(uid);
      const embed = buildInfoEmbed(out);
      if (statusMsg) {
        try {
          await statusMsg.edit({ embeds: [embed] });
          return;
        } catch (_) {}
      }
      await respond(message, embed);
      return;
    }

    // ---- !debug : show scheduler state + full ban details (read-only)
    if (cmd === 'debug') {
      const now = Date.now();
      const entries = bans.all();
      const fmtTs = (ms) => (ms ? '<t:' + Math.round(ms / 1000) + ':f>' : '-');
      const schedLines = entries.length
        ? entries.map((e) => {
            const nextIn = e.gaveUp ? 'stopped — gave up' : (e.nextAt ? Math.round((e.nextAt - now) / 1000) + 's' : '-');
            const untilIn = e.until ? Math.round((e.until - now) / 1000) + 's' : 'one-time';
            const lastFired = e.lastFiredAt ? '<t:' + Math.round(e.lastFiredAt / 1000) + ':R>' : 'never';
            const fires = e.fireCount || 0;
            const retry = e.gaveUp
              ? ' ⚠️ **GAVE UP** after ' + (e.retryCount || 0) + ' retries'
              : (e.retryCount ? ' _(retry ' + e.retryCount + '/' + MAX_RETRIES + ')_' : '');
            const result = e.lastResult ? String(e.lastResult).slice(0, 120) : 'n/a (not yet re-fired)';
            return (
              '**UID:** `' + e.uin + '` | **Player:** ' + (e.playerName || 'Unknown') + retry + '\n' +
              '**Banned by:** ' + (e.requestedByName || 'Unknown') + ' | **Banned at:** ' + fmtTs(e.bannedAt) + '\n' +
              '**Fires:** ' + fires + ' | **Last fired:** ' + lastFired + '\n' +
              '**Last result:** ' + result + '\n' +
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
      // Safety bump so a slow call can't double-fire; recordFire() below
      // overrides this with the correct next schedule (normal / retry / give-up).
      bans.put(e.uin, { nextAt: now + (e.repeat || bans.REPEAT_MS) });
      api.fetchBanDev(e.uin)
        .then((r) => recordFire(e.uin, r.error || null, r.msg))
        .catch((err) => recordFire(e.uin, (err && err.message ? err.message : String(err)), null));
    }
  } catch (err) {
    console.error('scheduler error:', err);
  }
}, 60000);

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err && err.message);
  process.exit(1);
});
