const test = require('node:test');
const assert = require('node:assert/strict');
const Stock = require('../docs/stock.js');

const items = [
  { id: 'jar', name: 'Honey jar', unit: 'jar', price: 350, reorderLevel: 5 },
  { id: 'hive', name: 'Hive', unit: 'hive', price: 4500, reorderLevel: 0 },
];
const locations = [
  { id: 'farm', name: 'Farm', role: 'farm' },
  { id: 'kiunduani', name: 'Kiunduani Shop', role: 'shop' },
  { id: 'nairobi', name: 'Nairobi Shop', role: 'shop' },
];
let n = 0;
const mv = (date, type, itemId, qty, from = '', to = '', price = 0, at = '') =>
  ({ id: 'm' + ++n, date, type, itemId, qty, from, to, price, worker: 'A', at: at || date + 'T09:00:00Z' });

test('restock, transfer and sale move stock between places', () => {
  const r = Stock.replay([
    mv('2026-09-01', 'restock', 'jar', 50, '', 'farm'),
    mv('2026-09-02', 'transfer', 'jar', 20, 'farm', 'kiunduani'),
    mv('2026-09-02', 'transfer', 'jar', 10, 'farm', 'nairobi'),
    mv('2026-09-03', 'sale', 'jar', 3, 'kiunduani', '', 350),
  ]);
  assert.deepEqual(r.balance.jar, { farm: 20, kiunduani: 17, nairobi: 10 });
});

test('a count sets the balance and records the difference', () => {
  const r = Stock.replay([
    mv('2026-09-01', 'restock', 'jar', 10, '', 'kiunduani'),
    mv('2026-09-30', 'count', 'jar', 8, '', 'kiunduani'),
    mv('2026-10-01', 'sale', 'jar', 2, 'kiunduani', '', 350),
  ]);
  assert.equal(r.balance.jar.kiunduani, 6);
  assert.equal(r.adjustments.length, 1);
  assert.equal(r.adjustments[0].delta, -2);
  assert.equal(r.lastCount.kiunduani, '2026-09-30');
});

test('movements entered late are replayed in date order', () => {
  // The count was synced first but a sale earlier that day was captured later.
  const r = Stock.replay([
    mv('2026-09-01', 'restock', 'jar', 10, '', 'kiunduani'),
    mv('2026-09-30', 'count', 'jar', 7, '', 'kiunduani', 0, '2026-09-30T17:00:00Z'),
    mv('2026-09-30', 'sale', 'jar', 3, 'kiunduani', '', 350, '2026-09-30T10:00:00Z'),
  ]);
  assert.equal(r.balance.jar.kiunduani, 7);
  assert.equal(r.adjustments[0].delta, 0);
});

test('summary: sales by month and by shop, low stock per shop, counts due', () => {
  const s = Stock.summarise({
    items, locations, movements: [
      mv('2026-08-01', 'restock', 'jar', 100, '', 'farm'),
      mv('2026-08-01', 'transfer', 'jar', 30, 'farm', 'kiunduani'),
      mv('2026-08-01', 'transfer', 'jar', 8, 'farm', 'nairobi'),
      mv('2026-08-10', 'sale', 'jar', 2, 'kiunduani', '', 350),
      mv('2026-10-02', 'sale', 'jar', 4, 'nairobi', '', 300),
      mv('2026-10-03', 'sale', 'jar', 1, 'kiunduani', '', 350),
      mv('2026-10-03', 'count', 'jar', 60, '', 'farm'),
    ],
  }, '2026-10-05');
  assert.equal(s.month.sales, 4 * 300 + 350);
  assert.equal(s.month.units, 5);
  assert.equal(s.month.adjusted, -2);
  const aug = s.salesByMonth.find((m) => m.month === '2026-08');
  assert.equal(aug.amount, 700);
  assert.equal(s.salesByMonth.length, 12);
  assert.equal(s.salesByMonth[11].month, '2026-10');
  assert.deepEqual(s.salesByShop.map((b) => [b.location, b.amount]), [['kiunduani', 350], ['nairobi', 1200]]);
  // Nairobi has 4 jars left, reorder level 5 → low; Kiunduani has 27 → fine. The hive has no reorder level.
  assert.deepEqual(s.low.map((l) => [l.item.id, l.location, l.qty]), [['jar', 'nairobi', 4]]);
  assert.deepEqual(s.countDue, ['kiunduani', 'nairobi']);
  assert.equal(s.top[0].itemId, 'jar');
  assert.equal(s.stockValue, (60 + 27 + 4) * 350);
});

