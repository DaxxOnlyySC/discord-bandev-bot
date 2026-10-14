'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Local active-ban schedule — ONLY used when BANDEV_LOOP_API_URL is empty.
 *
 * When the Cloudflare loop worker IS configured, repeats live in KV + Cron and
 * this store is never written to. Without a Railway volume the local schedule
 * is lost on redeploy, which is exactly why the Cloudflare path is preferred.
 *
 * Stored at data/bans.json.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'bans.json');

const REPEAT_MS = 5 * 60 * 1000; // repeat every 5 minutes

let cache = null;

function load() {
  if (cache && typeof cache === 'object') return cache;
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/** Add / update a scheduled ban. */
function put(uin, data) {
  const s = String(uin);
  const db = load();
  db[s] = Object.assign({}, db[s] || {}, data, { uin: s, updatedAt: Date.now() });
  return save();
}

function remove(uin) {
  const db = load();
  const s = String(uin);
  if (!db[s]) return false;
  delete db[s];
  return save();
}

function get(uin) {
  return load()[String(uin)] || null;
}

function all() {
  const db = load();
  return Object.values(db).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Entries whose repeat time has passed (need an API call now). */
function due(now = Date.now()) {
  return all().filter((e) => e.repeat && e.nextAt && e.nextAt <= now);
}

module.exports = { put, remove, get, all, due, REPEAT_MS, FILE };
