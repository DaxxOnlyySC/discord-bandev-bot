'use strict';

const BASE = (process.env.BANDEV_API_URL || 'https://bandev.daxterrantares.workers.dev').replace(/\/+$/, '');
const BASEINFO = (process.env.BASEINFO_V1_API_URL || 'https://baseinfov1.daxterrantares.workers.dev').replace(/\/+$/, '');

// !checkinfo — full account info. Pattern `.../getinfo=<UID>` (path, bukan query),
// balas JSON `{"code":0,"data":{...}}`.
// The bare `getinfoapi.onrender.com` host is DEAD (404 + x-render-routing:
// no-server). Live service = `getinfoapi-ajvx`. We rewrite the dead host at
// RUNTIME, so a stale GETINFO_API_URL in Railway still works — no env change needed.
const GETINFO = (process.env.GETINFO_API_URL || 'https://getinfoapi-ajvx.onrender.com/getinfo=')
  .replace(/getinfoapi\.onrender\.com/i, 'getinfoapi-ajvx.onrender.com')
  .replace(/^http:\/\//i, 'https://')
  .replace(/\/+$/, '');

/**
 * Rakit URL getinfo untuk suatu UID. Pola aslinya `.../getinfo=<UID>`, jadi
 * dukung semua bentuk penulisan di .env:
 *   https://host/getinfo=  -> https://host/getinfo=1317398296
 *   https://host/getinfo   -> https://host/getinfo=1317398296
 *   https://host/          -> https://host/1317398296
 */
function buildGetInfoUrl(id) {
  const base = GETINFO.replace(/\/+$/, '');
  if (/=+$/.test(base)) return base + id;
  if (/getinfo$/i.test(base)) return base + '=' + id;
  if (/\/get$/i.test(base)) return base + '=' + id;
  return base + '/' + id;
}

const UA = 'MiniWorld-Discord-Bot/1.0';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function fixUin(uin) {
  const s = String(uin == null ? '' : uin).replace(/\D/g, '');
  if (!s) return null;
  if (s.length === 8) return '10' + s;
  if (s.length === 9) return '1' + s;
  return s;
}

/** GET helper. Returns { status, text } or throws. */
async function getText(url, timeoutMs = 45000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: '*/*' } });
    const text = (await r.text()).trim();
    // Render sets this when it has no live instance to route to (asleep/stopped).
    return { status: r.status, text, routing: r.headers.get('x-render-routing') };
  } finally {
    clearTimeout(t);
  }
}

/** Fire a single ban/join. Resolves { ok, realUin, msg } or { error, realUin? }. */
async function fetchBanDev(uin) {
  const real = fixUin(uin);
  if (!real) return { error: 'Invalid UID. Use 8/9/10 digits.' };
  if (!BASE) return { error: 'BANDEV_API_URL is not configured.' };
  try {
    const { status, text } = await getText(`${BASE}/?bandev=${encodeURIComponent(real)}`);
    if (status === 200) {
      const m = text.match(/Done\s+(\d+)/i);
      return { ok: true, realUin: m ? m[1] : real, msg: text };
    }
    if (status === 404) return { error: 'Player not found for UID ' + real + '.', realUin: real };
    if (status === 400) {
      let msg = '';
      try { msg = JSON.parse(text).error || ''; } catch (_) {}
      return { error: msg || 'Invalid UID. Use 8/9/10 digits.', realUin: real };
    }
    return { error: 'Ban API returned HTTP ' + status + '.', realUin: real };
  } catch (e) {
    return { error: 'Ban API request failed: ' + (e && e.message ? e.message : String(e)) + '.' };
  }
}

