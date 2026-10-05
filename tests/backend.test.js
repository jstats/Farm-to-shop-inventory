/** Runs backend/Code.gs against a small fake of the Apps Script services. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Seed = require('../docs/seed.js');

function fakeSheet(name) {
  const rows = [];
  const sh = {
    name,
    rows,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(0, ...rows.map((r) => r.length)),
    appendRow: (r) => rows.push(r.slice()),
    setFrozenRows() {},
    getRange(a, col, nr, nc) {
      if (typeof a === 'string') return { setNumberFormat() {} };
      return {
        getValues: () => rows.slice(a - 1, a - 1 + nr).map((r) => Array.from({ length: nc }, (_, i) => (r[col - 1 + i] === undefined ? '' : r[col - 1 + i]))),
        setValues: (vals) => vals.forEach((v, i) => { rows[a - 1 + i] = v.slice(); }),
        setFontWeight() { return this; },
        setNumberFormat() { return this; },
      };
    },
  };
  return sh;
}

function load() {
  const sheets = {};
  const cache = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = fakeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: (s) => delete sheets[s.name],
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }), MimeType: { JSON: 'json' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => delete cache[k] }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
    Math, Date, JSON, String, Number, isFinite, Object, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8'), ctx);
  ctx.setup();
  sheets.workers.rows[1] = ['Mwende Musyoka', '0427', 'yes'];
  sheets.workers.rows[2] = ['Otieno', '1111', 'no'];
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return { ctx, sheets, post };
}

const sale = (id, extra = {}) => Object.assign({ id, date: '2026-10-05', type: 'sale', itemId: 'honey-1kg', qty: 2, from: 'nairobi', to: '', price: 1700, worker: 'Someone else', note: '', at: '2026-10-05T10:00:00Z' }, extra);

test('backend seed items and locations match the app seed', () => {
  const { sheets } = load();
  // JSON round trip: arrays made inside the vm have a different prototype.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(sheets.items.rows.slice(1).map((r) => r.slice(0, 6))), Seed.ITEMS);
  assert.deepEqual(plain(sheets.locations.rows.slice(1)), Seed.LOCATIONS);
});

test('sign in is case-insensitive on name, exact on PIN; inactive workers are refused', () => {
  const { post } = load();
  assert.equal(post({ action: 'data', name: ' mwende musyoka ', pin: '0427' }).worker, 'Mwende Musyoka');
  assert.equal(post({ action: 'data', name: 'Mwende Musyoka', pin: '427' }).error, 'wrong_pin');
  assert.equal(post({ action: 'data', name: 'Otieno', pin: '1111' }).error, 'wrong_pin');
});

test('a name locks after repeated wrong PINs', () => {
  const { post } = load();
  for (let i = 0; i < 5; i++) post({ action: 'data', name: 'Mwende Musyoka', pin: '0000' });
  assert.equal(post({ action: 'data', name: 'Mwende Musyoka', pin: '0427' }).error, 'locked');
});

test('save stamps the signed-in worker, works out the amount, and ignores repeats', () => {
  const { post, sheets } = load();
  const me = { name: 'Mwende Musyoka', pin: '0427' };
  const r1 = post({ action: 'save', ...me, movements: [sale('a1')] });
  assert.deepEqual(r1.saved, ['a1']);
  const r2 = post({ action: 'save', ...me, movements: [sale('a1'), sale('a2', { qty: 1 })] });
  assert.deepEqual(r2.saved, ['a1', 'a2']);
  const rows = sheets.movements.rows.slice(1);
  assert.equal(rows.length, 2);
  const head = sheets.movements.rows[0];
  const row = Object.fromEntries(head.map((h, i) => [h, rows[0][i]]));
  assert.equal(row.worker, 'Mwende Musyoka');
  assert.equal(row.amount, 3400);
  assert.equal(row.itemName, 'Raw Honey — 1kg Jar');

  const data = post({ action: 'data', ...me });
  assert.equal(data.movements.length, 2);
  assert.equal(data.locations.length, 3);
  assert.equal(data.movements[0].from, 'nairobi');
});

test('save rejects unknown items, places, types and bad numbers', () => {
  const { post } = load();
  const me = { name: 'Mwende Musyoka', pin: '0427' };
  const r = post({ action: 'save', ...me, movements: [
    sale('b1', { itemId: 'nope' }),
    sale('b2', { from: 'mombasa' }),
    sale('b3', { type: 'gift' }),
    sale('b4', { qty: -1 }),
    sale('b5', { date: '5/10/2026' }),
    sale('b6'),
  ] });
  assert.deepEqual(r.rejected, ['b1', 'b2', 'b3', 'b4', 'b5']);
  assert.deepEqual(r.saved, ['b6']);
});
