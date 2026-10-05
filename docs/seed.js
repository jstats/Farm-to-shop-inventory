/**
 * Starting items and locations: the same rows backend/Code.gs puts in the sheet (a test keeps them equal).
 * Used only in demo mode (no apiUrl in config.js); with a live sheet the app reads these from the sheet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Seed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var ITEMS = [
    ['ktbh-hive', 'KTBH — Kenya Top Bar Hive', 'Hives', 'hive', 4500, 2],
    ['langstroth-hive', 'Langstroth Hive (10-frame)', 'Hives', 'hive', 7500, 2],
    ['log-hive', 'Traditional Log Hive', 'Hives', 'hive', 1800, 2],
    ['bee-suit', 'Full Bee Suit', 'Protection', 'suit', 3500, 3],
    ['bee-veil', 'Bee Veil (Round)', 'Protection', 'veil', 800, 5],
    ['bee-smoker', 'Bee Smoker', 'Tools', 'piece', 1200, 3],
    ['hive-tool', 'Hive Tool (J-Type)', 'Tools', 'piece', 350, 5],
    ['bee-brush', 'Bee Brush', 'Tools', 'piece', 300, 5],
    ['bee-attractant', 'Bee Attractant', 'Tools', 'bottle', 500, 5],
    ['foundation-sheet', 'Foundation Sheets', 'Tools', 'sheet', 150, 20],
    ['frame-feeder', 'Frame Feeder', 'Tools', 'piece', 400, 5],
    ['honey-extractor', 'Manual Honey Extractor', 'Processing', 'piece', 12000, 1],
    ['honey-strainer', 'Honey Strainer (Double)', 'Processing', 'piece', 900, 2],
    ['honey-150g', 'Raw Honey — 150g Jar', 'Honey', 'jar', 350, 20],
    ['honey-1kg', 'Raw Honey — 1kg Jar', 'Honey', 'jar', 1800, 10],
    ['honey-bulk', 'Bulk Honey (per kg)', 'Honey', 'kg', 1400, 20],
  ];
  var LOCATIONS = [
    ['farm', 'Farm', 'farm'],
    ['kiunduani', 'Kiunduani Shop', 'shop'],
    ['nairobi', 'Nairobi Shop', 'shop'],
  ];

  function items() {
    return ITEMS.map(function (r) {
      return { id: r[0], name: r[1], category: r[2], unit: r[3], price: r[4], reorderLevel: r[5], active: true };
    });
  }
  function locations() {
    return LOCATIONS.map(function (r) { return { id: r[0], name: r[1], role: r[2] }; });
  }

  /** Four months of made-up activity so the demo dashboard has something to show. Deterministic. */
  function demoMovements(today) {
    var seed = 7;
    function rnd(n) {
      seed = (seed * 9301 + 49297) % 233280;
      return Math.floor((seed / 233280) * n);
    }
    var its = items();
    var out = [];
    var n = 0;
    function mv(date, type, itemId, qty, from, to, price, worker) {
      n++;
      out.push({ id: 'demo-' + n, date: date, type: type, itemId: itemId, qty: qty, from: from || '', to: to || '',
                 price: price || 0, worker: worker, note: '', at: date + 'T08:' + String(n % 60).padStart(2, '0') + ':00.000Z' });
    }
    var end = new Date(today + 'T00:00:00Z');
    var start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 3, 1));
    for (var d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      var date = d.toISOString().slice(0, 10);
      var dom = d.getUTCDate();
      if (dom === 1) {
        its.forEach(function (it) {
          var f = it.category === 'Honey' ? 2 : 1;
          mv(date, 'restock', it.id, it.reorderLevel * 3 * f + rnd(5), '', 'farm', 0, 'Mwende');
          mv(date, 'transfer', it.id, it.reorderLevel * f + 2, 'farm', 'kiunduani', 0, 'Mwende');
          mv(date, 'transfer', it.id, it.reorderLevel * f + 1, 'farm', 'nairobi', 0, 'Mwende');
        });
      }
      if (d.getUTCDay() !== 0) {
        for (var k = 0; k < 3; k++) {
          var it = its[13 + rnd(3)];
          if (rnd(3) === 0) it = its[rnd(its.length)];
          var shop = rnd(5) < 3 ? 'kiunduani' : 'nairobi';
          mv(date, 'sale', it.id, 1 + rnd(it.unit === 'jar' ? 4 : 2), shop, '', it.price, shop === 'nairobi' ? 'Otieno' : 'Kalondu');
        }
      }
    }
    return out;
  }

  return { ITEMS: ITEMS, LOCATIONS: LOCATIONS, items: items, locations: locations, demoMovements: demoMovements };
});
