'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const api = require('./lib/api');
const bans = require('./lib/bans');

const PREFIX = '!';
// Owner who gets a DM notification (with details) on every !bandev use.
const OWNER_ID = String(process.env.OWNER_ID || '1286240448775720962');

// Retry for "Player not found" (target offline) errors.
const RETRY_DELAY_MS = 3 * 60 * 1000; // jeda beberapa menit sebelum retry
const MAX_RETRIES = 5; // give up this round after N consecutive errors
// After giving up, cool down this long, then restart a fresh retry cycle.
// The ban is NOT dropped — it keeps re-trying every 10 minutes until unbanned
// or its duration (`until`) expires.
const GAVE_UP_COOLDOWN_MS = 10 * 60 * 1000;

// Colors
const C_INFO = 0x3498db;
const C_OK = 0x2ecc71;
const C_BAD = 0xe74c3c;
const C_ALERT = 0xe67e22;

// !checkroom room lists (each is a worker returning {map_type, prinum, roomlist}).
// `label` is only the fallback title while a list has no rooms.
const ROOM_SOURCES = {
  bts: { url: 'https://miniworld-api.daxtercarl1202.workers.dev/', label: 'Back To School [2.0]' },
  city2: { url: 'https://zengincheckroom.daxterrantares.workers.dev/', label: 'City 2' },
};

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

/** Profile card embed from the baseinfo v1 payload. */
function profileEmbed(prof, uin) {
  const role = prof.RoleInfo || {};
  const nick = String(role.NickName || prof.NickName || '(unknown)');
  const e = msgEmbed(C_OK, nick, 'Profile for UID `' + uin + '`');

  const gender =
    prof.gender === 1 ? 'Male' : prof.gender === 2 ? 'Female' : 'Not set';
  const num = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));

  e.addFields(
    { name: 'UID', value: '`' + uin + '`', inline: true },
    { name: 'Country', value: num(prof.country), inline: true },
    { name: 'Gender', value: gender, inline: true },
    { name: 'Popularity', value: num(prof.popularity), inline: true },
    { name: 'Downloads', value: num(prof.all_download_count), inline: true },
    { name: 'Head Frame', value: num(prof.head_frame_id), inline: true }
  );

  if (prof.mood_text && String(prof.mood_text).trim()) {
    e.addFields({ name: 'Mood', value: String(prof.mood_text).slice(0, 1000) });
  }

  if (prof.header2 && prof.header2.url) e.setThumbnail(prof.header2.url);
  return e;
}

/**
 * Blue "View Details" button shown under a profile card. The UID rides in the
 * custom id, so the persistent handler can resolve it without server state.
 */
function detailsButton(uin) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('checkroom_details:' + uin)
      .setLabel('View Details')
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * The full GetInfo card for a fetchInfo() result — the exact card !checkinfo
 * posts, shared by the command and by the "View Details" button so the two can
 * never drift apart.
 *
 * Async because it resolves the IP location and prefetches the Mapbox image
 * first, letting the map ride inside the embed instead of loading late.
 * Resolves { embed, files }.
 */
