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
      nr = nr || 1;
      nc = nc || 1;
      const range = {
        getValues: () => rows.slice(a - 1, a - 1 + nr).map((r) => Array.from({ length: nc }, (_, i) => (r[col - 1 + i] === undefined ? '' : r[col - 1 + i]))),
        setValues: (vals) => {
          vals.forEach((v, i) => {
            const r = rows[a - 1 + i] || (rows[a - 1 + i] = []);
            v.forEach((x, j) => { r[col - 1 + j] = x; });
          });
          return range;
        },
        setValue: (x) => range.setValues([[x]]),
        setFontWeight: () => range,
        setNumberFormat: () => range,
      };
      return range;
    },
  };
  return sh;
}

function load() {
  const sheets = {};
  const cache = {};
  const mail = [];
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
    // Nairobi is UTC+3 all year.
    Utilities: {
      formatDate: (d, tz, pat) => {
        const n = new Date(d.getTime() + 3 * 3600e3);
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        if (pat === 'H') return String(n.getUTCHours());
        if (pat === 'MMMM') return months[n.getUTCMonth()];
        if (pat === 'd MMM') return n.getUTCDate() + ' ' + months[n.getUTCMonth()].slice(0, 3);
        return n.toISOString().slice(0, 10);
      },
    },
    MailApp: { sendEmail: (to, subject, body) => mail.push(typeof to === 'object' ? to : { to, subject, body }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Logger: { log() {} },
    Math, Date, JSON, String, Number, isFinite, Object, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8'), ctx);
  ctx.setup();
  sheets.workers.rows[1] = ['Mwende Musyoka', '0427', 'yes', '', ''];
  sheets.workers.rows[2] = ['Otieno', '1111', 'no', '', ''];
  sheets.workers.rows[3] = ['Kalondu', '2222', 'yes', '', ''];
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return { ctx, sheets, post, mail };
}

const sale = (id, extra = {}) => Object.assign({ id, date: '2026-10-05', type: 'sale', itemId: 'honey-1kg', qty: 2, from: 'nairobi', to: '', price: 1700, worker: 'Someone else', note: '', at: '2026-10-05T10:00:00Z' }, extra);

test('backend seed items and locations match the app seed', () => {
  const { sheets } = load();
  // JSON round trip: arrays made inside the vm have a different prototype.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const h = sheets.items.rows[0];
  const cols = ['itemId', 'name', 'category', 'unit', 'price', 'reorderLevel', 'places', 'kgEach'].map((c) => h.indexOf(c));
  assert.deepEqual(plain(sheets.items.rows.slice(1).map((r) => cols.map((i) => r[i]))), Seed.ITEMS.map((r) => (r.length > 7 ? r : r.concat(['']))));
  assert.deepEqual(plain(sheets.locations.rows.slice(1).map((r) => r.slice(0, 3))), Seed.LOCATIONS);
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
  assert.equal(row.itemName, 'Raw Organic Honey — 1kg Jar');

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

const kalondu = { name: 'Kalondu', pin: '2222' };
const mwende = { name: 'Mwende Musyoka', pin: '0427' };

// Workers for reminder tests: Kalondu at Kiunduani, Otieno at Nairobi (by name), Mwende the manager.
function withPlaces(env) {
  const w = env.sheets.workers;
  const col = (h) => w.rows[0].indexOf(h);
  const set = (row, h, v) => { w.rows[row][col(h)] = v; };
  set(1, 'email', 'mwende@example.com');
  set(3, 'email', 'kalondu@example.com'); set(3, 'place', 'kiunduani');
  w.rows[4] = ['Otieno Juma', '3333', 'yes', 'otieno@example.com', 'Nairobi Shop'];
  return env;
}
const nairobi = (iso) => new Date(new Date(iso + '+03:00').getTime());

test('evening: each shop with no sales today emails its own workers, nobody else', () => {
  const env = withPlaces(load());
  env.post({ action: 'save', ...mwende, movements: [sale('k1', { from: 'kiunduani', date: '2026-10-05' })] });
  const sent = env.ctx.reminders_(nairobi('2026-10-05T18:02:00'));
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ to: 'otieno@example.com', kind: 'sales', place: 'nairobi' }]);
  assert.match(env.mail[0].subject, /Nairobi Shop/);
  assert.match(env.mail[0].body, /Hello Otieno,/);
  assert.match(env.mail[0].body, /https:\/\/jstats\.github\.io\/Farm-to-shop-inventory\//);
});

test('morning on an ordinary day sends nothing; before any use nothing at all', () => {
  const env = withPlaces(load());
  assert.deepEqual(env.ctx.reminders_(nairobi('2026-10-31T18:00:00')).length, 0); // no movements yet
  env.post({ action: 'save', ...mwende, movements: [sale('k1', { from: 'kiunduani', date: '2026-10-05' })] });
  assert.equal(env.ctx.reminders_(nairobi('2026-10-05T09:01:00')).length, 0);
});

test('last day of the month: places not counted are reminded morning and evening', () => {
  const env = withPlaces(load());
  env.post({ action: 'save', ...mwende, movements: [
    sale('c1', { type: 'count', from: '', to: 'nairobi', date: '2026-10-30', price: 0 }),
    sale('c2', { type: 'count', from: '', to: 'kiunduani', date: '2026-09-30', price: 0 }), // last month: doesn't count
  ] });
  const morning = JSON.parse(JSON.stringify(env.ctx.reminders_(nairobi('2026-10-31T09:00:00'))));
  assert.deepEqual(morning.filter((x) => x.kind === 'count'), [{ to: 'kalondu@example.com', kind: 'count', place: 'kiunduani' }]);
  assert.equal(env.mail.some((m) => m.to === 'mwende@example.com'), false);
  assert.match(env.mail[0].subject, /October stock count at Kiunduani Shop/);
  // Not the last day → no count reminders.
  env.mail.length = 0;
  assert.equal(env.ctx.reminders_(nairobi('2026-10-30T09:00:00')).length, 0);
});

test('sign-in returns the worker\'s places by id or by name, several allowed', () => {
  const env = withPlaces(load());
  const w = env.sheets.workers;
  w.rows[5] = ['Felix', '5555', 'yes', 'felix@example.com', 'Farm, kiunduani; Nowhere'];
  const places = (name, pin) => JSON.parse(JSON.stringify(env.post({ action: 'data', name, pin }).places));
  assert.deepEqual(places('Kalondu', '2222'), ['kiunduani']);
  assert.deepEqual(places('Otieno Juma', '3333'), ['nairobi']);
  assert.deepEqual(places('Mwende Musyoka', '0427'), []);
  assert.deepEqual(places('Felix', '5555'), ['farm', 'kiunduani']);  // unknown "Nowhere" is skipped
});

test('a worker with several places is reminded for each of them', () => {
  const env = withPlaces(load());
  env.sheets.workers.rows[5] = ['Felix', '5555', 'yes', 'felix@example.com', 'Farm, Kiunduani Shop'];
  env.post({ action: 'save', ...mwende, movements: [sale('n1', { from: 'nairobi', date: '2026-10-31' })] });
  const sent = JSON.parse(JSON.stringify(env.ctx.reminders_(nairobi('2026-10-31T18:00:00'))));
  const felix = sent.filter((x) => x.to === 'felix@example.com').map((x) => x.kind + '@' + x.place).sort();
  assert.deepEqual(felix, ['count@farm', 'count@kiunduani', 'sales@kiunduani']);
  const kalondu = sent.filter((x) => x.to === 'kalondu@example.com').map((x) => x.kind + '@' + x.place).sort();
  assert.deepEqual(kalondu, ['count@kiunduani', 'sales@kiunduani']);
});

test('a sheet made by an earlier version (role and GPS columns) keeps working', () => {
  const { ctx, sheets, post } = load();
  sheets.workers.rows[0] = ['name', 'pin', 'active', 'role', 'email', 'place'];
  sheets.workers.rows[3] = ['Kalondu', '2222', 'yes', 'manager', 'k@example.com', 'Kiunduani Shop'];
  sheets.movements.rows[0] = sheets.movements.rows[0].concat(['lat', 'lon', 'accuracyM', 'distanceM']);
  ctx.setup();
  assert.equal(sheets.workers.rows[0].join(','), 'name,pin,active,role,email,place');
  const r = post({ action: 'save', ...kalondu, movements: [sale('x1', { lat: 1, lon: 2, acc: 3 })] });
  assert.deepEqual(r.saved, ['x1']);
  assert.equal(sheets.movements.rows[1].slice(-4).join(''), '');  // no position stored
  assert.deepEqual(JSON.parse(JSON.stringify(post({ action: 'data', ...kalondu }).places)), ['kiunduani']);
});

test('report periods: last Monday–Sunday, and the previous calendar month', () => {
  const { ctx } = load();
  const p = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(p(ctx.weekBefore_('2026-10-05')), { start: '2026-09-28', end: '2026-10-04' }); // a Monday
  assert.deepEqual(p(ctx.weekBefore_('2026-10-08')), { start: '2026-09-28', end: '2026-10-04' });
  assert.deepEqual(p(ctx.monthBefore_('2026-11-04')), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(p(ctx.monthBefore_('2027-01-04')), { start: '2026-12-01', end: '2026-12-31' });
});

test('the report goes to the script owner only, with the right numbers', () => {
  const env = withPlaces(load());
  const day = (d, id, extra) => sale(id, Object.assign({ date: d }, extra));
  env.post({ action: 'save', ...mwende, movements: [
    day('2026-10-01', 'r1', { type: 'restock', from: '', to: 'farm', qty: 50, price: 0 }),
    day('2026-10-01', 't1', { type: 'transfer', from: 'farm', to: 'kiunduani', qty: 20, price: 0 }),
    day('2026-10-02', 's1', { from: 'kiunduani', qty: 3, price: 1800 }),
    day('2026-10-03', 's2', { from: 'kiunduani', qty: 2, price: 1700 }),
    day('2026-10-03', 's3', { from: 'nairobi', qty: 1, price: 1800 }),
    day('2026-09-25', 's0', { from: 'kiunduani', qty: 1, price: 1800 }),   // previous week
    day('2026-10-30', 'c1', { type: 'count', from: '', to: 'kiunduani', qty: 12, price: 0 }), // records say 20 - 6 sold = 14
  ] });
  const r = env.ctx.report_('week', { start: '2026-09-28', end: '2026-10-04' }, '2026-10-05');
  assert.equal(r.total, 3 * 1800 + 2 * 1700 + 1800);
  assert.equal(r.prevTotal, 1800);
  assert.deepEqual(JSON.parse(JSON.stringify(r.byShop)), [
    { name: 'Kiunduani Shop', amount: 8800, units: 5, daysWithSales: 2 },
    { name: 'Nairobi Shop', amount: 1800, units: 1, daysWithSales: 1 },
  ]);
  assert.equal(r.restocked, 50);
  assert.equal(r.sent[0].units, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(r.workers)), [{ name: 'Mwende Musyoka', entries: 5 }]);

  const m = env.ctx.report_('month', { start: '2026-10-01', end: '2026-10-31' }, '2026-11-04');
  assert.deepEqual(JSON.parse(JSON.stringify(m.counts.map((c) => [c.name, c.done]))), [['Farm', false], ['Kiunduani Shop', true], ['Nairobi Shop', false]]);
  assert.equal(m.differences.length, 1);
  assert.equal(m.differences[0].delta, -2);
  assert.equal(m.missingValue, -2 * 1000);

  env.mail.length = 0;
  const res = env.ctx.sendReport_('month', { start: '2026-10-01', end: '2026-10-31' }, '2026-11-04');
  assert.equal(env.mail.length, 1);
  assert.equal(env.mail[0].to, 'owner@example.com');
  assert.match(res.subject, /monthly report: October 2026 · KSh 10,600/);
  assert.match(env.mail[0].htmlBody, /Missing stock value: KSh 2,000/);
  assert.match(env.mail[0].body, /NOT DONE/);
});

test('backend replay matches the app\'s stock maths', () => {
  const Stock = require('../docs/stock.js');
  const { ctx } = load();
  const moves = Seed.demoMovements('2026-10-05');
  moves.push({ id: 'cX', date: '2026-10-02', type: 'count', itemId: 'honey-1kg', qty: 5, from: '', to: 'nairobi', price: 0, worker: 'x', at: '2026-10-02T09:00:00Z' });
  const a = JSON.parse(JSON.stringify(ctx.replay_(moves).balance));
  assert.deepEqual(a, Stock.replay(moves).balance);
});

test('setup on an existing sheet adds the new items and fills places, keeping edits', () => {
  const { ctx, sheets } = load();
  const it = sheets.items;
  // Simulate the first version: no places column, only some items, one price changed by the owner.
  it.rows.splice(17);
  it.rows.forEach((r) => r.splice(7));
  it.rows[1][4] = 5555;
  ctx.setup();
  assert.equal(it.rows[0].join(','), 'itemId,name,category,unit,price,reorderLevel,active,places,kgEach');
  assert.equal(it.rows.find((r) => r[0] === 'honey-1kg')[8], 1);
  assert.equal(it.rows.length - 1, Seed.ITEMS.length);
  assert.equal(it.rows[1][4], 5555);  // setup never changes prices
  assert.equal(it.rows[1][7], 'Kiunduani Shop, Nairobi Shop');
  assert.equal(it.rows.find((r) => r[0] === 'dorper-sheep')[7], 'Farm');
  ctx.setup(); // again: nothing duplicated
  assert.equal(it.rows.length - 1, Seed.ITEMS.length);
});

test('applyWebsitePrices brings an old items tab up to the website list', () => {
  const { ctx, sheets, post } = load();
  const it = sheets.items;
  // The first version's tab: old names and prices, the bee veil, a reorder level the owner changed,
  // and an item the owner added by hand.
  it.rows.splice(1);
  it.rows.push(['ktbh-hive', 'KTBH — Kenya Top Bar Hive', 'Hives', 'hive', 4500, 7, 'yes', '']);
  it.rows.push(['honey-1kg', 'Raw Honey — 1kg Jar', 'Honey', 'jar', 1800, 10, 'yes', '']);
  it.rows.push(['bee-veil', 'Bee Veil (Round)', 'Protection', 'veil', 800, 5, 'yes', '']);
  it.rows.push(['wax-block', 'Beeswax block', 'Other', 'kg', 900, 0, 'yes', 'Farm']);
  const changed = ctx.applyWebsitePrices();
  const row = (id) => Object.fromEntries(it.rows[0].map((h, i) => [h, it.rows.find((r) => r[0] === id)[i]]));
  assert.equal(row('ktbh-hive').name, 'Kenya Top Bar Hive (KTBH)');
  assert.equal(row('ktbh-hive').price, 4000);
  assert.equal(row('ktbh-hive').reorderLevel, 7);           // owner's reorder level kept
  assert.equal(row('honey-1kg').price, 1000);
  assert.equal(row('honey-1kg').places, 'Farm, Kiunduani Shop, Nairobi Shop');
  assert.equal(row('bee-veil').active, 'no');
  assert.equal(row('wax-block').price, 900);                // own items untouched
  assert.equal(row('honey-300g').price, 300);               // new ones added
  assert.equal(it.rows.length - 1, Seed.ITEMS.length + 2);  // all listed items + veil + wax block
  assert.ok(changed.includes('swarm-catcher (new)'));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.applyWebsitePrices())), []); // second run: nothing to do
  // The veil no longer appears as active in the app.
  assert.equal(post({ action: 'data', ...mwende }).items.find((i) => i.id === 'bee-veil').active, false);
});

