/**
 * Stock maths for the Beelove farm-to-shop app. No DOM, no network: works in the browser
 * (window.Stock) and in Node tests (require('./stock.js')).
 *
 * A movement is one row the workers capture:
 *   restock  – new stock arrives at a location. Adds qty to `to`. `source` is 'own' (harvest, workshop, born)
 *              or 'bought' (then `supplier` and `cost` = price paid per unit).
 *   transfer – stock moves between locations. Takes qty from `from`, adds it to `to`. All lines sent together
 *              share a `batch` id: that is one delivery.
 *   receive  – the place a delivery went to confirms it: `qty` actually arrived out of `sent` (same `batch`).
 *              Only the difference changes stock (qty − sent at `to`): a shortfall is lost on the way.
 *   sale     – stock sold. Takes qty from `from`. `price` is the unit price actually charged.
 *   loss     – stock spoilt, died, broken or stolen. Takes qty from `from`; `reason` says why.
 *   pack     – bulk honey packed into jars/bottles, one `batch` per packing: the bulk line has `from` (kg taken),
 *              each container line has `to` (how many filled).
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
  var TYPES = ['restock', 'transfer', 'receive', 'sale', 'loss', 'pack', 'count'];

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
      } else if (m.type === 'sale' || m.type === 'loss') add(m.itemId, m.from, -q);
      else if (m.type === 'pack') {
        if (m.from) add(m.itemId, m.from, -q);
        else add(m.itemId, m.to, q);
      } else if (m.type === 'receive') add(m.itemId, m.to, q - num(m.sent));
      else if (m.type === 'count') {
        var before = get(m.itemId, m.to);
        add(m.itemId, m.to, q - before);
        adjustments.push({ movement: m, before: before, after: q, delta: q - before });
        if (!lastCount[m.to] || m.date > lastCount[m.to]) lastCount[m.to] = m.date;
      }
    });
    return { balance: balance, adjustments: adjustments, lastCount: lastCount };
  }

  /** Is `item` kept at `locationId`? An item with no places listed is kept everywhere. */
  function kept(item, locationId) {
    return !item.places || !item.places.length || item.places.indexOf(locationId) >= 0;
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
      var lowAt = reorder > 0 ? shops.filter(function (s) { return kept(it, s) && per[s] <= reorder; }) : [];
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
    var cur = { sales: 0, units: 0, restocked: 0, own: 0, bought: 0, spent: 0, transferred: 0, lost: 0, lostValue: 0, adjusted: 0, entries: 0 };
    var prices = {};
    items.forEach(function (it) { prices[it.id] = num(it.price); });
    var lossMap = {};
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
      else if (m.type === 'loss') {
        cur.lost += num(m.qty);
        cur.lostValue += num(m.qty) * (prices[m.itemId] || 0);
        var lk = m.itemId + '|' + (m.reason || 'other');
        var l = lossMap[lk] || (lossMap[lk] = { itemId: m.itemId, reason: m.reason || 'other', qty: 0, value: 0 });
        l.qty += num(m.qty);
        l.value += num(m.qty) * (prices[m.itemId] || 0);
      }
      if (m.type === 'restock') {
        if (m.source === 'bought') {
          cur.bought += num(m.qty);
          cur.spent += num(m.qty) * num(m.cost);
        } else cur.own += num(m.qty);
      }
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
      losses: Object.keys(lossMap).map(function (k) { return lossMap[k]; }).sort(function (a, b) { return b.value - a.value || b.qty - a.qty; }),
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

  // ---------- honey flow and deliveries ----------

  /**
   * What happened to each item at each place between `start` and `end` (inclusive dates):
   *   start + in − out − sold − lost + countDiff = end
   * in   = restocked, packed into it, delivered to it    out  = sent away, used for packing
   * lost = recorded losses and shortfalls on deliveries   countDiff = what month-end counts corrected
   * Returns one row per item × place that had stock or movement: { itemId, place, start, in, out, sold, lost, countDiff, end,
   * packIn, packOut } (packIn/packOut = the part of in/out that was packing).
   */
  function flow(movements, itemIds, placeIds, start, end) {
    var opening = replay(movements.filter(function (m) { return m.date < start; })).balance;
    var upto = replay(movements.filter(function (m) { return m.date <= end; }));
    var rows = {};
    function row(item, place) {
      var k = item + '|' + place;
      if (!rows[k]) {
        var o = (opening[item] && opening[item][place]) || 0;
        rows[k] = { itemId: item, place: place, start: o, in: 0, out: 0, sold: 0, lost: 0, countDiff: 0, end: 0, packIn: 0, packOut: 0 };
      }
      return rows[k];
    }
    var want = function (item, place) { return place && itemIds.indexOf(item) >= 0 && placeIds.indexOf(place) >= 0; };
    movements.forEach(function (m) {
      if (m.date < start || m.date > end) return;
      var q = num(m.qty), i = m.itemId;
      if (m.type === 'restock' && want(i, m.to)) row(i, m.to).in += q;
      else if (m.type === 'transfer') {
        if (want(i, m.from)) row(i, m.from).out += q;
        if (want(i, m.to)) row(i, m.to).in += q;
      } else if (m.type === 'receive' && want(i, m.to)) row(i, m.to).lost += num(m.sent) - q;
      else if (m.type === 'sale' && want(i, m.from)) row(i, m.from).sold += q;
      else if (m.type === 'loss' && want(i, m.from)) row(i, m.from).lost += q;
      else if (m.type === 'pack') {
        if (m.from && want(i, m.from)) { row(i, m.from).out += q; row(i, m.from).packOut += q; }
        if (!m.from && want(i, m.to)) { row(i, m.to).in += q; row(i, m.to).packIn += q; }
      }
    });
    upto.adjustments.forEach(function (a) {
      var m = a.movement;
      if (m.date >= start && want(m.itemId, m.to)) row(m.itemId, m.to).countDiff += a.delta;
    });
    itemIds.forEach(function (i) {
      placeIds.forEach(function (p) {
        if ((opening[i] && opening[i][p]) || (upto.balance[i] && upto.balance[i][p])) row(i, p);
      });
    });
    return Object.keys(rows).map(function (k) {
      var r = rows[k];
      r.end = r.start + r.in - r.out - r.sold - r.lost + r.countDiff;
      return r;
    });
  }

  /**
   * Flow rows of one place added up in kg (`kgEach(itemId)` gives kg per unit). Packing only turns bulk honey into
   * jars, so it is left out of In and Out; the honey it did not put in jars (left on equipment) counts as Lost.
   */
  function flowKg(rows, kgEach) {
    var t = { start: 0, in: 0, out: 0, sold: 0, lost: 0, countDiff: 0, end: 0 };
    rows.forEach(function (r) {
      var k = kgEach(r.itemId) || 0;
      t.start += r.start * k;
      t.in += (r.in - r.packIn) * k;
      t.out += (r.out - r.packOut) * k;
      t.sold += r.sold * k;
      t.lost += (r.lost + r.packOut) * k - r.packIn * k;
      t.countDiff += r.countDiff * k;
      t.end += r.end * k;
    });
    Object.keys(t).forEach(function (f) { t[f] = Math.round(t[f] * 100) / 100; });
    return t;
  }

  /**
   * Deliveries not yet confirmed: transfers sent in the last `days` days to one of `placeIds` (all places if empty),
   * grouped by batch, with no receive for that batch. Newest first.
   */
  function pendingDeliveries(movements, placeIds, today, days) {
    var p = today.split('-').map(Number);
    var since = new Date(Date.UTC(p[0], p[1] - 1, p[2] - (days || 14))).toISOString().slice(0, 10);
    var done = {};
    movements.forEach(function (m) { if (m.type === 'receive' && m.batch) done[m.batch + '|' + m.to] = true; });
    var groups = {};
    movements.forEach(function (m) {
      if (m.type !== 'transfer' || !m.batch || m.date < since) return;
      if (placeIds.length && placeIds.indexOf(m.to) < 0) return;
      var k = m.batch + '|' + m.to;
      if (done[k]) return;
      var g = groups[k] || (groups[k] = { batch: m.batch, from: m.from, to: m.to, date: m.date, worker: m.worker, lines: [] });
      g.lines.push({ itemId: m.itemId, qty: num(m.qty) });
    });
    return Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
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

  return { TYPES: TYPES, kept: kept, replay: replay, flow: flow, flowKg: flowKg, pendingDeliveries: pendingDeliveries, summarise: summarise, onHand: onHand, monthsBack: monthsBack, sortMovements: sortMovements,
           soldOn: soldOn, daysLeftInMonth: daysLeftInMonth, countWindow: countWindow, countedSince: countedSince };
});