async function buildCheckinfoEmbed(out) {
  if (!out || out.error) {
    return { embed: msgEmbed(C_BAD, 'Info Failed', (out && out.error) || 'No data.'), files: [] };
  }

  const x = out.data || {};
  const prof = out.prof || {};
  const role = out.role || {};
  const extra = out.extra || {};

  const V = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));
  const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : V(v));
  const tsec = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return '-'; return new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' '); };
  const clipT = (v, n) => { const s = V(v).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const flagOf = (cc) => { const c = String(cc || '').trim().toUpperCase(); return c.length === 2 ? String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : ''; };
  const div = '──────────────────────';
  // extra.DeviceModel is a JSON string ({"Model":"ELP-NX9","RamTotal":...})
  // or "[]" on PC clients -> pull out just the model name.
  const devModel = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s || s === '[]' || s === '{}' || s === 'null') return '-';
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return '-';
      if (j && typeof j === 'object') return j.Model != null && j.Model !== '' ? String(j.Model) : '-';
    } catch (_) {}
    return s;
  };
  // Download an image as a Buffer so it can be attached to a message.
  const fetchBuf = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'MiniWorldDiscordBot/1.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); };

  const nick = role.NickName != null && role.NickName !== '' ? role.NickName : prof.NickName;
  const cc = prof.country || extra.Country || x.bind_country || '';
  const GENDER = { 1: 'Male', 2: 'Female', 0: 'Hidden' };
  // extra.facebook.authinfo.token/.sign are credentials: never surfaced.
  const fb = extra.facebook && typeof extra.facebook === 'object' ? extra.facebook : {};

  // ---- Location (approximate, IP-based). Fetched BEFORE building the embed
  // so the map can go inside it via setImage(). Any failure just leaves the
  // image out — the profile still renders.
  let geo = null;
  let loginIp = null;
  try {
    loginIp = api.intToIp(x.LastLoginIP);
    if (loginIp) {
      const g = await api.fetchIpGeo(loginIp);
      if (!g.error) geo = g;
    }
  } catch (_) {}

  const token = String(process.env.MAPBOX_TOKEN || '').trim();
  let mapUrl = null;
  let mapBuf = null;
  if (token && geo && geo.lat != null && geo.lon != null) {
    mapUrl =
      'https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/pin-s+FF0000(' +
      geo.lon + ',' + geo.lat + ')/' + geo.lon + ',' + geo.lat + ',12/700x440@2x?access_token=' +
      encodeURIComponent(token);
    // Mapbox renders static maps on-demand and Discord would fetch that URL
    // through its own proxy, so the embed image pops in noticeably later
    // than the text. Grabbing the bytes here lets us upload them directly
    // with the message, so the map shows up together with the card.
    // Falls back to the plain URL if the prefetch fails.
    try {
      mapBuf = await Promise.race([
        fetchBuf(mapUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('map fetch timeout')), 15000)),
      ]);
    } catch (_) { mapBuf = null; }
  }

  const L = (label, value) => '**' + label + ':** ' + value;
  const d = [];
  d.push(L('UID', '`' + V(out.uin) + '`'));
  d.push(L('Nickname', clipT(nick, 80)));
  d.push(L('Username', V(x.bind && x.bind.uname)));
  d.push(L('Status', x.isfreeze ? '🔴 Frozen' : '🟢 Normal'));
  d.push(L('Created on', tsec(x.CreateTime)));
  d.push(L('Last online', tsec(x.LastLoginTime)));
  d.push(L('Level', V(x.level)));
  d.push(L('Developer', yn(x.isdeveloper)));
  d.push(L('TotalMiniCoins', V(x.MiniCoinTotal)));
  d.push(L('Current coins', V(x.minicoin)));
  d.push(L('Current beans', V(x.minibean)));
  d.push(L('Facebook', fb.nickname ? clipT(fb.nickname, 60) : '-'));
  d.push(L('Email', V(x.Email)));
  d.push(L('Phone', V(x.Phone)));
  d.push(L('Country', (flagOf(cc) ? flagOf(cc) + ' ' : '') + V(cc)));
  d.push(L('Gender', GENDER[prof.gender] !== undefined ? GENDER[prof.gender] : V(prof.gender)));
  d.push(L('Creator Level', V(prof.creator && prof.creator.level)));
  d.push(L('Mood', clipT(prof.mood_text, 200)));
  d.push(div);
  d.push(L('Device System', V(extra.DeviceSystem)));
  d.push(L('Device Model', devModel(extra.DeviceModel)));
  d.push(L('Device ID', V(extra.DeviceID)));
  d.push(L('Device Vendor', V(extra.DeviceVender)));
  d.push(L('ID Card', yn(x.idcard_authed)) + '   ' + L('Safe Verify', yn(x.isloginsafeverify)));

  if (loginIp) {
    d.push(div);
    d.push(L('Last IP', '`' + loginIp + '`'));
    if (geo) {
      d.push(L('IP location', [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '-'));
      d.push(L('ZIP', V(geo.postal)));
      d.push(L('Internet provider', V(geo.isp)));
      d.push(L('Coordinates', geo.lat != null && geo.lon != null ? '`' + geo.lat + ', ' + geo.lon + '`' : '-'));
      d.push(L('Timezone', V(geo.tz)));
    }
  }

  // ONE embed that LOOKS like plain text (bold labels in the description,
  // not embed fields): avatar = thumbnail, Mapbox = the big image.
  const embed = new EmbedBuilder()
    .setColor(C_OK)
    .setTitle(clipT(nick, 200))
    .setDescription(d.join('\n').slice(0, 4000))
    .setFooter({ text: 'GetInfo API • Updated: ' + new Date().toISOString().slice(0, 19).replace('T', ' ') })
    .setTimestamp();
  if (out.avatar) embed.setThumbnail(String(out.avatar).replace(/^http:\/\//i, 'https://'));
  if (mapBuf) embed.setImage('attachment://map.png');
  else if (mapUrl) embed.setImage(mapUrl);

  return { embed, files: mapBuf ? [{ attachment: mapBuf, name: 'map.png' }] : [] };
}

/** Fixed-width room table: No | Name | UID | Players. */
function roomTable(rooms) {
  const line = 'No  ' + 'Name'.padEnd(21) + 'UID'.padEnd(13) + 'Players';
  const bar = '-'.repeat(Math.max(line.length, 46));
  const rows = rooms.map((r, i) => {
    const n = String(i + 1).padEnd(4);
    const nm = r.name.slice(0, 20).padEnd(21);
    const uid = r.uin.padEnd(13);
    return n + nm + uid + (r.cur + '/' + r.max);
  });
  return '```' + '\n' + line + '\n' + bar + '\n' + rows.join('\n') + '\n' + '```';
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

/**
 * DM the person who ran !bandev (NOT the owner) when their ban gives up.
 * Falls back to the owner if the requester is unknown or their DMs are closed,
 * so the give-up never goes unnoticed.
 */
async function notifyRequester(clientRef, entry, payload) {
  const uid = entry && entry.requestedBy;
  if (!uid) return notifyOwner(clientRef, payload);
  try {
    const user = await clientRef.users.fetch(uid);
    await user.send(payload);
    return true;
  } catch (err) {
    console.log('Requester DM failed (' + uid + '): ' + (err && err.message));
    return notifyOwner(clientRef, payload);
  }
}

/** Embed sent to the REQUESTER when a ban gives up after MAX_RETRIES "Player not found". */
function buildGaveUpEmbed(uin, entry, errorMsg, retryCount) {
  return new EmbedBuilder()
    .setColor(C_BAD)
    .setTitle('Ban Gave Up — ' + uin)
    .setDescription(
      'Paused the device ban for UID ' + uin + ' after **' + retryCount +
        '** consecutive "Player not found" errors.\nThe target is likely offline (the ban API needs them online to target the device).\nIt will automatically retry in **10 minutes**.'
    )
    .addFields(
      { name: 'UID', value: String(uin), inline: true },
      { name: 'Player', value: (entry && entry.playerName) || 'Unknown', inline: true },
      { name: 'Requested by', value: (entry && entry.requestedByName) || 'Unknown', inline: true },
      { name: 'Last error', value: String(errorMsg).slice(0, 200), inline: false }
    )
    .setFooter({ text: 'Auto-retrying every 10 minutes. Use !unbandev to stop.' });
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
    // Give up THIS round, but don't drop the ban: cool down 10 minutes, then
    // start a fresh retry cycle (retryCount resets so the next round gets
    // MAX_RETRIES tries again). `repeat` MUST stay truthy or bans.due() skips it.
    bans.put(uin, {
      lastFiredAt: now,
      lastResult: 'ERR: ' + errorMsg + ' — gave up, retrying in ' + Math.round(GAVE_UP_COOLDOWN_MS / 60000) + 'm',
      retryCount: 0,
      fireCount: fc,
      gaveUp: true,
      repeat: prev.repeat || bans.REPEAT_MS,
      nextAt: now + GAVE_UP_COOLDOWN_MS,
    });
    notifyRequester(client, prev, { embeds: [buildGaveUpEmbed(uin, prev, errorMsg, retryCount)] });
    console.log('BANDEV gave up ' + uin + ' after ' + retryCount + ' retries; retrying in 10m: ' + errorMsg);
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
// Persistent handler for the !checkroom components.
// Registered once at startup instead of using a message collector, so the
// select menu is never cleared, has no timeout, and survives bot restarts.
// Anyone can keep picking to pull the profile of each player in the room, and
// every profile card carries a "View Details" button with the full !checkinfo
// payload for that UID.
// ---------------------------------------------------------------------------
const CHECKROOM_SELECT_ID = 'checkroom_profile';
const CHECKROOM_DETAILS_PREFIX = 'checkroom_details:';

client.on('interactionCreate', async (interaction) => {
  try {
    // ---- select: baseinfo v1 profile card for the chosen room ----
    if (interaction.isStringSelectMenu() && interaction.customId === CHECKROOM_SELECT_ID) {
      await interaction.deferReply();

      const p = await api.fetchProfileCard(interaction.values[0]);
      if (p.error) {
        await interaction.editReply({ embeds: [msgEmbed(C_BAD, 'Profile Failed', p.error)] });
        return;
      }
      // This edits the interaction's OWN reply. The menu message is left alone
      // so it stays on screen for the next person.
      await interaction.editReply({
        embeds: [profileEmbed(p.prof, p.uin)],
        components: [detailsButton(p.uin)],
      });
      return;
    }

    // ---- button: full !checkinfo data for the UID on the card ----
    if (interaction.isButton() && interaction.customId.startsWith(CHECKROOM_DETAILS_PREFIX)) {
      const uin = interaction.customId.slice(CHECKROOM_DETAILS_PREFIX.length);
      if (!/^\d{1,15}$/.test(uin || '')) {
        await interaction.reply({ content: 'This button has no valid UID.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const out = await api.fetchInfo(uin);
      // Same card as !checkinfo: { error } renders as a red embed, and login
      // credentials (auth_pwd / DeviceToken / FB token) stay withheld. Any
      // map buffer rides along as an attachment so it shows with the card.
      const { embed, files } = await buildCheckinfoEmbed(out);
      await interaction.editReply({ embeds: [embed], files });
      return;
    }
  } catch (err) {
    console.log('checkroom interaction failed: ' + (err && err.message));
  }
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
            '`!checkinfo <UID>` — Full account info + approximate IP location with a map.\n' +
            '`!checkroom [bts|city2]` — Active rooms; pick one to view its host profile.\n' +
            '`!debug` — Scheduler status.\n' +
            '`!help` — Show this message.\n\n' +
            '_A UID already on the list cannot be banned again._'
        )
      );
      return;
    }

    // ---- !checkroom [bts|city2] : list rooms, pick one to view its host profile
    if (cmd === 'checkroom' || cmd === 'room' || cmd === 'rooms') {
      const srcKey = (args[0] || 'bts').toLowerCase();
      const src = ROOM_SOURCES[srcKey];
      if (!src) {
        const list = Object.keys(ROOM_SOURCES)
          .map((k) => '`' + PREFIX + 'checkroom ' + k + '` — ' + ROOM_SOURCES[k].label)
          .join('\n');
        await respond(
          message,
          msgEmbed(
            C_BAD,
            'Unknown Room List',
            'Usage: `' + PREFIX + 'checkroom [list]`\n\nAvailable:\n' + list
          )
        );
        return;
      }

      let loading = null;
      try {
        loading = await message.channel.send('⏳ Fetching active rooms (' + srcKey + ')...');
      } catch (_) {}

      const out = await api.fetchRooms(src.url);
      if (out.error) {
        if (loading) { try { await loading.edit('❌ ' + out.error); } catch (_) {} }
        else await respond(message, msgEmbed(C_BAD, 'Room Check Failed', out.error));
        return;
      }

      const rooms = out.rooms || [];
      const mapName = out.roomName || src.label;
      if (!rooms.length) {
        const empty = 'No active rooms right now (' + srcKey + ').';
        if (loading) { try { await loading.edit(empty); } catch (_) {} }
        else await respond(message, msgEmbed(C_INFO, mapName, empty));
        return;
      }

      // Title matches the reference layout: "<room name> (<host>)"
      const title = mapName + ' (' + rooms[0].name + ')';
      const e = msgEmbed(C_INFO, title, roomTable(rooms));
      e.setFooter({ text: 'Updated: ' + new Date().toISOString().replace('T', ' ').slice(0, 19) });

      // Select menu: one option per room (Discord caps options at 25).
      const options = rooms.slice(0, 25).map((r, i) => ({
        label: (i + 1) + '. ' + r.name.slice(0, 90),
        description: 'UID ' + r.uin + ' | ' + r.cur + '/' + r.max + ' players',
        value: r.uin,
      }));

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('checkroom_profile')
          .setPlaceholder('Select a room to view the profile...')
          .addOptions(options)
      );

      // No collector here. The select menu is served by the persistent
      // interactionCreate handler, so it is never cleared and anyone can
      // keep picking from it to pull the profile of every player in the room.
      await message.channel.send({ embeds: [e], components: [row] });
      if (loading) { try { await loading.delete(); } catch (_) {} }
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

      // Plain loading line (a NEW message, never a reply/mention).
      let statusMsg = null;
      try {
        statusMsg = await message.channel.send('⏳ Fetching info for UID ' + uid + '...');
      } catch (err) {
        console.log('Status send failed: ' + (err && err.message));
      }

      const out = await api.fetchInfo(uid);
      if (out.error) {
        if (statusMsg) { try { await statusMsg.edit('❌ ' + out.error); return; } catch (_) {} }
        await respond(message, msgEmbed(C_BAD, 'Info Failed', out.error));
        return;
      }

      const { embed, files } = await buildCheckinfoEmbed(out);

      // Drop the loading line, then send the finished card as a fresh message.
      if (statusMsg) { try { await statusMsg.delete(); } catch (_) {} }
      const payload = { embeds: [embed] };
      if (files.length) payload.files = files;
      try { await message.channel.send(payload); } catch (_) {}
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

    // ---- !debug : show scheduler state + full ban details (read-only)
    if (cmd === 'debug') {
      const now = Date.now();
      const entries = bans.all();
      const fmtTs = (ms) => (ms ? '<t:' + Math.round(ms / 1000) + ':f>' : '-');
      const schedLines = entries.length
        ? entries.map((e) => {
            const nextIn = e.nextAt ? Math.round((e.nextAt - now) / 1000) + 's' : '-';
            const untilIn = e.until ? Math.round((e.until - now) / 1000) + 's' : 'one-time';
            const lastFired = e.lastFiredAt ? '<t:' + Math.round(e.lastFiredAt / 1000) + ':R>' : 'never';
            const fires = e.fireCount || 0;
            const retry = e.gaveUp
              ? ' ⚠️ **GAVE UP** — auto-retry every ' + Math.round(GAVE_UP_COOLDOWN_MS / 60000) + 'm'
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
