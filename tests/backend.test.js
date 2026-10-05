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
    MailApp: { sendEmail: (to, subject, body) => mail.push({ to, subject, body }) },
    Math, Date, JSON, String, Number, isFinite, Object, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8'), ctx);
  ctx.setup();
  sheets.workers.rows[1] = ['Mwende Musyoka', '0427', 'yes', 'manager'];
  sheets.workers.rows[2] = ['Otieno', '1111', 'no', ''];
  sheets.workers.rows[3] = ['Kalondu', '2222', 'yes', ''];
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return { ctx, sheets, post, mail };
}

const sale = (id, extra = {}) => Object.assign({ id, date: '2026-10-05', type: 'sale', itemId: 'honey-1kg', qty: 2, from: 'nairobi', to: '', price: 1700, worker: 'Someone else', note: '', at: '2026-10-05T10:00:00Z' }, extra);

test('backend seed items and locations match the app seed', () => {
  const { sheets } = load();
  // JSON round trip: arrays made inside the vm have a different prototype.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(sheets.items.rows.slice(1).map((r) => r.slice(0, 6))), Seed.ITEMS);
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

// Kiunduani market, roughly. 0.001 degrees of latitude is about 111 m.
const KIU = { lat: -1.7896, lon: 37.6231 };
const kalondu = { name: 'Kalondu', pin: '2222' };
const mwende = { name: 'Mwende Musyoka', pin: '0427' };

test('a manager sets a place point; other workers cannot', () => {
  const { post, sheets } = load();
  assert.equal(post({ action: 'setPoint', ...kalondu, locationId: 'kiunduani', ...KIU, acc: 20 }).error, 'not_manager');
  assert.equal(post({ action: 'setPoint', ...mwende, locationId: 'kiunduani', ...KIU, acc: 300 }).error, 'weak_gps');
  assert.equal(post({ action: 'setPoint', ...mwende, locationId: 'mombasa', ...KIU, acc: 20 }).error, 'unknown_place');
  assert.equal(post({ action: 'setPoint', ...mwende, locationId: 'kiunduani', ...KIU, acc: 20 }).ok, true);
  const loc = post({ action: 'data', ...kalondu }).locations.find((l) => l.id === 'kiunduani');
  assert.equal(loc.lat, KIU.lat);
  assert.equal(loc.lon, KIU.lon);
  assert.equal(post({ action: 'data', ...mwende }).role, 'manager');
  assert.equal(sheets.locations.rows[0].join(','), 'locationId,name,role,lat,lon,radiusM');
});

test('entries for a place with a point must come from near it', () => {
  const { post, sheets } = load();
  post({ action: 'setPoint', ...mwende, locationId: 'kiunduani', ...KIU, acc: 20 });
  const at = (id, lat, lon, acc, extra = {}) => sale(id, Object.assign({ from: 'kiunduani', lat, lon, acc }, extra));
  const r = post({ action: 'save', ...kalondu, movements: [
    at('near', KIU.lat + 0.001, KIU.lon, 15),        // ~111 m: inside 200 m
    at('far', KIU.lat + 0.01, KIU.lon, 15),          // ~1.1 km
    at('weak', KIU.lat, KIU.lon, 900),               // fix too poor to trust
    sale('nogps', { from: 'kiunduani' }),            // no position at all
    at('slack', KIU.lat + 0.0025, KIU.lon, 80),      // ~278 m, but within 200 + 80 accuracy
    sale('nairobi-anywhere', { from: 'nairobi' }),   // Nairobi has no point yet: allowed
  ] });
  assert.deepEqual(r.saved, ['near', 'slack', 'nairobi-anywhere']);
  assert.deepEqual(r.rejected, ['far', 'weak', 'nogps']);
  assert.deepEqual(JSON.parse(JSON.stringify(r.reasons)), { far: 'too_far', weak: 'weak_gps', nogps: 'no_gps' });
  const head = sheets.movements.rows[0];
  const near = Object.fromEntries(head.map((h, i) => [h, sheets.movements.rows[1][i]]));
  assert.equal(near.distanceM, 111);
  assert.equal(near.accuracyM, 15);
});

test('a counted place is checked at "to", a transfer at "from"', () => {
  const { post } = load();
  post({ action: 'setPoint', ...mwende, locationId: 'farm', ...KIU, acc: 20 });
  const far = { lat: KIU.lat + 0.05, lon: KIU.lon, acc: 10 };
  const r = post({ action: 'save', ...kalondu, movements: [
    sale('t1', Object.assign({ type: 'transfer', from: 'farm', to: 'nairobi', price: 0 }, far)),   // sent from far away
    sale('t2', Object.assign({ type: 'transfer', from: 'nairobi', to: 'farm', price: 0 }, far)),   // received at the farm: checked at Nairobi (no point)
    sale('c1', Object.assign({ type: 'count', from: '', to: 'farm', price: 0 }, far)),
  ] });
  assert.deepEqual(r.rejected, ['t1', 'c1']);
  assert.deepEqual(r.saved, ['t2']);
});

test('an older sheet gets the new columns without losing rows', () => {
  const { ctx, sheets, post } = load();
  // Simulate the first version: 3-column workers and no location columns on movements.
  sheets.workers.rows.forEach((r) => r.splice(3));
  sheets.workers.rows[0] = ['name', 'pin', 'active'];
  sheets.movements.rows.splice(0, sheets.movements.rows.length, ['movementId', 'date', 'type', 'itemId', 'itemName', 'qty', 'unit', 'from', 'to', 'price', 'amount', 'worker', 'note', 'at', 'receivedAt']);
  assert.deepEqual(post({ action: 'save', ...kalondu, movements: [sale('old1')] }).saved, ['old1']);
  ctx.setup();
  assert.equal(sheets.workers.rows[0].join(','), 'name,pin,active,role,email,place');
  assert.equal(sheets.movements.rows[0].slice(-4).join(','), 'lat,lon,accuracyM,distanceM');
  assert.equal(post({ action: 'data', ...kalondu }).movements[0].id, 'old1');
});

// Workers for reminder tests: Kalondu at Kiunduani, Otieno at Nairobi (by name), Mwende the manager.
function withPlaces(env) {
  const w = env.sheets.workers;
  const col = (h) => w.rows[0].indexOf(h);
  const set = (row, h, v) => { w.rows[row][col(h)] = v; };
  set(1, 'email', 'mwende@example.com');
  set(3, 'email', 'kalondu@example.com'); set(3, 'place', 'kiunduani');
  w.rows[4] = ['Otieno Juma', '3333', 'yes', '', 'otieno@example.com', 'Nairobi Shop'];
  return env;
}
const nairobi = (iso) => new Date(new Date(iso + '+03:00').getTime());

test('evening: each shop with no sales today emails its own workers; the manager gets a summary', () => {
  const env = withPlaces(load());
  env.post({ action: 'save', ...mwende, movements: [sale('k1', { from: 'kiunduani', date: '2026-10-05' })] });
  const sent = env.ctx.reminders_(nairobi('2026-10-05T18:02:00'));
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { to: 'otieno@example.com', kind: 'sales', place: 'nairobi' },
    { to: 'mwende@example.com', kind: 'summary' },
  ]);
  assert.match(env.mail[0].subject, /Nairobi Shop/);
  assert.match(env.mail[0].body, /Hello Otieno,/);
  assert.match(env.mail[0].body, /https:\/\/jstats\.github\.io\/Farm-to-shop-inventory\//);
  assert.match(env.mail[1].body, /Nairobi Shop: no sales recorded today \(reminded Otieno Juma\)/);
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
  const summary = env.mail.find((m) => m.to === 'mwende@example.com').body;
  assert.match(summary, /Farm: October count not done \(nobody reminded: no worker with an email has this place\)/);
  assert.match(env.mail[0].subject, /October stock count at Kiunduani Shop/);
  // Not the last day → no count reminders.
  env.mail.length = 0;
  assert.equal(env.ctx.reminders_(nairobi('2026-10-30T09:00:00')).length, 0);
});

test('sign-in returns the worker\'s places by id or by name, several allowed', () => {
  const env = withPlaces(load());
  const w = env.sheets.workers;
  w.rows[5] = ['Felix', '5555', 'yes', '', 'felix@example.com', 'Farm, kiunduani; Nowhere'];
  const places = (name, pin) => JSON.parse(JSON.stringify(env.post({ action: 'data', name, pin }).places));
  assert.deepEqual(places('Kalondu', '2222'), ['kiunduani']);
  assert.deepEqual(places('Otieno Juma', '3333'), ['nairobi']);
  assert.deepEqual(places('Mwende Musyoka', '0427'), []);
  assert.deepEqual(places('Felix', '5555'), ['farm', 'kiunduani']);  // unknown "Nowhere" is skipped
});

test('a worker with several places is reminded for each of them', () => {
  const env = withPlaces(load());
  env.sheets.workers.rows[5] = ['Felix', '5555', 'yes', '', 'felix@example.com', 'Farm, Kiunduani Shop'];
  env.post({ action: 'save', ...mwende, movements: [sale('n1', { from: 'nairobi', date: '2026-10-31' })] });
  const sent = JSON.parse(JSON.stringify(env.ctx.reminders_(nairobi('2026-10-31T18:00:00'))));
  const felix = sent.filter((x) => x.to === 'felix@example.com').map((x) => x.kind + '@' + x.place).sort();
  assert.deepEqual(felix, ['count@farm', 'count@kiunduani', 'sales@kiunduani']);
  const kalondu = sent.filter((x) => x.to === 'kalondu@example.com').map((x) => x.kind + '@' + x.place).sort();
  assert.deepEqual(kalondu, ['count@kiunduani', 'sales@kiunduani']);
});