/** Player nickname for display in the approval DM. Resolves string or null. */
async function fetchPlayerName(uin) {
  const real = fixUin(uin);
  if (!real || !BASEINFO) return null;
  try {
    const { status, text } = await getText(`${BASEINFO}/?uid=${encodeURIComponent(real)}`, 20000);
    if (status !== 200) return null;
    let root = null;
    try { root = JSON.parse(text); } catch (_) { return null; }
    const first = root && (root['1'] || root[1] || Object.values(root)[0]);
    const prof = first && first.profile;
    if (!prof) return null;
    const name = (prof.RoleInfo && prof.RoleInfo.NickName) || prof.NickName || null;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch (_) {
    return null;
  }
}

/**
 * !checkinfo <UID> - full account info from the getinfo API.
 * Resolves { uin, data, prof, role, extra, avatar } or { error }.
 *
 * Response shape (verified live):
 *   {"code":0,"data":{Uin,NickName...,CreateTime,LastLoginTime,LastLoginIP,
 *                     Email,Phone,level,minibean,minicoin,extra{Device*},
 *                     profile{RoleInfo,header2,gender,...},...}}
 *   UID not found / bad input -> non-2xx or code != 0.
 * `auth_pwd` and `extra.DeviceToken` are credentials: never surfaced to chat.
 */
async function fetchInfo(uin) {
  const real = fixUin(uin);
  if (!real) return { error: 'Invalid UID. Use 8, 9, or 10 digits.' };
  if (!GETINFO) return { error: 'GETINFO_API_URL is not configured.' };

  let status;
  let text;
  let routing;
  try {
    ({ status, text, routing } = await getText(buildGetInfoUrl(real), 30000));
  } catch (e) {
    return { error: 'GetInfo API request failed: ' + (e && e.message ? e.message : String(e)) + '.' };
  }

  if (status !== 200) {
    // Render replies 404 + x-render-routing: no-server when the service has no
    // running instance (asleep / stopped / wrong host) — that is the API being
    // down, NOT an unknown UID. Report it honestly so it isn't mistaken for
    // "player not found".
    if (status === 404 && routing === 'no-server') {
      return { error: 'GetInfo API is down (no running instance). Check GETINFO_API_URL / the Render service, then retry.' };
    }
    if (status === 404) return { error: 'Player not found for UID ' + real + '.' };
    return { error: 'GetInfo API returned HTTP ' + status + '.' };
  }

  let root = null;
  try {
    root = JSON.parse(text);
  } catch (_) {
    return { error: 'GetInfo API returned a non-JSON response.' };
  }

  if (String(root.code) !== '0') {
    return { error: 'API returned code=' + root.code + ' / msg=' + (root.msg || root.message || '-') + '.' };
  }

  const x = isObj(root.data) ? root.data : {};
  if (x.Uin == null && x.uid == null) {
    return { error: 'No data returned for UID ' + real + '.' };
  }

  const prof = isObj(x.profile) ? x.profile : {};
  const role = isObj(x.RoleInfo) ? x.RoleInfo : isObj(prof.RoleInfo) ? prof.RoleInfo : {};
  const header2 = isObj(prof.header2) ? prof.header2 : {};

  return {
    realUin: real,
    uin: x.Uin != null ? x.Uin : x.uid != null ? x.uid : real,
    data: x,
    prof,
    role,
    extra: isObj(x.extra) ? x.extra : {},
    // header2.url = foto profil (http:// kadang ditolak, jadi opsional).
    avatar: header2.url || null,
  };
}

/**
 * Parse a human duration ("1day", "5m", "2 hours", "10 menit") into milliseconds.
 * Accepts English + Indonesian units. Returns null when unrecognized.
 */
function parseDur(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim().replace(/\s+/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2];
  if (['m', 'min', 'mins', 'minute', 'minutes', 'menit', 'menets'].includes(u)) return Math.round(n * 60000);
  if (['h', 'hr', 'hrs', 'hour', 'hours', 'jam'].includes(u)) return Math.round(n * 3600000);
  if (['d', 'day', 'days', 'hari'].includes(u)) return Math.round(n * 86400000);
  return null;
}

/** Milliseconds -> short human label ("5m", "3h", "1d"). */
function fmtDur(ms) {
  if (!ms) return '-';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

/**
 * Decode a Mini World integer IP (LITTLE-endian) -> dotted string.
 * 2453636455 -> 103.133.63.146. Returns null when unusable.
 */
function intToIp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}

/**
 * Geolocate an IP. Uses ipwho.is (free, HTTPS, no API key).
 * Returns { ip, city, region, country, lat, lon, isp, tz } or { error }.
 *
 * IMPORTANT: IP geolocation is APPROXIMATE — it resolves to a city/region
 * centroid, NEVER an exact address. VPN / proxy / mobile IPs often point far
 * away from the real user. Treat the result as "rough area", not a location.
 */
async function fetchIpGeo(ip) {
  if (!ip) return { error: 'No IP to look up.' };
  let status;
  let text;
  try {
    ({ status, text } = await getText('https://ipwho.is/' + encodeURIComponent(ip), 20000));
  } catch (e) {
    return { error: 'Geo lookup failed: ' + (e && e.message ? e.message : String(e)) + '.' };
  }
  if (status !== 200) return { error: 'Geo lookup returned HTTP ' + status + '.' };
  let j = null;
  try { j = JSON.parse(text); } catch (_) { return { error: 'Geo lookup returned a non-JSON response.' }; }
  if (!j || j.success === false) return { error: (j && j.message) || 'IP not found.' };

  const conn = j.connection || {};
  return {
    ip,
    city: j.city || null,
    region: j.region || null,
    country: j.country || null,
    countryCode: j.country_code || null,
    continent: j.continent || null,
    postal: j.postal || null,
    lat: typeof j.latitude === 'number' ? j.latitude : null,
    lon: typeof j.longitude === 'number' ? j.longitude : null,
    isp: conn.isp || conn.org || null,
    asn: conn.asn || null,
    tz: (j.timezone && j.timezone.id) || null,
  };
}

// ---------------------------------------------------------------------------
// !checkroom - active Back To School room list + host profile
// ---------------------------------------------------------------------------

const ROOMS_BTS = 'https://miniworld-api.daxtercarl1202.workers.dev/';

/**
 * Active Back To School rooms.
 * Resolves { rooms: [{uin,name,roomName,cur,max,locked}], error }.
 *
 * Live shape (verified): {"map_type":41834052663740,"prinum":0,
 *   "roomlist":[{"room_name":"Back To School [2.0]","uname":"PDF Mw: ...",
 *                "uin":1137790884,"cur_count":1,"max_count":40,"passwd":0}]}
 */
async function fetchRooms() {
  const { status, text } = await getText(ROOMS_BTS, 20000);
  if (status !== 200) return { error: 'Room API returned HTTP ' + status };
  let root = null;
  try { root = JSON.parse(text); } catch (_) { return { error: 'Room API returned invalid JSON' }; }
  const list = root && (root.roomlist || root.rent);
  if (!Array.isArray(list)) return { error: 'Room API returned an unexpected shape' };

  const rooms = list
    .filter((r) => r && r.uin)
    .map((r) => ({
      uin: fixUin(String(r.uin)),
      name: (String(r.uname || '').trim()) || '(unknown)',
      roomName: String(r.room_name || '').trim(),
      cur: Number(r.cur_count) || 0,
      max: Number(r.max_count) || 0,
      locked: !!r.passwd,
    }));
  return { rooms, roomName: rooms.length ? rooms[0].roomName : '' };
}

/**
 * Full profile card from the baseinfo v1 API (`?uid=`).
 * Resolves { prof, uin, error }.
 *
 * Live shape (verified): {"1":{"uin":...,"profile":{"RoleInfo":{"NickName":...},
 *   "header2":{"url":...},"country":"ID","gender":0,"mood_text":"...",
 *   "all_download_count":22,"popularity":...,"head_frame_id":20278}}}
 */
async function fetchProfileCard(uin) {
  const real = fixUin(uin);
  if (!real) return { error: 'Invalid UID' };
  const { status, text } = await getText(`${BASEINFO}/?uid=${encodeURIComponent(real)}`, 20000);
  if (status !== 200) return { error: 'Profile API returned HTTP ' + status };
  let root = null;
  try { root = JSON.parse(text); } catch (_) { return { error: 'Profile API returned invalid JSON' }; }
  const first = root && (root['1'] || root[1] || Object.values(root)[0]);
  const prof = first && first.profile;
  if (!prof) return { error: 'Profile API returned no profile for that UID.' };
  return { prof, uin: real };
}

module.exports = {
  fixUin,
  fetchBanDev,
  fetchPlayerName,
  fetchInfo,
  buildGetInfoUrl,
  intToIp,
  fetchIpGeo,
  parseDur,
  fmtDur,
  fetchRooms,
  fetchProfileCard,
  GETINFO,
};