test('items come with their places; restocks keep own/bought, losses keep a reason', () => {
  const { post, sheets } = load();
  const data = post({ action: 'data', ...mwende });
  const sheep = data.items.find((i) => i.id === 'dorper-sheep');
  assert.deepEqual(JSON.parse(JSON.stringify(sheep.places)), ['farm']);
  assert.deepEqual(JSON.parse(JSON.stringify(data.items.find((i) => i.id === 'honey-1kg').places)), ['farm', 'kiunduani', 'nairobi']);
  const r = post({ action: 'save', ...mwende, movements: [
    sale('b1', { type: 'restock', itemId: 'honey-bulk', from: '', to: 'farm', qty: 30, price: 0, source: 'bought', supplier: 'Mutua', cost: 900 }),
    sale('o1', { type: 'restock', itemId: 'honey-bulk', from: '', to: 'farm', qty: 10, price: 0, source: 'own', supplier: 'ignored', cost: 5 }),
    sale('l1', { type: 'loss', itemId: 'rabbit', from: 'farm', qty: 2, price: 0, reason: 'died' }),
    sale('l2', { type: 'loss', itemId: 'matoke', from: 'farm', qty: 1, price: 0, reason: 'eaten by monkeys' }),
    sale('f1', { itemId: 'matoke', from: 'farm', qty: 5, price: 700 }),
  ] });
  assert.deepEqual(r.saved, ['b1', 'o1', 'l1', 'l2', 'f1']);
  const h = sheets.movements.rows[0];
  const row = (n) => Object.fromEntries(h.map((k, i) => [k, sheets.movements.rows[n][i]]));
  assert.equal(row(1).source, 'bought'); assert.equal(row(1).supplier, 'Mutua'); assert.equal(row(1).cost, 900);
  assert.equal(row(2).source, 'own'); assert.equal(row(2).supplier, ''); assert.equal(row(2).cost, '');
  assert.equal(row(3).reason, 'died');
  assert.equal(row(4).reason, 'other');
  const back = post({ action: 'data', ...mwende }).movements;
  assert.equal(back.find((m) => m.id === 'b1').cost, 900);
  assert.equal(back.find((m) => m.id === 'l1').reason, 'died');
});

