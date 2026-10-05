/**
 * Stock maths for the Beelove farm-to-shop app. No DOM, no network: works in the browser
 * (window.Stock) and in Node tests (require('./stock.js')).
 *
 * A movement is one row the workers capture:
 *   restock  – new stock arrives at a location (harvest, workshop, supplier). Adds qty to `to`.
 *   transfer – stock moves between locations. Takes qty from `from`, adds it to `to`.
 *   sale     – stock sold. Takes qty from `from`. `price` is the unit price actually charged.
 *   count    – the monthly physical count at `to`. `qty` is what is ON THE SHELF; the balance is set to it
 *              and the difference is kept as an adjustment (loss, damage, mistakes).
 *
 * Movements are replayed in date order (then capture time), so a count entered late still lands in
 * the right place and later movements build on it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Stock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var TYPES = ['restock', 'transfer', 'sale', 'count'];

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function month(date) {
    return String(date || '').slice(0, 7);
  }

  function sortMovements(movements) {
    return movements.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var at = String(a.at || ''), bt = String(b.at || '');
      return at < bt ? -1 : at > bt ? 1 : 0;
    });
  }

  /**
   * Replays movements. Returns
   *   balance[itemId][locationId] = units on hand
   *   adjustments: [{ movement, before, after, delta }] for every count
   *   lastCount[locationId] = date of the most recent count there
   */
  function replay(movements) {
    var balance = {};
    var adjustments = [];
    var lastCount = {};
    function get(item, loc) {
      return (balance[item] && balance[item][loc]) || 0;
    }
    function add(item, loc, q) {
      if (!loc) return;
      if (!balance[item]) balance[item] = {};
      balance[item][loc] = get(item, loc) + q;
    }
    sortMovements(movements).forEach(function (m) {
      var q = num(m.qty);
      if (m.type === 'restock') add(m.itemId, m.to, q);
      else if (m.type === 'transfer') {
        add(m.itemId, m.from, -q);
        add(m.itemId, m.to, q);
      } else if (m.type === 'sale') add(m.itemId, m.from, -q);
      else if (m.type === 'count') {
        var before = get(m.itemId, m.to);
        add(m.itemId, m.to, q - before);
        adjustments.push({ movement: m, before: before, after: q, delta: q - before });
        if (!lastCount[m.to] || m.date > lastCount[m.to]) lastCount[m.to] = m.date;
      }
    });
    return { balance: balance, adjustments: adjustments, lastCount: lastCount };
  }

  function saleAmount(m) {
    return num(m.qty) * num(m.price);
  }

  /** The last `n` months ending at `endMonth` ('YYYY-MM'), oldest first. */
  function monthsBack(endMonth, n) {
    var y = Number(endMonth.slice(0, 4)), mo = Number(endMonth.slice(5, 7));
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(Date.UTC(y, mo - 1 - i, 1));
      out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'));
    }
    return out;
  }

  /**
   * Everything the dashboard shows.
   * data = { items, locations, movements }, today = 'YYYY-MM-DD'.
   * Shops are the locations with role 'shop'. Each item's reorderLevel is checked in every shop.
   */
  function summarise(data, today) {
    var items = data.items || [];
    var locations = data.locations || [];
    var movements = (data.movements || []).filter(function (m) {
      return TYPES.indexOf(m.type) >= 0;
    });
    var r = replay(movements);
    var shops = locations.filter(function (l) { return l.role === 'shop'; }).map(function (l) { return l.id; });
    var thisMonth = month(today);

    var stock = items.map(function (it) {
      var per = {};
      var total = 0;
      locations.forEach(function (l) {
        var q = (r.balance[it.id] && r.balance[it.id][l.id]) || 0;
        per[l.id] = q;
        total += q;
      });
      var reorder = num(it.reorderLevel);
      var lowAt = reorder > 0 ? shops.filter(function (s) { return per[s] <= reorder; }) : [];
      return {
        item: it,
        per: per,
        total: total,
        value: total * num(it.price),
        lowAt: lowAt,
        negative: locations.some(function (l) { return per[l.id] < 0; }),
      };
    });
    var low = [];
    stock.forEach(function (x) {
      x.lowAt.forEach(function (s) { low.push({ item: x.item, location: s, qty: x.per[s] }); });
    });

    var months = monthsBack(thisMonth, 12);
    var salesByMonth = {};
    months.forEach(function (k) { salesByMonth[k] = { month: k, amount: 0, units: 0 }; });
    var cur = { sales: 0, units: 0, restocked: 0, transferred: 0, adjusted: 0, entries: 0 };
    var byShop = {};
    shops.forEach(function (s) { byShop[s] = { location: s, amount: 0, units: 0 }; });
    var topMap = {};
    movements.forEach(function (m) {
      var k = month(m.date);
      if (m.type === 'sale' && salesByMonth[k]) {
        salesByMonth[k].amount += saleAmount(m);
        salesByMonth[k].units += num(m.qty);
      }
      if (k !== thisMonth) return;
      cur.entries++;
      if (m.type === 'sale') {
        cur.sales += saleAmount(m);
        cur.units += num(m.qty);
        var b = byShop[m.from] || (byShop[m.from] = { location: m.from, amount: 0, units: 0 });
        b.amount += saleAmount(m);
        b.units += num(m.qty);
        var t = topMap[m.itemId] || (topMap[m.itemId] = { itemId: m.itemId, units: 0, amount: 0 });
        t.units += num(m.qty);
        t.amount += saleAmount(m);
      } else if (m.type === 'restock') cur.restocked += num(m.qty);
      else if (m.type === 'transfer') cur.transferred += num(m.qty);
    });
    r.adjustments.forEach(function (a) {
      if (month(a.movement.date) === thisMonth) cur.adjusted += a.delta;
    });

    var top = Object.keys(topMap).map(function (k) { return topMap[k]; })
      .sort(function (a, b) { return b.amount - a.amount || b.units - a.units; });

    var recent = sortMovements(movements).reverse().slice(0, 20);
    var countDue = locations.filter(function (l) {
      return month(r.lastCount[l.id]) !== thisMonth;
    }).map(function (l) { return l.id; });

    return {
      stock: stock,
      stockValue: stock.reduce(function (s, x) { return s + Math.max(0, x.value); }, 0),
      low: low,
      month: cur,
      salesByShop: Object.keys(byShop).map(function (k) { return byShop[k]; }),
      salesByMonth: months.map(function (k) { return salesByMonth[k]; }),
      top: top,
      recent: recent,
      adjustments: r.adjustments,
      lastCount: r.lastCount,
      countDue: countDue,
      shops: shops,
    };
  }

  /** Units of `itemId` at `locationId` right now: used to warn before a sale or transfer. */
  function onHand(movements, itemId, locationId) {
    var b = replay(movements).balance;
    return (b[itemId] && b[itemId][locationId]) || 0;
  }

  // ---------- reminders ----------
  /** True if any sale was recorded at `locationId` on `date`. */
  function soldOn(movements, locationId, date) {
    return movements.some(function (m) { return m.type === 'sale' && m.from === locationId && m.date === date; });
  }

  /** Days after `date` until the month ends: 0 on the last day. */
  function daysLeftInMonth(date) {
    var p = date.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate() - p[2];
  }

  /**
   * The month-end count window that `date` falls in: the last 3 days of a month and the first 3 of the next.
   * Returns { month: 'YYYY-MM' being counted, start: first day of the window, late: true after the month ended },
   * or null outside the window. A count dated on or after `start` covers that month.
   * backend/Code.gs uses the same window for its emails.
   */
  function countWindow(date) {
    var p = date.split('-').map(Number);
    function win(y, m) { // m is 1-12
      var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      var ym = y + '-' + String(m).padStart(2, '0');
      return { month: ym, start: ym + '-' + String(last - 2).padStart(2, '0') };
    }
    if (daysLeftInMonth(date) <= 2) { var w = win(p[0], p[1]); w.late = false; return w; }
    if (p[2] <= 3) {
      var prev = p[1] === 1 ? win(p[0] - 1, 12) : win(p[0], p[1] - 1);
      prev.late = true;
      return prev;
    }
    return null;
  }

  /** True if `locationId` has a count dated on or after `start`. */
  function countedSince(movements, locationId, start) {
    return movements.some(function (m) { return m.type === 'count' && m.to === locationId && m.date >= start; });
  }

  return { TYPES: TYPES, replay: replay, summarise: summarise, onHand: onHand, monthsBack: monthsBack, sortMovements: sortMovements,
           soldOn: soldOn, daysLeftInMonth: daysLeftInMonth, countWindow: countWindow, countedSince: countedSince };
});
