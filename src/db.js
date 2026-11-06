'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mavi.db');

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -2048'); // 2 MiB page-cache target
  db.pragma('mmap_size = 0');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

const db = open();
// Additive migrations retain existing orders and customer data.
const hadDeliveryRequested = db.pragma('table_info(orders)').some(c=>c.name==='delivery_requested');
for (const [table, column, definition] of [
  ['orders','governorate','TEXT'], ['orders','delivery_requested','INTEGER NOT NULL DEFAULT 0'],
  ['orders','shipping_quoted','INTEGER NOT NULL DEFAULT 0'], ['orders','fabric_choice','TEXT'], ['orders','manual_entry','INTEGER NOT NULL DEFAULT 0'],
  ['custom_requests','governorate','TEXT'], ['custom_requests','fabric_choice','TEXT'],
  ['style_images','is_primary','INTEGER NOT NULL DEFAULT 0'],
  ['styles','sale_price','REAL'],
  ['fabric','shipping_per_metre','REAL NOT NULL DEFAULT 0'],
  ['tailors','address','TEXT'], ['tailors','notes','TEXT'],
  ['order_items','description','TEXT'],
  ['custom_requests','shipping_fee','REAL'], ['custom_requests','requested_colour','TEXT'], ['custom_requests','requested_fabric','TEXT'],
]) {
  if (!db.pragma('table_info('+table+')').some(c=>c.name===column))
    db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+definition);
}
if (!hadDeliveryRequested) db.exec('UPDATE orders SET delivery_requested=CASE WHEN delivery_fee>0 THEN 1 ELSE 0 END, shipping_quoted=1');

/* ---------- tiny helpers ---------- */
const get  = (sql, ...a) => db.prepare(sql).get(...a);
const all  = (sql, ...a) => db.prepare(sql).all(...a);
const run  = (sql, ...a) => db.prepare(sql).run(...a);

function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, String(value));
}

function audit(entity, entityId, action, actor, detail) {
  run('INSERT INTO events(entity,entity_id,action,actor,detail) VALUES(?,?,?,?,?)',
      entity, String(entityId), action, actor || null,
      detail ? JSON.stringify(detail) : null);
}

module.exports = { db, get, all, run, setting, setSetting, audit, DB_PATH };