test('report: own vs bought, losses, and market sales from the farm', () => {
  const env = withPlaces(load());
  env.post({ action: 'save', ...mwende, movements: [
    sale('b1', { date: '2026-09-29', type: 'restock', itemId: 'honey-bulk', from: '', to: 'farm', qty: 30, price: 0, source: 'bought', supplier: 'Mutua', cost: 900 }),
    sale('b2', { date: '2026-09-30', type: 'restock', itemId: 'honey-bulk', from: '', to: 'farm', qty: 10, price: 0, source: 'bought', supplier: 'Wambua', cost: 1000 }),
    sale('o1', { date: '2026-09-30', type: 'restock', itemId: 'honey-bulk', from: '', to: 'farm', qty: 25, price: 0, source: 'own' }),
    sale('l1', { date: '2026-10-01', type: 'loss', itemId: 'rabbit', from: 'farm', qty: 2, price: 0, reason: 'died' }),
    sale('f1', { date: '2026-10-02', itemId: 'matoke', from: 'farm', qty: 5, price: 700 }),
  ] });
  const r = env.ctx.report_('week', { start: '2026-09-28', end: '2026-10-04' }, '2026-10-05');
  assert.deepEqual(JSON.parse(JSON.stringify(r.incoming)), [
    { name: 'Raw honey — bulk (per kg)', unit: 'kg', category: 'Honey', own: 25, bought: 40, spent: 37000, suppliers: 'Mutua, Wambua' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(r.losses)), [{ name: 'Rabbit', unit: 'head', reason: 'died', qty: 2, value: 0 }]);
  assert.deepEqual(r.byShop.map((b) => b.name), ['Farm (market)', 'Kiunduani Shop', 'Nairobi Shop']);
  assert.equal(r.byShop[0].amount, 3500);
  const mail = env.ctx.reportEmail_(r);
  assert.match(mail.html, /Paid for bought stock: KSh 37,000/);
  assert.match(mail.html, /Losses recorded/);
  // Farm items never show as low in a shop.
  assert.equal(r.low.some((l) => /Matoke|Rabbit/.test(l.name)), false);
});

test('packing and delivery confirmations are stored and checked', () => {
  const { post, sheets } = load();
  const base = { date: '2026-10-05', price: 0, at: '2026-10-05T10:00:00Z' };
  const r = post({ action: 'save', ...mwende, movements: [
    { ...base, id: 'p1', type: 'pack', itemId: 'honey-bulk', qty: 20, from: 'farm', to: '', batch: 'P' },
    { ...base, id: 'p2', type: 'pack', itemId: 'honey-1kg', qty: 18, from: '', to: 'farm', batch: 'P' },
    { ...base, id: 'p3', type: 'pack', itemId: 'honey-1kg', qty: 1, from: 'farm', to: 'farm', batch: 'P' },   // both ends: refused
    { ...base, id: 'p4', type: 'pack', itemId: 'honey-1kg', qty: 1, from: '', to: 'farm' },                     // no batch: refused
    { ...base, id: 't1', type: 'transfer', itemId: 'honey-1kg', qty: 10, from: 'farm', to: 'kiunduani', batch: 'D' },
    { ...base, id: 'r1', type: 'receive', itemId: 'honey-1kg', qty: 9, from: 'farm', to: 'kiunduani', batch: 'D', sent: 10 },
    { ...base, id: 'r2', type: 'receive', itemId: 'honey-1kg', qty: 9, from: 'farm', to: 'kiunduani', batch: 'D' },  // no sent: refused
  ] });
  assert.deepEqual(r.saved, ['p1', 'p2', 't1', 'r1']);
  assert.deepEqual(r.rejected, ['p3', 'p4', 'r2']);
  const back = post({ action: 'data', ...mwende });
  assert.equal(back.movements.find((m) => m.id === 'r1').sent, 10);
  assert.equal(back.movements.find((m) => m.id === 'p2').batch, 'P');
  assert.equal(back.items.find((i) => i.id === 'honey-150g').kgEach, 0.15);
});

test('report: packing, honey flow in kg, short and unconfirmed deliveries', () => {
  const env = withPlaces(load());
  const m = (id, date, extra) => ({ id, date, price: 0, from: '', to: '', at: date + 'T10:00:00Z', ...extra });
  env.post({ action: 'save', ...mwende, movements: [
    m('h1', '2026-09-30', { type: 'restock', itemId: 'honey-bulk', qty: 100, to: 'farm', source: 'own' }),
    m('p1', '2026-10-01', { type: 'pack', itemId: 'honey-bulk', qty: 22, from: 'farm', batch: 'P' }),
    m('p2', '2026-10-01', { type: 'pack', itemId: 'honey-1kg', qty: 10, to: 'farm', batch: 'P' }),
    m('p3', '2026-10-01', { type: 'pack', itemId: 'honey-150g', qty: 60, to: 'farm', batch: 'P' }),   // 9 kg
    m('t1', '2026-10-02', { type: 'transfer', itemId: 'honey-1kg', qty: 8, from: 'farm', to: 'kiunduani', batch: 'D' }),
    m('r1', '2026-10-03', { type: 'receive', itemId: 'honey-1kg', qty: 7, from: 'farm', to: 'kiunduani', batch: 'D', sent: 8 }),
    m('t2', '2026-10-02', { type: 'transfer', itemId: 'honey-150g', qty: 20, from: 'farm', to: 'nairobi', batch: 'E' }),
    m('s1', '2026-10-03', { type: 'sale', itemId: 'honey-1kg', qty: 5, from: 'kiunduani', price: 1000 }),
  ] });
  const r = env.ctx.report_('week', { start: '2026-09-28', end: '2026-10-04' }, '2026-10-05');
  assert.deepEqual(JSON.parse(JSON.stringify(r.packing)), { times: 1, kgTaken: 22, kgPacked: 19 });
  const kiu = r.honeyFlow.find((x) => x.place === 'kiunduani' && x.itemId === 'honey-1kg');
  assert.deepEqual([kiu.start, kiu.in, kiu.out, kiu.sold, kiu.lost, kiu.countDiff, kiu.end], [0, 8, 0, 5, 1, 0, 2]);
  const bulk = r.honeyFlow.find((x) => x.itemId === 'honey-bulk');
  assert.deepEqual([bulk.start, bulk.in, bulk.out, bulk.end], [0, 100, 22, 78]);
  assert.equal(r.short.length, 1);
  assert.equal(r.short[0].sender + '→' + r.short[0].receiver, 'Mwende Musyoka→Mwende Musyoka');
  assert.deepEqual(JSON.parse(JSON.stringify(r.unconfirmed)), [{ date: '2026-10-02', from: 'Farm', to: 'Nairobi Shop', sender: 'Mwende Musyoka' }]);
  const mail = env.ctx.reportEmail_(r);
  assert.match(mail.html, /Left on equipment \/ wasted/);
  assert.match(mail.html, /Kiunduani Shop<\/td><\/tr>/);
  assert.match(mail.html, /Total kg/);
  assert.match(mail.html, /Deliveries that arrived short/);
  assert.match(mail.html, /Deliveries not confirmed yet/);
});

test('backend flow matches the app\'s flow on demo data', () => {
  const Stock = require('../docs/stock.js');
  const { ctx } = load();
  const moves = Seed.demoMovements('2026-10-20');
  const honey = Seed.items().filter((i) => i.category === 'Honey').map((i) => i.id);
  const places = ['farm', 'kiunduani', 'nairobi'];
  const norm = (rows) => JSON.parse(JSON.stringify(rows)).sort((a, b) => (a.itemId + a.place < b.itemId + b.place ? -1 : 1));
  for (const [a, b] of [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-20']]) {
    assert.deepEqual(norm(ctx.flow_(moves, honey, places, a, b)), norm(Stock.flow(moves, honey, places, a, b)));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.replay_(moves).balance)), Stock.replay(moves).balance);
  const kg = Object.fromEntries(Seed.items().map((i) => [i.id, i.kgEach]));
  for (const p of places) {
    const rows = Stock.flow(moves, honey, [p], '2026-10-01', '2026-10-20');
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.flowKg_(rows, (id) => kg[id]))), Stock.flowKg(rows, (id) => kg[id]));
  }
});
