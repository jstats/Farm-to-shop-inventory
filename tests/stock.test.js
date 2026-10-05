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
