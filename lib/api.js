'use strict';

const BASE = (process.env.BANDEV_API_URL || 'https://bandev.daxterrantares.workers.dev').replace(/\/+$/, '');
const BASEINFO = (process.env.BASEINFO_V1_API_URL || 'https://baseinfov1.daxterrantares.workers.dev').replace(/\/+$/, '');

const UA = 'MiniWorld-Discord-Bot/1.0';

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
    return { status: r.status, text };
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

module.exports = {
  fixUin,
  fetchBanDev,
  fetchPlayerName,
  parseDur,
  fmtDur,
};
