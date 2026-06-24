const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new DatabaseSync(path.join(dataDir, 'kaikei.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`CREATE TABLE IF NOT EXISTS records (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  kobucho_item_id       INTEGER,
  source                TEXT DEFAULT 'manual',
  brand                 TEXT DEFAULT '',
  name                  TEXT NOT NULL,
  purchase_date         TEXT NOT NULL,
  purchase_price        INTEGER NOT NULL,
  sale_date             TEXT,
  sale_price            INTEGER,
  fee_amount            INTEGER DEFAULT 0,
  shipping_amount       INTEGER DEFAULT 0,
  deleted_in_kobucho    INTEGER DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now','localtime'))
)`);

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kobucho_item
  ON records(kobucho_item_id) WHERE kobucho_item_id IS NOT NULL`);

db.exec(`CREATE TABLE IF NOT EXISTS expenses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,
  category       TEXT NOT NULL,
  amount         INTEGER NOT NULL,
  memo           TEXT DEFAULT '',
  household_rate INTEGER DEFAULT 100,
  created_at     TEXT DEFAULT (datetime('now','localtime'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS expense_categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
)`);

// Seed expense categories (only if empty)
const catCount = db.prepare('SELECT COUNT(*) as c FROM expense_categories').get();
if (catCount.c === 0) {
  const ins = db.prepare('INSERT INTO expense_categories (name) VALUES (?)');
  ['荷造運賃','通信費','旅費交通費','消耗品費','支払手数料','広告宣伝費','新聞図書費','水道光熱費','地代家賃','雑費']
    .forEach(name => ins.run(name));
}

// Default settings
const insSet = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
[
  ['owner_name', ''],
  ['owner_address', ''],
  ['yago', ''],
  ['tax_type', 'white'],
  ['kobucho_db_path', ''],
  ['theme', 'light'],
  ['fiscal_year', new Date().getFullYear().toString()],
  ['blue_deduction', '100000'],
].forEach(([k, v]) => insSet.run(k, v));

module.exports = db;
