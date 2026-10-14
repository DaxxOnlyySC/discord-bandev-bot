'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Pending / decided ban requests.
 *
 * Every !bandev creates a request that is PENDING until the admin clicks
 * Approve or Deny in the DM. Nothing is executed before approval.
 *
 * Persisted to data/requests.json (best-effort). On Railway without a volume
 * this file is wiped on redeploy — acceptable because approvals are short-lived.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'requests.json');

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

/** Create a new pending request. Returns the request object. */
function create(data) {
  const id = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const db = load();
  const req = Object.assign(
    {
      id,
      status: 'pending', // pending | approved | denied
      createdAt: Date.now(),
      decidedAt: null,
    },
    data
  );
  db[id] = req;
  save();
  return req;
}

function get(id) {
  return load()[String(id)] || null;
}

/** Patch a request (e.g. set status / ids) and persist. Returns updated or null. */
function update(id, patch) {
  const db = load();
  const key = String(id);
  if (!db[key]) return null;
  db[key] = Object.assign({}, db[key], patch, { id: key });
  save();
  return db[key];
}

/** All requests, newest first. */
function all() {
  const db = load();
  return Object.values(db).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Still-pending requests. */
function pending() {
  return all().filter((r) => r.status === 'pending');
}

module.exports = { create, get, update, all, pending, FILE };
