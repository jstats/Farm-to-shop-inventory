/**
 * Starting items and locations: the same rows backend/Code.gs puts in the sheet (a test keeps them equal).
 * Used only in demo mode (no apiUrl in config.js); with a live sheet the app reads these from the sheet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Seed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // [itemId, name, category, unit, price, reorderLevel, places]. places = where it is kept ('' = everywhere).
  var SHOPS = 'Kiunduani Shop, Nairobi Shop';
  var ALL = 'Farm, Kiunduani Shop, Nairobi Shop';
  var ITEMS = [
    ['ktbh-hive', 'KTBH — Kenya Top Bar Hive', 'Hives', 'hive', 4500, 2, SHOPS],
    ['langstroth-hive', 'Langstroth Hive (10-frame)', 'Hives', 'hive', 7500, 2, SHOPS],
    ['log-hive', 'Traditional Log Hive', 'Hives', 'hive', 1800, 2, SHOPS],
    ['bee-suit', 'Full Bee Suit', 'Protection', 'suit', 3500, 3, SHOPS],
    ['bee-veil', 'Bee Veil (Round)', 'Protection', 'veil', 800, 5, SHOPS],
    ['bee-smoker', 'Bee Smoker', 'Tools', 'piece', 1200, 3, SHOPS],
    ['hive-tool', 'Hive Tool (J-Type)', 'Tools', 'piece', 350, 5, SHOPS],
    ['bee-brush', 'Bee Brush', 'Tools', 'piece', 300, 5, SHOPS],
    ['bee-attractant', 'Bee Attractant', 'Tools', 'bottle', 500, 5, SHOPS],
    ['foundation-sheet', 'Foundation Sheets', 'Tools', 'sheet', 150, 20, SHOPS],
    ['frame-feeder', 'Frame Feeder', 'Tools', 'piece', 400, 5, SHOPS],
    ['honey-extractor', 'Manual Honey Extractor', 'Processing', 'piece', 12000, 1, SHOPS],
    ['honey-strainer', 'Honey Strainer (Double)', 'Processing', 'piece', 900, 2, SHOPS],
    ['honey-150g', 'Raw Honey — 150g Jar', 'Honey', 'jar', 350, 20, ALL],
    ['honey-1kg', 'Raw Honey — 1kg Jar', 'Honey', 'jar', 1800, 10, ALL],
    ['honey-bulk', 'Bulk Honey (per kg)', 'Honey', 'kg', 1400, 20, ALL],
    ['matoke', 'Matoke', 'Farm produce', 'bunch', 0, 0, 'Farm'],
    ['ripe-bananas', 'Ripe bananas', 'Farm produce', 'bunch', 0, 0, 'Farm'],
    ['rabbit', 'Rabbit', 'Livestock', 'head', 0, 0, 'Farm'],
    ['dorper-sheep', 'Dorper sheep', 'Livestock', 'head', 0, 0, 'Farm'],
    ['tilapia-fingerling', 'Tilapia fingerlings', 'Fish', 'piece', 0, 0, 'Farm'],
    ['catfish-fingerling', 'Catfish fingerlings', 'Fish', 'piece', 0, 0, 'Farm'],
    ['tilapia', 'Tilapia (table size)', 'Fish', 'kg', 0, 0, 'Farm'],
    ['catfish', 'Catfish (table size)', 'Fish', 'kg', 0, 0, 'Farm'],
  ];
  var LOCATIONS = [
    ['farm', 'Farm', 'farm'],
    ['kiunduani', 'Kiunduani Shop', 'shop'],
    ['nairobi', 'Nairobi Shop', 'shop'],
  ];

  /** Place names → ids, the way the sheet's backend resolves them. */
  function placeIds(text) {
    return String(text || '').split(/[,;]/).map(function (p) { return p.trim().toLowerCase(); }).filter(Boolean)
      .map(function (p) { var l = LOCATIONS.filter(function (r) { return r[0] === p || r[1].toLowerCase() === p; })[0]; return l && l[0]; })
      .filter(Boolean);
  }

  function items() {
    return ITEMS.map(function (r) {
      return { id: r[0], name: r[1], category: r[2], unit: r[3], price: r[4], reorderLevel: r[5], active: true, places: placeIds(r[6]) };
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
        mv(date, 'restock', 'honey-bulk', 20 + rnd(10), '', 'farm', 0, 'Daniel');
        out[out.length - 1].source = 'bought';
        out[out.length - 1].supplier = 'Mutua (Kibwezi)';
        out[out.length - 1].cost = 900;
        mv(date, 'restock', 'matoke', 32 + rnd(10), '', 'farm', 0, 'Daniel');
        its.filter(function (it) { return it.places.length === 3 || it.places.indexOf('farm') < 0; }).forEach(function (it) {
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
          if (it.places.indexOf('kiunduani') < 0) it = its[13];
          var shop = rnd(5) < 3 ? 'kiunduani' : 'nairobi';
          mv(date, 'sale', it.id, 1 + rnd(it.unit === 'jar' ? 4 : 2), shop, '', it.price, shop === 'nairobi' ? 'Otieno' : 'Kalondu');
        }
      }
      if (d.getUTCDay() === 3) mv(date, 'sale', 'matoke', 4 + rnd(4), 'farm', '', 700, 'Daniel');
      if (dom === 15) {
        mv(date, 'loss', 'matoke', 2 + rnd(3), 'farm', '', 0, 'Daniel');
        out[out.length - 1].reason = 'spoilt';
      }
    }
    return out;
  }

  return { ITEMS: ITEMS, LOCATIONS: LOCATIONS, items: items, locations: locations, demoMovements: demoMovements };
});