test('monthsBack crosses the year boundary', () => {
  assert.deepEqual(Stock.monthsBack('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
});

test('negative stock is flagged, not hidden', () => {
  const s = Stock.summarise({ items, locations, movements: [mv('2026-10-01', 'sale', 'hive', 1, 'kiunduani', '', 4500)] }, '2026-10-05');
  const hive = s.stock.find((x) => x.item.id === 'hive');
  assert.equal(hive.per.kiunduani, -1);
  assert.equal(hive.negative, true);
});

test('reminder helpers: sales today and days left in the month', () => {
  const ms = [mv('2026-10-05', 'sale', 'jar', 1, 'kiunduani', '', 350)];
  assert.equal(Stock.soldOn(ms, 'kiunduani', '2026-10-05'), true);
  assert.equal(Stock.soldOn(ms, 'nairobi', '2026-10-05'), false);
  assert.equal(Stock.soldOn(ms, 'kiunduani', '2026-10-06'), false);
  assert.equal(Stock.daysLeftInMonth('2026-10-31'), 0);
  assert.equal(Stock.daysLeftInMonth('2026-10-29'), 2);
  assert.equal(Stock.daysLeftInMonth('2028-02-28'), 1); // leap year
});

test('countWindow: last 3 days of a month, then the first 3 of the next (late)', () => {
  assert.equal(Stock.countWindow('2026-10-20'), null);
  assert.deepEqual(Stock.countWindow('2026-10-29'), { month: '2026-10', start: '2026-10-29', late: false });
  assert.deepEqual(Stock.countWindow('2026-10-31'), { month: '2026-10', start: '2026-10-29', late: false });
  assert.deepEqual(Stock.countWindow('2026-11-02'), { month: '2026-10', start: '2026-10-29', late: true });
  assert.deepEqual(Stock.countWindow('2027-01-03'), { month: '2026-12', start: '2026-12-29', late: true });
  assert.equal(Stock.countWindow('2026-11-04'), null);
  assert.deepEqual(Stock.countWindow('2028-02-27'), { month: '2028-02', start: '2028-02-27', late: false });
  const ms = [mv('2026-10-03', 'count', 'jar', 5, '', 'kiunduani'), mv('2026-10-30', 'count', 'jar', 5, '', 'nairobi')];
  // An early-month count does not cover the month-end count.
  assert.equal(Stock.countedSince(ms, 'kiunduani', '2026-10-29'), false);
  assert.equal(Stock.countedSince(ms, 'nairobi', '2026-10-29'), true);
});

test('packing turns kg of bulk honey into jars', () => {
  const r = Stock.replay([
    mv('2026-10-01', 'restock', 'bulk', 50, '', 'farm'),
    Object.assign(mv('2026-10-02', 'pack', 'bulk', 20, 'farm', ''), { batch: 'p1' }),
    Object.assign(mv('2026-10-02', 'pack', 'jar1kg', 10, '', 'farm'), { batch: 'p1' }),
    Object.assign(mv('2026-10-02', 'pack', 'jar150', 60, '', 'farm'), { batch: 'p1' }),
  ]);
  assert.equal(r.balance.bulk.farm, 30);
  assert.equal(r.balance.jar1kg.farm, 10);
  assert.equal(r.balance.jar150.farm, 60);
});

test('a delivery confirmed short takes the shortfall off the shop', () => {
  const t = (id, qty) => Object.assign(mv('2026-10-03', 'transfer', id, qty, 'farm', 'kiunduani'), { batch: 'd1' });
  const ms = [mv('2026-10-01', 'restock', 'jar', 100, '', 'farm'), t('jar', 50), t('hive', 2)];
  assert.equal(Stock.pendingDeliveries(ms, ['kiunduani'], '2026-10-04').length, 1);
  assert.equal(Stock.pendingDeliveries(ms, ['nairobi'], '2026-10-04').length, 0);
  assert.equal(Stock.pendingDeliveries(ms, [], '2026-10-30').length, 0); // older than 14 days
  ms.push(Object.assign(mv('2026-10-04', 'receive', 'jar', 48, 'farm', 'kiunduani'), { batch: 'd1', sent: 50 }));
  ms.push(Object.assign(mv('2026-10-04', 'receive', 'hive', 2, 'farm', 'kiunduani'), { batch: 'd1', sent: 2 }));
  assert.equal(Stock.pendingDeliveries(ms, ['kiunduani'], '2026-10-04').length, 0);
  const b = Stock.replay(ms).balance;
  assert.equal(b.jar.farm, 50);
  assert.equal(b.jar.kiunduani, 48);
});

test('flow: start + in − out − sold − lost + count difference = end, and matches the balance', () => {
  const ms = [
    mv('2026-09-20', 'restock', 'jar', 40, '', 'farm'),
    mv('2026-09-21', 'transfer', 'jar', 12, 'farm', 'kiunduani'),
    Object.assign(mv('2026-10-02', 'pack', 'jar', 60, '', 'farm'), { batch: 'p' }),
    Object.assign(mv('2026-10-03', 'transfer', 'jar', 50, 'farm', 'kiunduani'), { batch: 'd' }),
    Object.assign(mv('2026-10-04', 'receive', 'jar', 49, 'farm', 'kiunduani'), { batch: 'd', sent: 50 }),
    mv('2026-10-10', 'sale', 'jar', 45, 'kiunduani', '', 1000),
    mv('2026-10-11', 'loss', 'jar', 1, 'kiunduani'),
    mv('2026-10-30', 'count', 'jar', 12, '', 'kiunduani'),
    mv('2026-11-02', 'sale', 'jar', 5, 'kiunduani', '', 1000), // after the month: not in October's flow
  ];
  const rows = Stock.flow(ms, ['jar'], ['farm', 'kiunduani'], '2026-10-01', '2026-10-31');
  const k = rows.find((r) => r.place === 'kiunduani');
  assert.deepEqual(k, { itemId: 'jar', place: 'kiunduani', start: 12, in: 50, out: 0, sold: 45, lost: 2, countDiff: -3, end: 12, packIn: 0, packOut: 0 });
  const f = rows.find((r) => r.place === 'farm');
  assert.deepEqual(f, { itemId: 'jar', place: 'farm', start: 28, in: 60, out: 50, sold: 0, lost: 0, countDiff: 0, end: 38, packIn: 60, packOut: 0 });
  const bal = Stock.replay(ms.filter((m) => m.date <= '2026-10-31')).balance.jar;
  assert.equal(k.end, bal.kiunduani);
  assert.equal(f.end, bal.farm);
});

test('flowKg: packing is a change of container; what stays on the equipment is lost', () => {
  const ms = [
    mv('2026-10-01', 'restock', 'bulk', 50, '', 'farm'),
    Object.assign(mv('2026-10-02', 'pack', 'bulk', 17, 'farm', ''), { batch: 'p' }),
    Object.assign(mv('2026-10-02', 'pack', 'j1', 10, '', 'farm'), { batch: 'p' }),
    Object.assign(mv('2026-10-02', 'pack', 'j150', 40, '', 'farm'), { batch: 'p' }),
    mv('2026-10-03', 'transfer', 'j1', 8, 'farm', 'kiunduani'),
  ];
  const kg = { bulk: 1, j1: 1, j150: 0.15 };
  const rows = Stock.flow(ms, ['bulk', 'j1', 'j150'], ['farm'], '2026-10-01', '2026-10-31');
  const t = Stock.flowKg(rows, (id) => kg[id]);
  assert.deepEqual(t, { start: 0, in: 50, out: 8, sold: 0, lost: 1, countDiff: 0, end: 41 });
  assert.equal(t.start + t.in - t.out - t.sold - t.lost + t.countDiff, t.end);
});

test('app version and offline cache version match', () => {
  const fs = require('node:fs');
  const app = fs.readFileSync(__dirname + '/../docs/app.js', 'utf8').match(/var APP_VERSION = (\d+);/)[1];
  const sw = fs.readFileSync(__dirname + '/../docs/sw.js', 'utf8').match(/var VERSION = 'beelove-stock-v(\d+)';/)[1];
  assert.equal(app, sw);
});
