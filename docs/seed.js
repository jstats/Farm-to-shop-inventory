/**
 * Starting items and locations: the same rows backend/Code.gs puts in the sheet (a test keeps them equal).
 * Used only in demo mode (no apiUrl in config.js); with a live sheet the app reads these from the sheet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Seed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // [itemId, name, category, unit, price, reorderLevel, places, kgEach, container]. places = where it is kept ('' = everywhere);
  // kgEach = kg of honey in one unit (honey only), so packing can be checked by weight;
  // container = the empty jar/bottle (and later lids, labels: comma-separated itemIds) one filled unit uses up.
  // From beelovefarm.org/shop/beekeeping (October 2026), plus farm produce, livestock and fish (prices to be set).
  var SHOPS = 'Kiunduani Shop, Nairobi Shop';
  var ALL = 'Farm, Kiunduani Shop, Nairobi Shop';
  var ITEMS = [
    ['ktbh-hive', 'Kenya Top Bar Hive (KTBH)', 'Hives', 'hive', 4000, 2, SHOPS],
    ['langstroth-hive', 'Langstroth Hive (10-frame)', 'Hives', 'hive', 5000, 2, SHOPS],
    ['modern-log-hive', 'Modern Log Hive', 'Hives', 'hive', 3000, 2, SHOPS],
    ['log-hive', 'Traditional Log Hive', 'Hives', 'hive', 2500, 2, SHOPS],
    ['swarm-catcher', 'Swarm Catcher Box', 'Hives', 'box', 2200, 2, SHOPS],
    ['bee-suit', 'Full Bee Suit', 'Protection', 'suit', 4000, 3, SHOPS],
    ['bee-gloves', 'Beekeeping Gloves (Long Cuff)', 'Protection', 'pair', 950, 3, SHOPS],
    ['bee-smoker', 'Bee Smoker', 'Tools', 'piece', 3500, 2, SHOPS],
    ['hive-tool', 'Hive Tool (J-Type)', 'Tools', 'piece', 700, 3, SHOPS],
    ['frame-grip', 'Frame Grip / Lifter', 'Tools', 'piece', 700, 2, SHOPS],
    ['bee-brush', 'Bee Brush', 'Tools', 'piece', 700, 3, SHOPS],
    ['bee-attractant', 'Bee Attractant (10ml)', 'Tools', 'bottle', 500, 5, SHOPS],
    ['queen-excluder', 'Queen Excluder', 'Tools', 'piece', 800, 2, SHOPS],
    ['propolis-mat', 'Propolis Collector Mat', 'Tools', 'piece', 800, 2, SHOPS],
    ['foundation-sheet', 'Foundation Sheets', 'Tools', 'sheet', 180, 20, SHOPS],
    ['frame-feeder', 'Bee Feeder', 'Tools', 'piece', 800, 3, SHOPS],
    ['honey-extractor', 'Manual Honey Extractor (3/6 frame)', 'Processing', 'piece', 45000, 1, SHOPS],
    ['refractometer', 'Honey Refractometer (ATC)', 'Processing', 'piece', 10000, 1, SHOPS],
    ['honey-strainer', 'Double Stainless Sieve', 'Processing', 'set', 4000, 1, SHOPS],
    ['cone-strainer', 'Cone Honey Strainer', 'Processing', 'piece', 900, 2, SHOPS],
    ['uncapping-fork', 'Uncapping Fork', 'Processing', 'piece', 700, 2, SHOPS],
    ['honey-bucket', 'Food-Grade Honey Bucket (20L)', 'Processing', 'bucket', 1200, 2, SHOPS],
    ['honey-150g', 'Raw Organic Honey — 150g Jar', 'Honey', 'jar', 150, 20, ALL, 0.15, 'empty-jar-150g'],
    ['honey-300g', 'Raw Organic Honey — 300g Squeeze Bottle', 'Honey', 'bottle', 300, 10, ALL, 0.3, 'empty-bottle-300g'],
    ['honey-500g', 'Raw Organic Honey — 500g Squeeze Bottle', 'Honey', 'bottle', 500, 10, ALL, 0.5, 'empty-bottle-500g'],
    ['honey-1kg', 'Raw Organic Honey — 1kg Jar', 'Honey', 'jar', 1000, 10, ALL, 1, 'empty-jar-1kg'],
    ['honey-bulk', 'Raw honey — bulk (per kg)', 'Honey', 'kg', 0, 0, 'Farm', 1],
    ['empty-jar-150g', 'Empty 150g jar', 'Packaging', 'jar', 0, 50, 'Farm'],
    ['empty-bottle-300g', 'Empty 300g squeeze bottle', 'Packaging', 'bottle', 0, 30, 'Farm'],
    ['empty-bottle-500g', 'Empty 500g squeeze bottle', 'Packaging', 'bottle', 0, 30, 'Farm'],
    ['empty-jar-1kg', 'Empty 1kg jar', 'Packaging', 'jar', 0, 30, 'Farm'],
    ['matoke', 'Matoke', 'Farm produce', 'bunch', 0, 0, 'Farm'],
    ['ripe-bananas', 'Ripe bananas', 'Farm produce', 'bunch', 0, 0, 'Farm'],
    ['rabbit', 'Rabbit', 'Livestock', 'head', 0, 0, 'Farm'],
    ['dorper-sheep', 'Dorper sheep', 'Livestock', 'head', 0, 0, 'Farm'],
    ['tilapia-fingerling', 'Tilapia fingerlings', 'Fish', 'piece', 0, 0, 'Farm'],
    ['catfish-fingerling', 'Catfish fingerlings', 'Fish', 'piece', 0, 0, 'Farm'],
    ['tilapia', 'Tilapia (table size)', 'Fish', 'kg', 0, 0, 'Farm'],
    ['catfish', 'Catfish (table size)', 'Fish', 'kg', 0, 0, 'Farm'],
  ];
  // No longer sold (not on the website): kept in old sheets for history, switched off.
  var RETIRED = ['bee-veil'];
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

  function containerIds(text) {
    return String(text || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function items() {
    return ITEMS.map(function (r) {
      return { id: r[0], name: r[1], category: r[2], unit: r[3], price: r[4], reorderLevel: r[5], active: true, places: placeIds(r[6]),
               kgEach: r[7] || 0, container: containerIds(r[8]) };
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
    var byId = function (id) { return its.filter(function (x) { return x.id === id; })[0]; };
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
      var d2 = d;
      var date = d.toISOString().slice(0, 10);
      var dom = d.getUTCDate();
      if (dom === 1) {
        mv(date, 'restock', 'honey-bulk', 20 + rnd(10), '', 'farm', 0, 'Daniel');
        out[out.length - 1].source = 'bought';
        out[out.length - 1].supplier = 'Mutua (Kibwezi)';
        out[out.length - 1].cost = 900;
        mv(date, 'restock', 'matoke', 32 + rnd(10), '', 'farm', 0, 'Daniel');
        // Shop equipment arrives at the shops (workshop or supplier); honey is packed at the farm and sent out.
        its.filter(function (it) { return it.places.indexOf('farm') < 0; }).forEach(function (it) {
          mv(date, 'restock', it.id, it.reorderLevel * 2 + 2 + rnd(3), '', 'kiunduani', 0, 'Daniel');
          mv(date, 'restock', it.id, it.reorderLevel * 2 + 1 + rnd(3), '', 'nairobi', 0, 'Otieno');
        });
        mv(date, 'restock', 'honey-bulk', 160 + rnd(20), '', 'farm', 0, 'Daniel');
        out[out.length - 1].source = 'own';
        // Pack bulk honey into jars and bottles, then deliver to both shops (confirmed the next day).
        var jars = its.filter(function (it) { return it.category === 'Honey' && it.places.length === 3; });
        var batch = 'demo-pack-' + date;
        var packedKg = 0;
        jars.forEach(function (it) {
          var n2 = it.reorderLevel * 8 + rnd(5);
          packedKg += n2 * it.kgEach;
          // Buy the empty containers, then the packing uses them up.
          mv(date, 'restock', it.container[0], n2 + 10 + rnd(10), '', 'farm', 0, 'Daniel');
          mv(date, 'pack', it.id, n2, '', 'farm', 0, 'Daniel');
          out[out.length - 1].batch = batch;
          mv(date, 'pack', it.container[0], n2, 'farm', '', 0, 'Daniel');
          out[out.length - 1].batch = batch;
        });
        mv(date, 'pack', 'honey-bulk', Math.round(packedKg + 2), 'farm', '', 0, 'Daniel');
        out[out.length - 1].batch = batch;
        [['kiunduani', 4, 4, 'Kalondu'], ['nairobi', 3, 4, 'Otieno']].forEach(function (d) {
          var b = 'demo-send-' + d[0] + '-' + date;
          var next = new Date(Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate() + 1)).toISOString().slice(0, 10);
          jars.forEach(function (it, j) {
            var q = it.reorderLevel * d[1] + d[2];
            mv(date, 'transfer', it.id, q, 'farm', d[0], 0, 'Daniel');
            out[out.length - 1].batch = b;
            if (next > today) return; // not confirmed yet: shows as a delivery waiting
            var got = d[0] === 'kiunduani' && j === 0 ? q - 2 : q; // two jars short on one delivery
            mv(next, 'receive', it.id, got, 'farm', d[0], 0, d[3]);
            out[out.length - 1].batch = b;
            out[out.length - 1].sent = q;
          });
        });
      }
      if (d.getUTCDay() !== 0) {
        for (var k = 0; k < 3; k++) {
          var it = byId(['honey-150g', 'honey-300g', 'honey-500g', 'honey-1kg'][rnd(4)]);
          if (rnd(3) === 0) it = its[rnd(its.length)];
          if (it.places.indexOf('kiunduani') < 0) it = byId('honey-1kg');
          var shop = rnd(5) < 3 ? 'kiunduani' : 'nairobi';
          mv(date, 'sale', it.id, 1 + rnd(it.category === 'Honey' ? 4 : 2), shop, '', it.price, shop === 'nairobi' ? 'Otieno' : 'Kalondu');
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

  return { ITEMS: ITEMS, RETIRED: RETIRED, LOCATIONS: LOCATIONS, items: items, locations: locations, demoMovements: demoMovements };
});
