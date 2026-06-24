const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const db = require('./db');

const app = express();
const PORT = 3941;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SETTINGS ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

app.put('/api/settings', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(req.body)) upsert.run(k, String(v));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// ── EXPENSE CATEGORIES ────────────────────────────────
app.get('/api/expense-categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM expense_categories ORDER BY id').all());
});

app.post('/api/expense-categories', (req, res) => {
  const { name } = req.body;
  const r = db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(name);
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/expense-categories/:id', (req, res) => {
  db.prepare('DELETE FROM expense_categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── RECORDS ───────────────────────────────────────────
app.get('/api/records', (req, res) => {
  const { year } = req.query;
  let sql = 'SELECT * FROM records';
  const params = [];
  if (year) {
    sql += ' WHERE purchase_date LIKE ? OR sale_date LIKE ?';
    params.push(`${year}%`, `${year}%`);
  }
  sql += ' ORDER BY purchase_date DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/records', (req, res) => {
  const { brand, name, purchase_date, purchase_price, sale_date, sale_price, fee_amount, shipping_amount } = req.body;
  const r = db.prepare(`
    INSERT INTO records (brand, name, purchase_date, purchase_price, sale_date, sale_price, fee_amount, shipping_amount, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')
  `).run(brand || '', name, purchase_date, purchase_price, sale_date || null, sale_price || null, fee_amount || 0, shipping_amount || 0);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/records/:id', (req, res) => {
  const { brand, name, purchase_date, purchase_price, sale_date, sale_price, fee_amount, shipping_amount } = req.body;
  db.prepare(`
    UPDATE records SET brand=?, name=?, purchase_date=?, purchase_price=?,
    sale_date=?, sale_price=?, fee_amount=?, shipping_amount=? WHERE id=?
  `).run(brand || '', name, purchase_date, purchase_price, sale_date || null, sale_price || null, fee_amount || 0, shipping_amount || 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/records/:id', (req, res) => {
  db.prepare('DELETE FROM records WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── EXPENSES ──────────────────────────────────────────
app.get('/api/expenses', (req, res) => {
  const { year } = req.query;
  let sql = 'SELECT * FROM expenses';
  const params = [];
  if (year) { sql += ' WHERE date LIKE ?'; params.push(`${year}%`); }
  sql += ' ORDER BY date DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/expenses', (req, res) => {
  const { date, category, amount, memo, household_rate } = req.body;
  const r = db.prepare('INSERT INTO expenses (date, category, amount, memo, household_rate) VALUES (?, ?, ?, ?, ?)')
    .run(date, category, amount, memo || '', household_rate ?? 100);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/expenses/:id', (req, res) => {
  const { date, category, amount, memo, household_rate } = req.body;
  db.prepare('UPDATE expenses SET date=?, category=?, amount=?, memo=?, household_rate=? WHERE id=?')
    .run(date, category, amount, memo || '', household_rate ?? 100, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── SUMMARY ───────────────────────────────────────────
app.get('/api/summary', (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const Y = year.toString();
  const yStart = `${Y}-01-01`;
  const yEnd   = `${Y}-12-31`;

  const sales = db.prepare(`SELECT COALESCE(SUM(sale_price),0) as v FROM records WHERE sale_date >= ? AND sale_date <= ?`).get(yStart, yEnd).v;
  const cogs_purchases = db.prepare(`SELECT COALESCE(SUM(purchase_price),0) as v FROM records WHERE purchase_date >= ? AND purchase_date <= ?`).get(yStart, yEnd).v;
  const cogs_opening   = db.prepare(`SELECT COALESCE(SUM(purchase_price),0) as v FROM records WHERE purchase_date < ? AND (sale_date IS NULL OR sale_date >= ?)`).get(yStart, yStart).v;
  const cogs_closing   = db.prepare(`SELECT COALESCE(SUM(purchase_price),0) as v FROM records WHERE sale_date IS NULL OR sale_date > ?`).get(yEnd).v;
  const cogs           = cogs_opening + cogs_purchases - cogs_closing;
  const gross_profit   = sales - cogs;

  // Expenses by category
  const expRows  = db.prepare(`SELECT category, amount, household_rate FROM expenses WHERE date >= ? AND date <= ?`).all(yStart, yEnd);
  const catRows  = db.prepare('SELECT name FROM expense_categories ORDER BY id').all();
  const expenses_by_category = {};
  for (const c of catRows) expenses_by_category[c.name] = 0;
  for (const e of expRows) {
    const eff = Math.floor(e.amount * e.household_rate / 100);
    expenses_by_category[e.category] = (expenses_by_category[e.category] || 0) + eff;
  }

  const fee_total      = db.prepare(`SELECT COALESCE(SUM(fee_amount),0) as v FROM records WHERE sale_date >= ? AND sale_date <= ?`).get(yStart, yEnd).v;
  const shipping_total = db.prepare(`SELECT COALESCE(SUM(shipping_amount),0) as v FROM records WHERE sale_date >= ? AND sale_date <= ?`).get(yStart, yEnd).v;
  const total_expenses = Object.values(expenses_by_category).reduce((a, b) => a + b, 0) + fee_total + shipping_total;

  const income = gross_profit - total_expenses;
  const settingRows = db.prepare('SELECT key, value FROM settings').all();
  const stg = {};
  for (const r of settingRows) stg[r.key] = r.value;
  const blue_deduction = parseInt(stg.blue_deduction || '100000');
  const income_after_deduction = income - blue_deduction;

  // Monthly data
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const pref = `${Y}-${mm}%`;
    const mSale    = db.prepare(`SELECT COALESCE(SUM(sale_price),0) as v FROM records WHERE sale_date LIKE ?`).get(pref).v;
    const mCost    = db.prepare(`SELECT COALESCE(SUM(purchase_price + fee_amount + shipping_amount),0) as v FROM records WHERE sale_date LIKE ?`).get(pref).v;
    const mExpRows = db.prepare(`SELECT amount, household_rate FROM expenses WHERE date LIKE ?`).all(pref);
    const mExp     = mExpRows.reduce((acc, e) => acc + Math.floor(e.amount * e.household_rate / 100), 0);
    monthly.push({ month: m, sale: mSale, cost: mCost, expense: mExp, profit: mSale - mCost - mExp });
  }

  res.json({ year, sales, cogs_opening, cogs_purchases, cogs_closing, cogs, gross_profit,
    expenses_by_category, fee_total, shipping_total, total_expenses,
    income, blue_deduction, income_after_deduction, monthly });
});

// ── IMPORT KOBUCHO ────────────────────────────────────
app.post('/api/import-kobucho', (req, res) => {
  try {
    const pathRow = db.prepare("SELECT value FROM settings WHERE key = 'kobucho_db_path'").get();
    const dbPath  = pathRow?.value || '';
    if (!dbPath)               return res.json({ error: 'kobuchoのDBパスが設定されていません' });
    if (!fs.existsSync(dbPath)) return res.json({ error: 'ファイルが見つかりません' });

    const tmpPath = path.join(os.tmpdir(), 'furyo_copy.db');
    fs.copyFileSync(dbPath, tmpPath);

    const srcDb = new DatabaseSync(tmpPath, { readOnly: true });
    const items = srcDb.prepare(`
      SELECT i.id, i.brand, i.name, i.received_at, i.purchase_price,
             i.sold_at, i.sold_price, i.status,
             f.rate AS fee_rate, s.amount AS ship_amount
      FROM items i
      LEFT JOIN fee_presets f ON i.fee_preset_id = f.id
      LEFT JOIN shipping_presets s ON i.shipping_preset_id = s.id
    `).all();
    srcDb.close();

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO records
        (kobucho_item_id, source, brand, name, purchase_date, purchase_price,
         sale_date, sale_price, fee_amount, shipping_amount)
      VALUES (?, 'kobucho', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    for (const item of items) {
      const fee_amount      = (item.sold_price && item.fee_rate) ? Math.round(item.sold_price * item.fee_rate) : 0;
      const shipping_amount = item.ship_amount || 0;
      upsert.run(item.id, item.brand || '', item.name, item.received_at, item.purchase_price,
        item.sold_at || null, item.sold_price || null, fee_amount, shipping_amount);
    }
    db.exec('COMMIT');

    try { fs.unlinkSync(tmpPath); } catch {}

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_import_at', ?)")
      .run(new Date().toLocaleString('ja-JP'));

    const total = db.prepare('SELECT COUNT(*) as c FROM records').get().c;
    res.json({ imported: items.length, total });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── TEST KOBUCHO PATH ─────────────────────────────────
app.get('/api/test-kobucho-path', (req, res) => {
  const { path: dbPath } = req.query;
  if (!dbPath || !fs.existsSync(dbPath)) return res.json({ error: 'ファイルが見つかりません' });
  try {
    const testDb = new DatabaseSync(dbPath, { readOnly: true });
    const count  = testDb.prepare('SELECT COUNT(*) as c FROM items').get();
    testDb.close();
    res.json({ ok: true, count: count.c });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── START ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n📊 kaikei 起動中`);
  console.log(`👉 http://localhost:${PORT}\n`);
});
